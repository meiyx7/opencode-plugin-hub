/**
 * Restart status file + detached supervisor launcher.
 *
 * Split out of `admin.ts` so the pieces that touch the filesystem and spawn
 * semantics can be driven by node:test with fakes, without a real Electron
 * main process, real `ps` or real signals.
 *
 * TASK-1 (status directory timing): the accepted record is written with
 * `mkdirSync` + `writeFileSync` — the directory is synchronously created
 * BEFORE the first write, and a failed creation surfaces as an error instead
 * of a silent race where `writeFileSync` runs against a missing directory.
 *
 * TASK-2 (spawn error handling): the detached supervisor spawn is settled by
 * waiting for either the `spawn` event (the child really exists) or the
 * `error` event (launch failed) before answering. ONLY the real `spawn` event
 * counts as success: `child.pid` alone is not evidence — Node reports spawn
 * failures (ENOENT, EACCES) asynchronously via `error`, and a spawned-but-
 * unconfirmed pid proves nothing about the OS having started the program.
 * The settle TIMEOUT is therefore a failure too: if neither event arrived in
 * time, the outcome is `failed` (supervisor-spawn-error:settle-timeout), even
 * when a pid happens to be present. `close`/`exit` are deliberately NOT
 * observed: the supervisor exiting is its normal way of finishing its job,
 * and the status file — not the parent's event view — is the source of truth.
 *
 * TASK-3 (per-instance status isolation): the status file name is derived
 * from the instance's user-data-dir (the stable per-instance identity the
 * relaunch preserves), never from the PID alone. Both the restart initiator
 * and the page's status read-back go through `instanceStatusPath`, so both
 * ends use the exact same rule and two OpenCode instances can never
 * overwrite each other's restart records.
 */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** One restart status record, shared with the supervisor's status writer. */
export interface RestartStatusRecord {
  requestId: string
  phase: string
  at: number
  detail: string
}

/** Same location the pre-isolation implementation used (kept as the base dir). */
export function restartStatusDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  return xdg ? join(xdg, "opencode", "plugin-hub") : join(homedir(), ".cache", "opencode", "plugin-hub")
}

/**
 * The status file for ONE OpenCode instance, identified by its user-data-dir.
 *
 * The user-data-dir is the right identity: it is stable for the instance's
 * lifetime, it survives the restart (the supervisor relaunches with the
 * original argv, so the new instance resolves the same directory), and it is
 * exactly what separates two side-by-side instances. The path is hashed (not
 * sanitized) into the file name, so odd characters in the directory cannot
 * break the path, and no PID ever appears in it.
 *
 * `null` means the caller could not determine an instance identity — callers
 * must fail closed (refuse the restart / report no status) instead of falling
 * back to a shared file that other instances could read or overwrite.
 */
export function instanceStatusPath(userDataPath: string | null, baseDir: string = restartStatusDir()): string | null {
  if (typeof userDataPath !== "string" || userDataPath.length === 0) return null
  const slug = createHash("sha256").update(userDataPath).digest("hex").slice(0, 16)
  return join(baseDir, `restart-status-${slug}.json`)
}

/**
 * Writes one status record, creating the parent directory synchronously first
 * (TASK-1). Throws when either step fails — callers must treat that as a
 * failure and must not report `accepted`.
 */
export function writeRestartStatusFile(statusPath: string, record: RestartStatusRecord): void {
  mkdirSync(dirname(statusPath), { recursive: true })
  writeFileSync(statusPath, JSON.stringify(record))
}

/**
 * Reads and validates one status record; null when missing, unreadable or
 * malformed. The same validation both ends rely on, so a record written by
 * `writeRestartStatusFile` (or the supervisor) always reads back.
 */
export async function readRestartStatusFile(statusPath: string): Promise<RestartStatusRecord | null> {
  try {
    const raw = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>
    if (typeof raw.phase !== "string") return null
    return {
      requestId: typeof raw.requestId === "string" ? raw.requestId : "",
      phase: raw.phase,
      at: typeof raw.at === "number" ? raw.at : 0,
      detail: typeof raw.detail === "string" ? raw.detail : "",
    }
  } catch {
    return null
  }
}

/** The subset of a spawned child the launcher needs (real ChildProcess fits). */
export interface SpawnedChild {
  readonly pid?: number
  on(event: string, listener: (...args: never[]) => void): unknown
  unref(): void
}

export type SpawnChild = (
  exe: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore"; env: Record<string, string> },
) => SpawnedChild

export interface LaunchOutcome {
  ok: boolean
  phase: "accepted" | "failed"
  message: string
}

/** How long to wait for the real `spawn`/`error` event before giving up. */
const DEFAULT_SETTLE_MS = 250

function errorTag(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && code.length > 0) return code
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(error)
}

/**
 * Writes the accepted record, spawns the detached supervisor and answers
 * "accepted" ONLY on the real `spawn` event — the OS-level proof that the
 * supervisor process exists. An `error` event, a settle timeout (even with a
 * pid present) or a missing pid all write an accurate `failed` status record
 * and never report accepted. "accepted" means the supervisor has been
 * confirmed started by the OS; it never means the restart is done.
 */
export async function launchRestartSupervisor(options: {
  runtimePath: string
  source: string
  payload: unknown
  statusPath: string
  requestId: string
  env: Record<string, string>
  spawnChild: SpawnChild
  writeStatusFile?: (statusPath: string, record: RestartStatusRecord) => void
  settleMs?: number
}): Promise<LaunchOutcome> {
  const write = options.writeStatusFile ?? writeRestartStatusFile
  const statusPath = options.statusPath
  const record = (phase: string, detail: string): RestartStatusRecord => ({
    requestId: options.requestId,
    phase,
    at: Date.now(),
    detail,
  })

  // Accepted record goes down first: if this fails there is no point spawning
  // anything — the outcome could never be read back. TASK-1 makes the
  // directory creation synchronous, so a missing directory is an error here,
  // not a race.
  try {
    write(statusPath, record("accepted", "supervisor-launched"))
  } catch (error) {
    return {
      ok: false,
      phase: "failed",
      message: `无法写入重启状态文件（${dirname(statusPath)}）：${errorTag(error)}。已取消自动重启，未结束任何进程。`,
    }
  }

  let child: SpawnedChild
  try {
    child = options.spawnChild(options.runtimePath, ["-e", options.source, "run", JSON.stringify(options.payload)], {
      detached: true,
      stdio: "ignore",
      env: options.env,
    })
  } catch (error) {
    try {
      write(statusPath, record("failed", `supervisor-spawn-error:${errorTag(error)}`))
    } catch {
      // best effort: the accepted record stays and names this requestId
    }
    return {
      ok: false,
      phase: "failed",
      message: `重启监督流程启动失败（${errorTag(error)}），未结束任何进程。请手动重启。`,
    }
  }

  // Wait for the spawn to prove itself. ONLY the real `spawn` event counts:
  // Node reports spawn failures via the async `error` event, and a present
  // `child.pid` alone is never OS-level evidence of a started process. If
  // neither event arrives within the settle window the outcome is `failed`
  // (supervisor-spawn-error:settle-timeout) — fail-closed, even when a pid
  // happens to be present. The error listener intentionally stays attached
  // after settling: an `error` event with no listener would crash the
  // Electron main process, and after settle it is a no-op because the status
  // file is already authoritative (late events never rewrite it).
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const settled = await new Promise<{ error?: Error; spawned: boolean }>((resolve) => {
    let done = false
    const finish = (outcome: { error?: Error; spawned?: boolean }) => {
      if (done) return
      done = true
      resolve({ error: outcome.error, spawned: outcome.spawned === true })
    }
    child.on("error", (err: Error) => finish({ error: err }))
    child.on("spawn", () => finish({ spawned: true }))
    setTimeout(() => finish({}), settleMs)
  })

  if (settled.error) {
    try {
      write(statusPath, record("failed", `supervisor-spawn-error:${errorTag(settled.error)}`))
    } catch {
      // best effort
    }
    return {
      ok: false,
      phase: "failed",
      message: `重启监督流程启动失败（${errorTag(settled.error)}），未结束任何进程。请手动重启。`,
    }
  }

  // No spawn event within the settle window: not confirmed by the OS, so the
  // outcome is failed regardless of child.pid. A pid without the spawn event
  // is a guess, and guesses never escalate to "accepted".
  if (!settled.spawned) {
    try {
      write(statusPath, record("failed", "supervisor-spawn-error:settle-timeout"))
    } catch {
      // best effort
    }
    return {
      ok: false,
      phase: "failed",
      message: "重启监督流程未能在限定时间内确认启动（settle-timeout），未结束任何进程。请手动重启。",
    }
  }

  // Defensive: after a real spawn event Node always exposes a positive pid.
  // If a fake/odd implementation ever violates that, fail closed instead of
  // reporting accepted without an addressable process.
  if (typeof child.pid !== "number" || child.pid <= 0) {
    try {
      write(statusPath, record("failed", "supervisor-spawn-error:no-pid"))
    } catch {
      // best effort
    }
    return {
      ok: false,
      phase: "failed",
      message: "重启监督流程启动失败（no-pid），未结束任何进程。请手动重启。",
    }
  }

  child.unref()
  return {
    ok: true,
    phase: "accepted",
    message: "已受理重启请求：监督流程将退出当前实例并用原启动方式重新打开。",
  }
}
