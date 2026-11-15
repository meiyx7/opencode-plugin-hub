/**
 * Pure restart planner. Given an injected, structured snapshot of process
 * identities, it decides whether a safe self-restart of the desktop app can be
 * planned, and if so describes the steps — as data only. Nothing here touches
 * the system: no child processes, no signals, no filesystem access. The module
 * has zero imports so the "no side effects" property is checkable in tests.
 *
 * Identity model (static SDK evidence, see the batch-1 report):
 * - The Admin provider lives in `src/gui.tsx` `main(ctx)`, which the SDK runs
 *   once in the desktop app's MAIN process. So `self` IS the OpenCode app main
 *   process — not the `serve --service` sidecar. The sidecar is expected to be
 *   a direct child of `self`.
 * - Fail-closed everywhere: an unclear identity refuses. Targets are never
 *   guessed by scanning all OpenCode processes, never taken from a fuzzy
 *   command-line substring, and never taken from the SingletonLock PID alone —
 *   the lock value is only corroborating evidence that must agree with the
 *   confirmed identity.
 */

export interface ProcessIdentity {
  pid?: number
  ppid?: number
  uid?: number
  exe?: string
  argv?: readonly string[]
}

export interface RestartSnapshot {
  /** The plugin's main-process runtime, as reported by `process.*` inside `main(ctx)`. */
  self?: ProcessIdentity | null
  /** The app's own server child (the `serve --service` sidecar), if observed. */
  sidecar?: ProcessIdentity | null
  /** PID parsed from the SingletonLock symlink target (`hostname-pid`), if available. */
  singletonLockPid?: number | null
  /** Optional extra process records, used only for PID conflict detection. */
  processes?: readonly ProcessIdentity[]
}

export interface RestartPlanOptions {
  /** Exact executable path the desktop main process must match. */
  expectedAppExe?: string
  /** Executable path suffix the sidecar must match. */
  expectedSidecarExeSuffix?: string
}

export type PlannedAction =
  | { type: "terminate"; pid: number; signal: "TERM"; note: string }
  | { type: "terminate-if-still-running"; pid: number; signal: "KILL"; note: string }
  | { type: "await-exit"; pid: number; note: string }
  | { type: "relaunch"; exe: string; argv: readonly string[]; note: string }

export interface RestartTarget {
  appPid: number
  appExe: string
  appArgv: readonly string[]
  sidecarPid: number
  uid?: number
}

export interface RestartEvidence {
  what: string
  value: string
}

export type RestartRefusalCode =
  | "self-unknown"
  | "identity-incomplete"
  | "not-desktop-main"
  | "identity-contradiction"
  | "sidecar-unconfirmed"
  | "sidecar-relation-broken"
  | "pid-conflict"
  | "lock-mismatch"

export type RestartPlan =
  | {
      allowed: true
      reason: "identity-confirmed"
      target: RestartTarget
      actions: readonly PlannedAction[]
      evidence: readonly RestartEvidence[]
    }
  | {
      allowed: false
      reason: RestartRefusalCode
      message: string
      target: null
      actions: readonly []
      evidence: readonly RestartEvidence[]
    }

export const DEFAULT_APP_EXE = "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
export const DEFAULT_SIDECAR_SUFFIX = "/opencode-cli"

/** Parses the PID out of a SingletonLock symlink target such as `host-53046`. */
export function singletonLockPidFromTarget(target: string | null | undefined): number | null {
  if (typeof target !== "string") return null
  const match = target.match(/-(\d+)$/)
  return match ? Number(match[1]) : null
}

/**
 * Maps the fields a runtime probe would read off `process` (pid, ppid, uid,
 * execPath, argv) onto the planner's identity shape. Pure: it only renames
 * fields of its argument and never reads the real runtime itself.
 */
export function identityFromProcessLike(
  proc:
    | {
        pid?: unknown
        ppid?: unknown
        uid?: unknown
        execPath?: unknown
        argv?: unknown
      }
    | null
    | undefined,
): ProcessIdentity | null {
  if (!proc || typeof proc.pid !== "number") return null
  return {
    pid: proc.pid,
    ppid: typeof proc.ppid === "number" ? proc.ppid : undefined,
    uid: typeof proc.uid === "number" ? proc.uid : undefined,
    exe: typeof proc.execPath === "string" ? proc.execPath : undefined,
    argv: Array.isArray(proc.argv) ? (proc.argv as readonly string[]) : undefined,
  }
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

export function planRestart(snapshot: RestartSnapshot, options: RestartPlanOptions = {}): RestartPlan {
  const evidence: RestartEvidence[] = []
  const appExe = options.expectedAppExe ?? DEFAULT_APP_EXE
  const sidecarSuffix = options.expectedSidecarExeSuffix ?? DEFAULT_SIDECAR_SUFFIX
  const refuse = (reason: RestartRefusalCode, message: string): RestartPlan => ({
    allowed: false,
    reason,
    message,
    target: null,
    actions: [],
    evidence,
  })

  // 1) The planner host must know which process it is. Without a confirmed
  //    self PID there is nothing safe to act on.
  const self = snapshot.self
  if (!self || !validPid(self.pid)) {
    return refuse("self-unknown", "无法确认插件主进程自身身份（缺少当前进程 PID），拒绝自动重启。")
  }
  evidence.push({ what: "self.pid", value: String(self.pid) })

  // 2) Full self identity is required: exe, argv, ppid and uid. A partial
  //    identity is treated as no identity.
  const exe = self.exe
  const argv = self.argv
  const ppid = self.ppid
  const uid = self.uid
  if (typeof exe !== "string" || exe.length === 0) {
    return refuse("identity-incomplete", "当前进程缺少可执行文件路径（exe），身份证据不足，拒绝自动重启。")
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    return refuse("identity-incomplete", "当前进程缺少启动参数（argv），身份证据不足，拒绝自动重启。")
  }
  if (!validPid(ppid)) {
    return refuse("identity-incomplete", "当前进程缺少父进程 PID（ppid），身份证据不足，拒绝自动重启。")
  }
  if (typeof uid !== "number") {
    return refuse("identity-incomplete", "当前进程缺少 UID（uid），身份证据不足，拒绝自动重启。")
  }
  evidence.push({ what: "self.exe", value: exe })
  evidence.push({ what: "self.ppid", value: String(ppid) })
  evidence.push({ what: "self.uid", value: String(uid) })

  // 3) The self process must be the expected OpenCode desktop main process —
  //    exact path match, never a substring guess.
  if (exe !== appExe) {
    return refuse("not-desktop-main", `当前进程不是预期的 OpenCode 桌面主进程：exe=${exe}，预期=${appExe}。`)
  }
  if (argv[0] !== exe) {
    return refuse(
      "identity-contradiction",
      `当前进程 argv[0]=${String(argv[0])} 与 exe=${exe} 不一致，身份证据互相矛盾，拒绝自动重启。`,
    )
  }

  // 4) The sidecar service must be independently confirmed: own PID, matching
  //    executable and a direct parent-child relation to the self process.
  //    Ownership comes from the relation plus the executable path — never from
  //    fuzzy command-line substrings.
  const sidecar = snapshot.sidecar
  if (!sidecar || !validPid(sidecar.pid)) {
    return refuse("sidecar-unconfirmed", "无法确认应用自带服务进程的身份（缺少 PID），拒绝自动重启。")
  }
  const sidecarPid = sidecar.pid
  if (sidecarPid === self.pid) {
    return refuse("pid-conflict", "服务进程 PID 与当前主进程 PID 相同，证据互相冲突。")
  }
  const sidecarExe = sidecar.exe
  if (typeof sidecarExe !== "string" || !sidecarExe.endsWith(sidecarSuffix)) {
    return refuse(
      "sidecar-unconfirmed",
      `无法确认服务进程可执行文件身份：${typeof sidecarExe === "string" ? sidecarExe : "（缺失）"}。`,
    )
  }
  if (sidecar.ppid !== self.pid) {
    return refuse("sidecar-relation-broken", `服务进程（PID ${sidecarPid}）不是当前主进程的直接子进程，归属不明，拒绝终止。`)
  }
  evidence.push({ what: "sidecar.pid", value: String(sidecarPid) })
  evidence.push({ what: "sidecar.exe", value: sidecarExe })
  evidence.push({ what: "sidecar.ppid", value: String(sidecar.ppid) })

  // 5) PID conflicts anywhere in the provided records invalidate the snapshot.
  const owner = new Map<number, string>()
  const register = (pid: number, label: string): string | null => {
    const previous = owner.get(pid)
    if (previous !== undefined) return `PID ${pid} 同时属于 ${previous} 与 ${label}，进程证据冲突。`
    owner.set(pid, label)
    return null
  }
  let conflict = register(self.pid, "self")
  if (conflict === null) conflict = register(sidecarPid, "sidecar")
  for (const record of snapshot.processes ?? []) {
    if (conflict !== null) break
    if (validPid(record.pid)) conflict = register(record.pid, "进程表记录")
  }
  if (conflict !== null) return refuse("pid-conflict", conflict)

  // 6) The SingletonLock PID is corroborating evidence only: it must agree
  //    with the confirmed self PID, and it can never select a target by
  //    itself. A missing lock value is allowed but recorded as absent.
  if (snapshot.singletonLockPid != null) {
    if (!validPid(snapshot.singletonLockPid)) {
      return refuse("lock-mismatch", "SingletonLock 记录的 PID 格式无效，无法作为佐证。")
    }
    evidence.push({ what: "singletonLockPid", value: String(snapshot.singletonLockPid) })
    if (snapshot.singletonLockPid !== self.pid) {
      return refuse(
        "lock-mismatch",
        `SingletonLock 记录的 PID（${snapshot.singletonLockPid}）与当前主进程 PID（${self.pid}）不一致，拒绝自动重启。`,
      )
    }
    evidence.push({ what: "singletonLock", value: "与当前主进程 PID 一致，佐证通过" })
  } else {
    evidence.push({ what: "singletonLock", value: "未提供（不影响判定，仅缺少佐证）" })
  }

  // 7) Everything confirmed. The returned actions are a description for the
  //    later executor batch — planning ends here, nothing is performed.
  const target: RestartTarget = {
    appPid: self.pid,
    appExe: exe,
    appArgv: argv,
    sidecarPid,
    uid,
  }
  const actions: readonly PlannedAction[] = [
    { type: "terminate", pid: self.pid, signal: "TERM", note: "请求当前 OpenCode 桌面主进程退出" },
    { type: "await-exit", pid: self.pid, note: "等待主进程完全退出，期间不发送任何其他信号" },
    {
      type: "terminate-if-still-running",
      pid: sidecarPid,
      signal: "KILL",
      note: "主进程退出后，服务进程若仍残留才强制结束",
    },
    { type: "await-exit", pid: sidecarPid, note: "等待服务进程退出并确认单实例锁释放" },
    { type: "relaunch", exe, argv, note: "用原可执行文件与原启动参数重新打开当前实例" },
  ]
  return { allowed: true, reason: "identity-confirmed", target, actions, evidence }
}
