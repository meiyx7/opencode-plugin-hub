/**
 * 进度 Dialog “仅拦截可能导致关闭的事件”的判定逻辑（纯函数，无 DOM / Solid 依赖）。
 *
 * 背景（来自 OpenCode 宿主真实实现，见 docs/host-interaction-verification.md）：
 * - Escape 由宿主 window 捕获阶段的 keydown 处理 → dismiss。
 * - 外部点击由两处触发：覆盖层的 click（backdrop.click）与 Kobalte 的
 *   document 捕获 pointerdown（判定 target 不在 dialog 内容元素内 → 触发 onDismiss）。
 * - Dialog 内容元素带 `role="dialog"` / `data-slot="dialog-content"`。
 * - 插件的 `ui.Dialog` 只透传 closable（仅隐藏标题栏 X），**不透传** ref / class /
 *   preventBackdropDismiss，所以插件无法用 props 选择退出关闭、也拿不到 Dialog 的 DOM 句柄。
 *
 * 修正原则：
 * - 只拦截“执行期间、发生在 Dialog 内容之外、且宿主会据此关闭”的事件；
 * - Dialog 内部的正常交互（按钮、滚动、文本选择等）一律放行；
 * - keydown 只拦 Escape 键本身（保持原行为）；
 * - 若无法可靠识别内容元素（拿不到 ref 或找不到 dialog 内容），返回“不拦截” ——
 *   宁可让宿主按默认语义处理，也不无差别锁住整个 OpenCode 窗口。
 *
 * 这些判定被 useLockDialogWhileRunning 使用，并被单元测试直接覆盖，
 * 避免“源码字符串断言代替事件行为测试”。
 */

export type LockEventType = "keydown" | "pointerdown" | "click"

export interface LockEventLike {
  type: string
  key?: string
  /** 事件目标；pointer/click 用它判断是否落在 Dialog 内容之外。 */
  target?: unknown
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
 * 进度子树是否应声明 Escape 所有权（宿主 data-owns-escape）。
 *
 * 这是比 window 捕获监听更可靠的 Escape 防线：宿主 `onKeyDown` 在 dispatch(dismiss)
 * 之前检查 `event.target.closest("[data-owns-escape]")`，命中即直接放行、不关闭 Dialog。
 * 因为判定在宿主 handler 内部，完全不受“插件监听器与宿主监听器的注册先后”影响。
 *
 * - 仅 running 时返回 true：done 后撤销标记，Escape 恢复正常关闭。
 * - keydown 的 event.target 是当前焦点元素；调用方须让焦点落在带该属性的子树内
 *   （进度内容根 tabindex=-1 + autofocus + onMount focus）。
 */
export function ownsEscapeWhileRunning(phase: "running" | "done"): boolean {
  return phase === "running"
}

/**
 * 是否应拦截该事件（preventDefault + stopImmediatePropagation）。
 */
export function shouldLockEvent(event: LockEventLike, ctx: LockContext): boolean {
  if (!ctx.running) return false

  if (event.type === "keydown") {
    // 只拦 Escape 键；其它按键（含 Tab 焦点遍历）正常放行。
    return event.key === "Escape"
  }

  if (event.type === "pointerdown" || event.type === "click") {
    // 无法判定内外时绝不全局拦截；只在确实是“外部”事件时拦下，阻止宿主据此关闭。
    return ctx.isOutside === true
  }

  return false
}
