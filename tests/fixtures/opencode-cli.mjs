/**
 * A stand-in for the real `opencode` binary, used by the tests.
 *
 * It behaves the way the official CLI behaves on the points the hub depends on — all of them
 * verified against opencode 2.0.27 (see docs/real-cli-probe.md):
 * - `plugin add` appends the target to the config, refuses an exact duplicate with
 *   `is already configured`, and exits 0 even when it did nothing;
 * - `plugin add` accepts an exact version and unpacks the package into the **shared**
 *   `XDG_CACHE_HOME` cache while writing the config to whatever `XDG_CONFIG_HOME` names;
 * - `plugin add` does **not** validate the plugin entrypoint (adding a non-plugin succeeds);
 * - `plugin remove` deletes one entry, and answers `is not configured` (exit 0) when the spec is
 *   not there — the case the hub must not report as success;
 * - `plugin update` either bumps a version or prints `No plugin updates available`;
 * - `plugin list` / `plugin check` print tables that come from the test through env vars, so the
 *   parsers are exercised against realistic column layouts;
 * - every invocation is appended to `FAKE_CLI_LOG` so a test can assert the exact argv.
 *
 * ## Failure injection
 *
 * `FAKE_CLI_FAIL` is a comma-separated list of *phases*, so each failure path can be simulated
 * separately instead of one global "fail" switch:
 *
 * | value | what it does |
 * |---|---|
 * | `add` | download fails: exit 1, nothing written, no cache |
 * | `add-config-write` | package unpacked, but the config write fails: exit 1 |
 * | `add-nomaterialize` | config written, exit 0, nothing unpacked into the cache |
 * | `add-entry` | package unpacked but its declared entry file is missing |
 * | `add-exit-zero-error` | config written, prints `Error:` on stderr, still exits 0 |
 * | `add-garbage` | exit 0 with unrelated output, config untouched |
 * | `remove` | exit 1 |
 * | `update` | exit 1 |
 * | `all` | every command fails |
 *
 * `FAKE_CLI_HANG` is a comma-separated list of phases that never answer (`add`, `remove`, `list`),
 * so the hub's own deadline is what ends them.
 *
 * `FAKE_CLI_MODE` is the older single switch still used by a few tests: `fail`, `timeout`,
 * `check-fail`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLI_MODE ?? "ok"
const log = process.env.FAKE_CLI_LOG ?? ""
const phases = (process.env.FAKE_CLI_FAIL ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item.length > 0)
const hang = (process.env.FAKE_CLI_HANG ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item.length > 0)

if (log) {
  appendFileSync(log, `${argv.join(" ")}\n`, "utf8")
}

function failing(phase) {
  if (mode === "fail") return phase !== "list" && phase !== "check"
  return phases.includes(phase) || phases.includes("all")
}

function hanging(phase) {
  return mode === "timeout" || hang.includes(phase) || hang.includes("all")
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exitCode = code
}

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg ? join(xdg, "opencode") : join(process.env.HOME ?? ".", ".config", "opencode")
  return base
}

function configFile() {
  // The real CLI uses opencode.jsonc when that is what exists; mirror that so a test that writes
  // a jsonc file sees its comments preserved.
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(configDir(), name)
    if (existsSync(path)) return path
  }
  return join(configDir(), "opencode.json")
}

function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf8"))
    if (!Array.isArray(raw.plugins)) raw.plugins = []
    return raw
  } catch {
    return { plugins: [] }
  }
}

function writeConfig(config) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function specOf(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object") {
    const pkg = entry.package
    if (typeof pkg === "string") return pkg
  }
  return ""
}

function nameOf(spec) {
  const scoped = spec.startsWith("@")
  const at = spec.indexOf("@", scoped ? 1 : 0)
  return at > 0 ? spec.slice(0, at) : spec
}

function rangeOf(spec) {
  const scoped = spec.startsWith("@")
  const at = spec.indexOf("@", scoped ? 1 : 0)
  return at > 0 ? spec.slice(at + 1) : "latest"
}

function table(name) {
  const body = process.env[name]
  if (!body) return ""
  return body.replace(/\\n/g, "\n")
}

/**
 * Unpacks a fake package into the shared cache, in the same layout the real CLI uses:
 * `<XDG_CACHE_HOME>/opencode/npm/<name>@<range>/<timestamp>/node_modules/<name>/package.json`.
 */
function materialize(spec) {
  const name = nameOf(spec)
  const range = rangeOf(spec)
  const cache = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache")
  const dir = join(cache, "opencode", "npm", `${name}@${range}`, String(Date.now()), "node_modules", name)
  mkdirSync(join(dir, "dist"), { recursive: true })
  const entryMissing = failing("add-entry")
  const manifest = {
    name,
    version: range === "latest" ? "1.0.0" : range,
    main: entryMissing ? "./dist/missing.js" : "./dist/index.js",
    description: `${name} fixture`,
  }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  if (!entryMissing) writeFileSync(join(dir, "dist", "index.js"), "export default {}\n", "utf8")
  return dir
}

const command = argv[0] ?? ""
/** The phase name a failure/hang is keyed on: `add`, `remove`, `update`, `list`, `check`, `reload`. */
const phase = command === "plugin" ? argv[1] ?? "" : command

if (hanging(phase)) {
  // Never exit: the hub has to enforce its own deadline.
  setInterval(() => undefined, 1_000)
} else if (command === "reload") {
  if (failing("reload")) fail("Error: reload failed")
  else process.stdout.write("Configuration reloaded\n")
} else if (command === "plugin" && argv[1] === "list") {
  if (failing("list")) fail("Error: cannot list plugins")
  else process.stdout.write(table("FAKE_CLI_LIST") || "No plugins found\n")
} else if (command === "plugin" && argv[1] === "check") {
  if (failing("check")) {
    process.stderr.write("Error: cannot check plugins\n")
    process.exitCode = 1
  } else {
    process.stdout.write(table("FAKE_CLI_CHECK"))
    process.exitCode = mode === "check-fail" ? 1 : 0
  }
} else if (command === "plugin" && argv[1] === "add") {
  const target = argv[2] ?? ""
  const name = nameOf(target)
  const config = readConfig()
  const duplicate = config.plugins.some((entry) => specOf(entry) === target)

  if (failing("add")) {
    process.stderr.write(
      `NpmInstallFailedError: \n    at catch (/$bunfs/root/chunk-x.js:3:6394)\n  [cause]: ${name}: No matching version found for ${target}.\n`,
    )
    process.exitCode = 1
  } else if (failing("add-garbage")) {
    process.stdout.write("Fetching package metadata…\n")
  } else if (duplicate) {
    process.stdout.write(`Plugin "${name}" is already configured in ${configFile()}\n`)
  } else if (failing("add-config-write")) {
    // The package downloaded fine; the config write is what failed.
    materialize(target)
    process.stderr.write(`Error: EACCES: permission denied, open '${configFile()}'\n`)
    process.exitCode = 1
  } else {
    if (!failing("add-nomaterialize") && !target.startsWith("/") && !target.startsWith(".")) {
      materialize(target)
    }
    config.plugins.push(target)
    writeConfig(config)
    // Simulates another process (the user's editor, another window, a config sync tool) editing
    // the real config while this command is running: the hub must notice and refuse to apply a
    // plan derived from the old contents.
    if (failing("external-edit")) {
      const real = process.env.FAKE_CLI_REAL_CONFIG
      if (real) {
        try {
          const other = JSON.parse(readFileSync(real, "utf8"))
          other.plugins = (other.plugins ?? []).filter((entry) => nameOf(specOf(entry)) !== name)
          writeFileSync(real, `${JSON.stringify(other, null, 2)}\n`, "utf8")
        } catch {
          // the test asserts on the hub's reaction, not on this branch
        }
      }
    }
    if (failing("add-exit-zero-error")) {
      process.stderr.write("Error: plugin host rejected the new entry\n")
    } else {
      process.stdout.write(`Plugin "${target}" installed and added to ${configFile()}\n`)
    }
  }
} else if (command === "plugin" && argv[1] === "remove") {
  const target = argv[2] ?? ""
  if (failing("remove")) {
    process.stderr.write(`Error: could not remove ${target}\n`)
    process.exitCode = 1
  } else {
    const config = readConfig()
    const index = config.plugins.findIndex((entry) => specOf(entry) === target)
    if (index < 0) {
      process.stdout.write(`Plugin "${target}" is not configured\n`)
    } else {
      config.plugins.splice(index, 1)
      writeConfig(config)
      process.stdout.write(`Plugin "${target}" removed from ${configFile()}\n`)
    }
  }
} else if (command === "plugin" && argv[1] === "update") {
  const target = argv[2] ?? ""
  const next = process.env.FAKE_CLI_UPDATE_TO ?? ""
  if (failing("update")) {
    process.stderr.write(`Error: Plugin is not configured: ${target}\n`)
    process.exitCode = 1
  } else if (!next) {
    process.stdout.write("No plugin updates available\n")
  } else {
    const config = readConfig()
    const index = config.plugins.findIndex((entry) => specOf(entry) === target)
    if (index < 0) {
      process.stdout.write(`Plugin "${target}" is not configured\n`)
    } else {
      const spec = `${nameOf(target)}@${next}`
      materialize(spec)
      config.plugins[index] = spec
      writeConfig(config)
      process.stdout.write(`Updated ${nameOf(target)} to ${next}\n`)
    }
  }
} else {
  process.stderr.write(`unknown command: ${argv.join(" ")}\n`)
  process.exitCode = 1
}
