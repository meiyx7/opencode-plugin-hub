/**
 * 进度 Dialog “外部点击关闭锁”的事件行为测试（纯函数级，覆盖真实 DOM handler 的全部判定分支）。
 *
 * 本组件只负责阻止执行期间的“外部点击关闭”：pointerdown / click 两类事件。
 * Escape 交给宿主 data-owns-escape 正式能力，不在此模块，也不在此测试。
 *
 * 这里直接测 shouldLockEvent 的判定（DOM handler 只负责把 event.target 换算成 isOutside），
 * 从而在不引入 jsdom（项目无此依赖、任务禁止新增依赖）的前提下，真实覆盖：
 * - 内部 pointerdown / click 放行；
 * - 外部 pointerdown / click 拦截；
 * - 无法识别内容元素时“不拦截”的安全回退；
 * - done 后全部放行；未知事件类型放行。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { shouldLockEvent } from "../src/gui/dialog-lock.ts"

const ptr = (type: "pointerdown" | "click" = "pointerdown") => ({ type })

// ---------------------------------------------------------------------------
// running：只拦 Dialog 内容之外的点击
// ---------------------------------------------------------------------------

test("1. running + Dialog 内部 pointerdown → 放行（正常交互不被拦截）", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: true, isOutside: false }), false)
})

test("2. running + Dialog 内部 click → 放行（正常交互不被拦截）", () => {
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: false }), false)
})

test("3. running + Dialog 外部 pointerdown → 拦截（不触发 backdrop/outside 关闭）", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: true, isOutside: true }), true)
})

test("4. running + Dialog 外部 click → 拦截（不触发覆盖层 backdrop.click）", () => {
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: true }), true)
})

test("5. 内容元素无法识别（isOutside=undefined）→ 不拦截，绝不全局锁定窗口", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: true, isOutside: undefined }), false)
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: undefined }), false)
})

// ---------------------------------------------------------------------------
// done：全部恢复正常关闭行为
// ---------------------------------------------------------------------------

test("6. done 后外部/内部 pointerdown、click 全部放行（外部点击可关闭）", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: false, isOutside: true }), false)
  assert.equal(shouldLockEvent(ptr("click"), { running: false, isOutside: true }), false)
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: false, isOutside: false }), false)
  assert.equal(shouldLockEvent(ptr("click"), { running: false, isOutside: false }), false)
})

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test("7. 未知事件类型不拦截", () => {
  assert.equal(shouldLockEvent({ type: "scroll" }, { running: true, isOutside: true }), false)
  assert.equal(shouldLockEvent({ type: "keydown" }, { running: true, isOutside: true }), false)
})
