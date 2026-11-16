/**
 * Test runner without a new dependency: esbuild (already a devDependency) bundles the TypeScript
 * test + the modules under test into one ESM file, and Node's built-in `node --test` runs it.
 * The bundle lives under node_modules/.cache, which is already gitignored.
 */
import { spawnSync } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "node_modules", ".cache", "plugin-hub-tests")
const entries = [
  "downloads.test.ts",
  "self-update.test.ts",
  "rules.test.ts",
  "official-parse.test.ts",
  "official-cli.test.ts",
  "lifecycle-safety.test.ts",
  "config-safety.test.ts",
  "feedback.test.ts",
  "release-guard.test.ts",
]

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: entries.map((entry) => join(root, "tests", entry)),
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "warning",
})

const outputs = entries.map((entry) => join(outDir, entry.replace(/\.ts$/, ".mjs")))
const result = spawnSync(process.execPath, ["--test", ...outputs], { stdio: "inherit", cwd: root })
if (result.error) throw result.error
process.exit(result.status ?? 1)
