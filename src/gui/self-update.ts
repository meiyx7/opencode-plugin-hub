/**
 * Self-update / restart prompts, kept free of Solid and DOM dependencies so the node:test
 * suite can drive every branch (confirm, cancel, restart failure) without a renderer.
 *
 * The UI only wires the three callbacks; which note appears, and in which order, is decided
 * here. "正在重启" must never appear before the user has confirmed, and a cancelled
 * confirmation must never leave a "restarting" or "restart succeeded" message on screen.
 */

export type HubTone = "info" | "success" | "warning" | "error"

export interface HubNote {
  text: string
  tone: HubTone
}

export interface ConfirmOptions {
  title: string
  description: string
  confirm: string
}

/** Outcome of one `admin.restart()` call as seen from the window. */
export type RestartAttempt = "started" | "unavailable" | "failed"

/**
 * Scope of the new restart mechanism: only the CURRENT desktop instance and
 * the `serve --service` sidecar it spawned are ended. Other instances, other
 * users' processes and unrelated processes are never touched, because the
 * target is identified from the plugin's own main process and re-verified
 * (PID + process start time) before every signal.
 */
const SCOPE =
  "重启只影响当前 OpenCode 实例：退出当前应用主进程并结束它启动的后台 serve --service 服务；本机上其他 OpenCode 实例和其他窗口不受影响。若无法安全确认实例身份，自动重启会取消且不结束任何进程。"

export const SELF_UPDATE_CONFIRM: ConfirmOptions = {
  title: "重启 OpenCode 以加载插件中心新版本？",
  description: `插件中心已更新，但当前窗口与后台服务仍在运行旧版本，需要彻底重启才能加载。${SCOPE}；当前会话通常会自动恢复。`,
  confirm: "重启",
}

export const RESTART_CONFIRM: ConfirmOptions = {
  title: "彻底重启 OpenCode？",
  description: `应用会退出并自动重新打开，让插件代码和后台 serve --service 一起换成最新版本。${SCOPE}。当前会话通常会自动恢复。`,
  confirm: "重启",
}

/** Step 1: the update is done, but a restart is REQUIRED — not already happening. */
const NEED_RESTART: HubNote = {
  text: "插件中心已更新完成，需要彻底重启 OpenCode 才能加载新版本。",
  tone: "info",
}

/** Step 2 (declined): done, not restarted, and the toolbar entry is still available. */
const CANCELLED: HubNote = {
  text: "插件中心已更新完成，但尚未重启，当前仍在运行旧版本。可随时点「更多操作 → 彻底重启 OpenCode」加载新版本。",
  tone: "warning",
}

/** Step 2 (confirmed): the request was accepted and the supervisor is taking over. */
const RESTARTING: HubNote = {
  text: "已受理重启请求，OpenCode 正在重启：当前实例将退出并由独立的监督流程用原启动方式重新打开。若长时间未自动打开，请手动启动一次。",
  tone: "info",
}

const MANUAL =
  "请手动完全退出 OpenCode（并结束残留的 serve --service 后台服务）后重新打开；也可用「更多操作 → 彻底重启 OpenCode」重试。"

const UNAVAILABLE: HubNote = {
  text: `无法安全确认当前实例身份，已取消自动重启且未结束任何进程。${MANUAL}`,
  tone: "error",
}

const FAILED: HubNote = {
  text: `自动重启调用失败，后台服务可能仍是旧版本。${MANUAL}`,
  tone: "error",
}

/** Note shown after the toolbar's own "彻底重启 OpenCode" entry point. */
export function restartNote(attempt: RestartAttempt): HubNote {
  if (attempt === "started") return RESTARTING
  return attempt === "unavailable" ? UNAVAILABLE : FAILED
}

export interface SelfUpdateDeps {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  restart: () => Promise<RestartAttempt>
  notify: (note: HubNote) => void
}

/**
 * Runs the whole self-update flow and returns the notes it emitted, in order:
 *   1. say a restart is NEEDED (not that it is happening);
 *   2. ask the user; on cancel, say the update is done but not restarted;
 *   3. only after confirmation say "正在重启", then attempt it;
 *   4. on failure, replace that note with an explicit manual-restart instruction.
 */
export async function runSelfUpdateRestart(deps: SelfUpdateDeps): Promise<HubNote[]> {
  const emitted: HubNote[] = []
  const emit = (note: HubNote) => {
    emitted.push(note)
    deps.notify(note)
  }
  emit(NEED_RESTART)
  if (!(await deps.confirm(SELF_UPDATE_CONFIRM))) {
    emit(CANCELLED)
    return emitted
  }
  emit(RESTARTING)
  const attempt = await deps.restart()
  if (attempt !== "started") emit(restartNote(attempt))
  return emitted
}
