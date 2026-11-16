/**
 * The official `opencode plugin …` CLI, wrapped once.
 *
 * Everything the hub does to npm packages goes through this module: install, update, remove and
 * the update check. The hub deliberately owns no package manager of its own — it parses the same
 * commands a user would type, keeps the raw output, and reports what actually happened instead of
 * assuming that a spawned process means success.
 *
 * Rules enforced here:
 * - `spawn(bin, args)` with an argument array, never a shell string.
 * - The exit code is the truth. `exit 0` with "is not configured" in the output is *not* success,
 *   and a spawn that never started is reported as "not started", not as code 0.
 * - A timeout kills the child and reports a timeout; it never falls through to success.
 */
import { spawn } from "node:child_process"

export interface CliResult {
  /** True only when the command ran to completion, exited 0, and printed no failure signature. */
  ok: boolean
  /** False when the binary could not be spawned at all (missing CLI). */
  started: boolean
  /** True when the deadline killed the command. */
  timedOut: boolean
  code: number
  stdout: string
  stderr: string
  /** Last meaningful lines of output, already stripped of stack frames and ANSI. One line. */
  message: string
}

let command: readonly string[] = []

/**
 * The argv prefix the host reports for its own CLI (e.g. `/path/to/opencode`, or a wrapped
 * `bun /path/to/opencode`). Empty means "no CLI available", which is reported, never papered over.
 */
export function configureCli(argv: readonly string[] | undefined): void {
  command = (argv ?? []).map((part) => String(part)).filter((part) => part.trim().length > 0)
}

export function cliCommand(): readonly string[] {
  return command
}

export function hasCli(): boolean {
  return command.length > 0
}

const ANSI = /\u001b\[[0-9;]*m/g

/** Drops ANSI, stack frames and blank lines, keeping the sentences that explain the failure. */
export function meaningfulLines(output: string): string[] {
  return output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => {
      const text = line.trim()
      if (text.length === 0) return false
      if (/^at\s/.test(text)) return false // stack frame
      if (/^\^\s*$/.test(text)) return false
      if (/^\}\s*$/.test(text) || /^\)\s*$/.test(text)) return false
      return true
    })
}

/** `[cause]: Error: such and such` → `such and such`: the cause is the part a user can act on. */
function cleanLine(line: string): string {
  return line
    .trim()
    .replace(/^\[cause\]:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/^(?:[A-Za-z]+Error):\s*/i, "")
    .replace(/\s*\{\s*$/, "")
    .trim()
}

export function summarize(stdout: string, stderr: string): string {
  // stderr carries the failure reason; stdout carries the success sentence. Prefer stderr only
  // when it says something beyond a bare stack trace.
  const err = meaningfulLines(stderr).map(cleanLine).filter((line) => line.length > 0)
  const out = meaningfulLines(stdout).map(cleanLine).filter((line) => line.length > 0)
  const picked = err.length > 0 ? err : out
  return picked.slice(-3).join(" · ").slice(0, 400)
}

export interface RunOptions {
  /** Hard deadline; on expiry the child is terminated and the result says so. */
  timeoutMs?: number
}

const OUTPUT_LIMIT = 64 * 1024

function append(current: string, chunk: unknown): string {
  if (current.length >= OUTPUT_LIMIT) return current
  return (current + String(chunk)).slice(0, OUTPUT_LIMIT)
}

export function runCli(args: readonly string[], options: RunOptions = {}): Promise<CliResult> {
  if (command.length === 0) {
    return Promise.resolve({
      ok: false,
      started: false,
      timedOut: false,
      code: -1,
      stdout: "",
      stderr: "",
      message: "找不到 opencode CLI，无法执行官方命令",
    })
  }
  const [bin, ...prefix] = command
  const argv = [...prefix, ...args]
  const timeoutMs = options.timeoutMs ?? 120_000
  return new Promise<CliResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let started = false
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined

    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const message = timedOut
        ? `命令超时（${Math.round(timeoutMs / 1000)} 秒）后被终止：opencode ${args.join(" ")}`
        : summarize(stdout, stderr)
      resolve({
        ok: code === 0 && !timedOut && started && !failureSignature(stdout + "\n" + stderr),
        started,
        timedOut,
        code,
        stdout,
        stderr,
        message,
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin!, argv, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      resolve({
        ok: false,
        started: false,
        timedOut: false,
        code: -1,
        stdout: "",
        stderr: "",
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      // A CLI waiting on its own server can ignore SIGTERM; make the deadline real.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000)
    }, timeoutMs)

    child.stdout?.on("data", (chunk) => (stdout = append(stdout, chunk)))
    child.stderr?.on("data", (chunk) => (stderr = append(stderr, chunk)))
    child.on("spawn", () => (started = true))
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        ok: false,
        started,
        timedOut,
        code: -1,
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
        message: error instanceof Error ? error.message : String(error),
      })
    })
    child.on("close", (code) => finish(code ?? -1))
  })
}

/**
 * Some official commands answer "nothing happened" with exit code 0 (removing a plugin that is not
 * configured, for instance). Those sentences are the only failure signal available, so they are
 * treated as such rather than being reported as a completed action.
 */
const FAILURE_SIGNATURES = [/is not configured/i, /^Error:/m, /NpmInstallFailedError/i, /Plugin package has no .* entrypoint/i]

function failureSignature(output: string): boolean {
  return FAILURE_SIGNATURES.some((pattern) => pattern.test(output))
}

export interface CliOutcome {
  result: CliResult
  /** What the command reported doing, or "" when the output says nothing recognisable. */
  status: "added" | "already" | "removed" | "not-configured" | "no-updates" | "failed" | "unknown"
  /** Config path the CLI said it wrote, when it named one. */
  path: string
}

function firstMatch(text: string, pattern: RegExp): string {
  const match = pattern.exec(text)
  return match?.[1] ?? ""
}

/** Normalises one command result into a status the callers can branch on without re-parsing text. */
export function classify(result: CliResult): CliOutcome {
  const text = `${result.stdout}\n${result.stderr}`
  const clean = text.replace(ANSI, "")
  if (/is already configured in (.+)$/m.test(clean)) {
    return { result, status: "already", path: cleanPath(clean, /is already configured in (.+)$/m) }
  }
  if (/is not configured/i.test(clean)) {
    return { result, status: "not-configured", path: "" }
  }
  if (/installed and added to (.+)$/m.test(clean)) {
    return { result, status: "added", path: cleanPath(clean, /installed and added to (.+)$/m) }
  }
  if (/removed from (.+)$/m.test(clean)) {
    return { result, status: "removed", path: cleanPath(clean, /removed from (.+)$/m) }
  }
  if (/No plugin updates available/i.test(clean)) {
    return { result, status: "no-updates", path: "" }
  }
  if (!result.ok) return { result, status: "failed", path: "" }
  return { result, status: "unknown", path: "" }
}

function cleanPath(text: string, pattern: RegExp): string {
  return firstMatch(text, pattern).trim()
}

// ---------------------------------------------------------------------------
// The four official package commands
// ---------------------------------------------------------------------------

/** Installing downloads the package, so it gets the longest deadline. */
const ADD_TIMEOUT = 180_000
const UPDATE_TIMEOUT = 180_000
const REMOVE_TIMEOUT = 60_000
const READ_TIMEOUT = 30_000

/**
 * A slow network should not have to mean editing code: `OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS` caps
 * every deadline (it can only shorten the defaults above, never extend past them).
 */
function deadline(defaultMs: number): number {
  const raw = Number(process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.min(defaultMs, raw) : defaultMs
}

export async function pluginAdd(target: string): Promise<CliOutcome> {
  return classify(await runCli(["plugin", "add", target], { timeoutMs: deadline(ADD_TIMEOUT) }))
}

export async function pluginRemove(target: string): Promise<CliOutcome> {
  return classify(await runCli(["plugin", "remove", target], { timeoutMs: deadline(REMOVE_TIMEOUT) }))
}

/** Updates one configured target, or every outdated plugin when `target` is empty. */
export async function pluginUpdate(target?: string): Promise<CliOutcome> {
  const args = ["plugin", "update", ...(target ? [target] : [])]
  return classify(await runCli(args, { timeoutMs: deadline(UPDATE_TIMEOUT) }))
}

export async function pluginCheck(target?: string): Promise<CliResult> {
  const args = ["plugin", "check", ...(target ? [target] : [])]
  return runCli(args, { timeoutMs: deadline(READ_TIMEOUT) })
}

/** The official runtime view: one row per configured plugin, with the ID it actually loaded under. */
export async function pluginList(): Promise<CliResult> {
  return runCli(["plugin", "list"], { timeoutMs: deadline(READ_TIMEOUT) })
}

/** Asks the host to reload configuration. Never assumed to have worked: the caller re-reads state. */
export async function pluginReload(): Promise<CliResult> {
  return runCli(["reload"], { timeoutMs: deadline(60_000) })
}
