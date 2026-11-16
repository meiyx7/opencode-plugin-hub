/**
 * A stand-in for the real `opencode` binary, used by the tests.
 *
 * It behaves the way the official CLI behaves on the points the hub depends on:
 * - `plugin add` appends the target to the global config, refuses a duplicate with
 *   `is already configured`, and exits 0 even when it did nothing;
 * - `plugin remove` deletes one entry, and answers `is not configured` (exit 0) when the spec is
 *   not there — the case the hub must not report as success;
 * - `plugin update` either bumps a version or prints `No plugin updates available`;
 * - `plugin list` / `plugin check` print tables that come from the test through env vars, so the
 *   parsers are exercised against realistic column layouts;
 * - every invocation is appended to `FAKE_CLI_LOG` so a test can assert the exact argv.
 *
 * Failure modes are selected with `FAKE_CLI_MODE`: `fail` (exit 1 with an Effect-style trace),
 * `timeout` (never answers), `not-configured`.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLI_MODE ?? "ok"
const log = process.env.FAKE_CLI_LOG ?? ""

if (log) {
  appendFileSync(log, `${argv.join(" ")}\n`, "utf8")
}

function configPath() {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg ? join(xdg, "opencode") : join(process.env.HOME ?? ".", ".config", "opencode")
  return join(base, "opencode.json")
}

function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"))
    if (!Array.isArray(raw.plugins)) raw.plugins = []
    return raw
  } catch {
    return { plugins: [] }
  }
}

function writeConfig(config) {
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8")
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

function table(name) {
  const body = process.env[name]
  if (!body) return ""
  return body.replace(/\\n/g, "\n")
}

if (mode === "timeout") {
  // Never exit: the hub has to enforce its own deadline.
  setInterval(() => undefined, 1_000)
} else if (argv[0] === "reload") {
  process.stdout.write("Configuration reloaded\n")
} else if (argv[0] === "plugin" && argv[1] === "list") {
  process.stdout.write(table("FAKE_CLI_LIST", "") || "No plugins found\n")
} else if (argv[0] === "plugin" && argv[1] === "check") {
  const text = table("FAKE_CLI_CHECK", "")
  process.stdout.write(text)
  process.exitCode = mode === "check-fail" ? 1 : 0
} else if (argv[0] === "plugin" && argv[1] === "add") {
  const target = argv[2] ?? ""
  if (mode === "fail") {
    process.stderr.write(
      `NpmInstallFailedError: \n    at catch (/$bunfs/root/chunk-x.js:3:6394)\n  [cause]: ${nameOf(target)}: No matching version found for ${target}.\n`,
    )
    process.exitCode = 1
  } else {
    const config = readConfig()
    const name = nameOf(target)
    const duplicate = config.plugins.some((entry) => specOf(entry) === target || specOf(entry) === name)
    if (duplicate) {
      process.stdout.write(`Plugin "${name}" is already configured in ${configPath()}\n`)
    } else {
      config.plugins.push(target)
      writeConfig(config)
      process.stdout.write(`Plugin "${target}" installed and added to ${configPath()}\n`)
    }
  }
} else if (argv[0] === "plugin" && argv[1] === "remove") {
  const target = argv[2] ?? ""
  if (mode === "fail") {
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
      process.stdout.write(`Plugin "${target}" removed from ${configPath()}\n`)
    }
  }
} else if (argv[0] === "plugin" && argv[1] === "update") {
  const target = argv[2] ?? ""
  const next = process.env.FAKE_CLI_UPDATE_TO ?? ""
  if (mode === "fail") {
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
      config.plugins[index] = `${nameOf(target)}@${next}`
      writeConfig(config)
      process.stdout.write(`Updated ${nameOf(target)} to ${next}\n`)
    }
  }
} else {
  process.stderr.write(`unknown command: ${argv.join(" ")}\n`)
  process.exitCode = 1
}
