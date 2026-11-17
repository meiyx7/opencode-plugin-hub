/**
 * 进度 Dialog “只拦外部点击关闭”的判定逻辑（纯函数，无 DOM / Solid 依赖）。
 *
 * Escape 不在此处理：由进度内容根节点的 data-owns-escape 交给宿主正式能力负责，
 * 因此这里只覆盖 pointerdown / click 两类“外部点击关闭”事件。
 *
 * 背景（来自 OpenCode 宿主真实实现，见 docs/host-interaction-verification.md）：
 * - 外部点击由两处触发：覆盖层的 click（backdrop.click）与 Kobalte 的
 *   document 捕获 pointerdown（判定 target 不在 dialog 内容元素内 → 触发 onDismiss）。
 * - Dialog 内容元素带 `role="dialog"` / `data-slot="dialog-content"`。
 * - 插件的 `ui.Dialog` 只透传 closable（仅隐藏标题栏 X），**不透传** ref / class /
 *   preventBackdropDismiss，所以插件只能用 window 捕获监听做局部拦截。
 *
 * 判定原则：
 * - 只拦截“执行期间、发生在 Dialog 内容之外、且宿主会据此关闭”的事件；
 * - Dialog 内部的正常交互（按钮、滚动、文本选择等）一律放行；
 * - 若无法可靠识别内容元素（拿不到 ref 或找不到 dialog 内容），返回“不拦截” ——
 *   宁可让宿主按默认语义处理，也不无差别锁住整个 OpenCode 窗口。
 *
 * 这些判定被 useLockDialogWhileRunning 使用，并被单元测试直接覆盖，
 * 避免“源码字符串断言代替事件行为测试”。
 */

export type LockEventType = "pointerdown" | "click"

export interface LockEventLike {
  type: string
}

export interface LockContext {
  running: boolean
  /**
   * 本次事件是否落在 Dialog 内容之外：由 DOM handler 用
   * `content && target instanceof Node && !content.contains(target)` 计算。
   * undefined 表示无法判定（例如还没拿到内容元素）。
   */
  isOutside: boolean | undefined
}

/**
 * 是否应拦截该事件（preventDefault + stopImmediatePropagation）。
 */
export function shouldLockEvent(event: LockEventLike, ctx: LockContext): boolean {
  if (!ctx.running) return false
  if (event.type === "pointerdown" || event.type === "click") {
    // 无法判定内外时绝不全局拦截；只在确实是“外部”事件时拦下，阻止宿主据此关闭。
    return ctx.isOutside === true
  }
  return false
}
