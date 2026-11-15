/**
 * Collects the restart snapshot inside the Electron main process and runs the
 * pure planner on it. Everything system-facing is injected through `deps`, so
 * the node:test suite drives collection with fake tools and never touches real
 * processes. Fail-closed: every missing, unreadable or contradictory piece of
 * evidence produces a refusal message instead of a payload.
 */
import { planRestart, singletonLockPidFromTarget, DEFAULT_APP_EXE, DEFAULT_SIDECAR_SUFFIX } from "./restart"

/** One row of `ps -p PID -o pid=,ppid=,uid=,lstart=,comm=`. */
export interface ParsedProc {
  pid: number
  ppid: number
  uid: number
  /** Opaque instance credential: the process start time as `ps` renders it. */
  lstart: string
  /** Full executable path. */
  comm: string
}

export interface CollectDeps {
  platform: string
  /** Process identity of a PID, or null when the tool fails / the process is gone. */
  procInfo(pid: number): ParsedProc | null
  /** Direct child PIDs, or null when enumeration fails. */
  childPids(pid: number): number[] | null
  /** The current main-process runtime, as `process.*` reports it. */
  self: { pid: number; ppid: number; uid: number; execPath: string; argv: readonly string[]; cwd: string }
  env: Readonly<Record<string, string | undefined>>
  /** SingletonLock path of this instance, or null when it cannot be determined. */
  lockPath: string | null
  readLink(path: string): string | null
  /** A Node runtime able to host the detached supervisor, or null. */
  runtimePath: string | null
  statusPath: string
  requestId: string
  development: boolean
}

export interface SupervisorPayload {
  requestId: string
  statusPath: string
  lockPath: string | null
  app: {
    pid: number
    ppid: number
    uid: number
    lstart: string
    exe: string
    argv: readonly string[]
    cwd: string
  }
  sidecar: { pid: number; uid: number; lstart: string; exe: string } | null
  env: Record<string, string>
  timeouts: SupervisorTimeouts
}

export interface SupervisorTimeouts {
  appExitMs: number
  sidecarGraceMs: number
  sidecarExitMs: number
  launchVerifyMs: number
  overallMs: number
}

export const RESTART_TIMEOUTS: SupervisorTimeouts = {
  appExitMs: 8_000,
  sidecarGraceMs: 2_000,
  sidecarExitMs: 5_000,
  launchVerifyMs: 4_000,
  overallMs: 30_000,
}

export interface CollectResult {
  payload: SupervisorPayload | null
  /** Human-readable refusal reason; empty when a payload was produced. */
  message: string
  runtimePath: string | null
}

const EXACT_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"]
const ENV_PREFIXES = ["XDG_", "OPENCODE_"]

/**
 * Parses one `ps -p PID -o pid=,ppid=,uid=,lstart=,comm=` line. The start time
 * (four tokens, e.g. `Thu Nov 15 18:24:15 2026`) is kept as an opaque string:
 * it is the process-instance credential that PID-reuse protection compares.
 * Must stay in sync with the copy inside the supervisor source.
 */
export function parseProcLine(line: string): ParsedProc | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 9) return null
  const pid = Number.parseInt(tokens[0]!, 10)
  const ppid = Number.parseInt(tokens[1]!, 10)
  const uid = Number.parseInt(tokens[2]!, 10)
  const lstart = tokens.slice(3, 8).join(" ")
  const comm = tokens.slice(8).join(" ")
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isInteger(uid)) return null
  if (!lstart || !comm) return null
  return { pid, ppid, uid, lstart, comm }
}

/**
 * Minimal necessary environment for the relaunched app: identity, temp and
 * locale basics plus the XDG_/OPENCODE_ families. Never copied wholesale —
 * credentials and host-app specifics are dropped on purpose.
 */
export function whitelistEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {}
  const exact = new Set(EXACT_ENV_KEYS)
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue
    if (exact.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) picked[key] = value
  }
  return picked
}

/**
 * The supervisor must be hosted by a real Node runtime (resolved by the caller,
 * which has filesystem access). `process.execPath` inside the Electron main
 * process is the Electron binary and cannot run `-e` scripts, so a null
 * runtime refuses the auto restart instead of guessing.
 */

export function collectRestartSnapshot(deps: CollectDeps): CollectResult {
  const refuse = (message: string): CollectResult => ({ payload: null, message, runtimePath: deps.runtimePath })
  if (deps.development) return refuse("开发模式下不执行自动重启，请手动完全退出 OpenCode 后重新打开。")
  if (deps.platform !== "darwin") return refuse(`自动重启仅支持 macOS（当前 ${deps.platform}），请手动重启。`)

  // --- self: the Electron main process this plugin runs in -----------------
  const psSelf = deps.procInfo(deps.self.pid)
  if (!psSelf) return refuse("无法读取当前进程身份凭据（ps 不可用或进程已退出），拒绝自动重启。")
  if (psSelf.pid !== deps.self.pid) return refuse("进程身份查询返回了错误的 PID，证据矛盾，拒绝自动重启。")
  if (psSelf.comm !== deps.self.execPath) {
    return refuse(`当前进程可执行文件不一致：ps=${psSelf.comm}，process=${deps.self.execPath}，证据矛盾，拒绝自动重启。`)
  }
  if (psSelf.uid !== deps.self.uid) {
    return refuse(`当前进程 UID 不一致：ps=${psSelf.uid}，process=${deps.self.uid}，证据矛盾，拒绝自动重启。`)
  }
  if (!psSelf.lstart) return refuse("无法读取当前进程启动时间（进程实例凭据缺失），拒绝自动重启。")

  // macOS 桌面主进程校验：必须是某个 .app bundle 的主可执行文件。开发用的
  // Electron 二进制虽符合路径形态，但 development 标志已在上方拒绝。
  if (!/\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(deps.self.execPath)) {
    return refuse(`当前进程不是 macOS 桌面应用主进程：${deps.self.execPath}，拒绝自动重启。`)
  }

  // --- sidecar: the app's own `serve --service` child -----------------------
  const children = deps.childPids(deps.self.pid)
  if (children === null) return refuse("无法枚举当前进程的直接子进程，服务归属不明，拒绝自动重启。")
  const sidecars: { pid: number; ppid: number; uid: number; lstart: string; exe: string }[] = []
  for (const pid of children) {
    const info = deps.procInfo(pid)
    if (!info) continue
    if (info.comm.endsWith(DEFAULT_SIDECAR_SUFFIX)) {
      sidecars.push({ pid, ppid: info.ppid, uid: info.uid, lstart: info.lstart, exe: info.comm })
    }
  }
  if (sidecars.length === 0) {
    return refuse("未发现当前实例自带的服务进程（serve --service），无法确认完整重启目标，拒绝自动重启。")
  }
  if (sidecars.length > 1) {
    return refuse(`发现 ${sidecars.length} 个服务进程候选，归属不明，拒绝自动重启。`)
  }

  // --- SingletonLock: corroborating evidence only ---------------------------
  const lockTarget = deps.lockPath ? deps.readLink(deps.lockPath) : null
  const lockPid = lockTarget ? singletonLockPidFromTarget(lockTarget) : null

  // --- plan -----------------------------------------------------------------
  // A non-default install path is accepted only when it still looks like a
  // macOS .app main binary (checked above); anything else keeps the strict
  // default so the planner's desktop-main check stays meaningful.
  const expectedAppExe = deps.self.execPath === DEFAULT_APP_EXE ? DEFAULT_APP_EXE : deps.self.execPath
  const plan = planRestart(
    {
      self: { pid: deps.self.pid, ppid: deps.self.ppid, uid: deps.self.uid, exe: deps.self.execPath, argv: deps.self.argv },
      sidecar: { pid: sidecars[0]!.pid, ppid: sidecars[0]!.ppid, uid: sidecars[0]!.uid, exe: sidecars[0]!.exe },
      singletonLockPid: lockPid,
    },
    { expectedAppExe },
  )
  if (!plan.allowed) return refuse(plan.message)

  return {
    payload: {
      requestId: deps.requestId,
      statusPath: deps.statusPath,
      lockPath: deps.lockPath,
      app: {
        pid: deps.self.pid,
        ppid: deps.self.ppid,
        uid: deps.self.uid,
        lstart: psSelf.lstart,
        exe: deps.self.execPath,
        argv: deps.self.argv,
        cwd: deps.self.cwd,
      },
      // 载荷里的 sidecar 不带 ppid：主进程退出后它会被 launchd 重新挂靠，
      // 监督流程的身份复核只依赖 exe/UID/启动时间（PID 复用防护）。
      sidecar: { pid: sidecars[0]!.pid, uid: sidecars[0]!.uid, lstart: sidecars[0]!.lstart, exe: sidecars[0]!.exe },
      env: whitelistEnv(deps.env),
      timeouts: RESTART_TIMEOUTS,
    },
    message: "",
    runtimePath: deps.runtimePath,
  }
}
