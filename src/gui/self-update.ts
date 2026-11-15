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
 * Scope of admin.restart(): it enumerates ALL processes with `ps -axo` and signals every
 * OpenCode main process plus every command line containing `serve --service`. It is not
 * scoped to the current window, so the dialog says so instead of implying otherwise.
 */
const SCOPE =
  "重启会结束本机上所有正在运行的 OpenCode 应用进程和后台 serve --service 服务（包括其他已打开的窗口或实例），然后重新打开一个应用窗口"

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

/** Step 2 (confirmed): only now is the app actually being restarted. */
const RESTARTING: HubNote = {
  text: "正在重启 OpenCode…如果没有自动打开，请手动启动一次。",
  tone: "info",
}

const MANUAL =
  "请手动完全退出 OpenCode（并结束残留的 serve --service 后台服务）后重新打开；也可用「更多操作 → 彻底重启 OpenCode」重试。"

const UNAVAILABLE: HubNote = {
  text: `自动重启失败，${MANUAL}`,
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
