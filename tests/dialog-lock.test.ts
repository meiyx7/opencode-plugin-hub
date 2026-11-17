/**
 * 进度 Dialog 关闭锁的“事件行为”测试（纯函数级，覆盖真实 DOM handler 的全部判定分支）。
 *
 * 背景缺陷：旧实现在 window 捕获阶段对任意 pointerdown 都 preventDefault+stopImmediatePropagation，
 * 等于锁死整个 OpenCode 窗口，连 Dialog 内部按钮都点不了。
 *
 * 这里直接测 shouldLockEvent 的判定（DOM handler 只负责把 event.target 换算成 isOutside），
 * 从而在不引入 jsdom（项目无此依赖、任务禁止新增依赖）的前提下，真实覆盖：
 * - 内部点击不被拦截、外部点击被拦截、Escape 被拦截、其它键放行、
 * - done 后全部放行；以及内容元素无法识别时“不拦截”的安全回退。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ownsEscapeWhileRunning, shouldLockEvent } from "../src/gui/dialog-lock.ts"

const key = (k: string) => ({ type: "keydown", key: k })
const ptr = (type: "pointerdown" | "click" = "pointerdown") => ({ type })

// ---------------------------------------------------------------------------
// running：只拦会影响关闭的事件
// ---------------------------------------------------------------------------

test("1. running + Escape → 拦截（不关闭 Dialog）", () => {
  assert.equal(shouldLockEvent(key("Escape"), { running: true, isOutside: undefined }), true)
})

test("2. running + 非 Escape 键（含 Tab / Enter）→ 放行，不破坏键盘交互", () => {
  for (const k of ["Tab", "Enter", "ArrowDown", "a", "Shift"]) {
    assert.equal(shouldLockEvent(key(k), { running: true, isOutside: undefined }), false, `${k} 不应被拦`)
  }
})

test("3. running + Dialog 内部 pointerdown → 放行（正常交互不被拦截）", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: true, isOutside: false }), false)
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: false }), false)
})

test("4. running + Dialog 外部 pointerdown/click → 拦截（不触发 backdrop 关闭）", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: true, isOutside: true }), true)
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: true }), true)
})

test("5. 内容元素无法识别（isOutside=undefined）→ 不拦截，绝不全局锁定窗口", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: true, isOutside: undefined }), false)
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: undefined }), false)
})

// ---------------------------------------------------------------------------
// done：全部恢复正常关闭行为
// ---------------------------------------------------------------------------

test("6. done 后 Escape 放行", () => {
  assert.equal(shouldLockEvent(key("Escape"), { running: false, isOutside: undefined }), false)
})

test("7. done 后外部/内部 pointerdown、click 全部放行（外部点击可关闭）", () => {
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: false, isOutside: true }), false)
  assert.equal(shouldLockEvent(ptr("click"), { running: false, isOutside: true }), false)
  assert.equal(shouldLockEvent(ptr("pointerdown"), { running: false, isOutside: false }), false)
})

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test("8. 未知事件类型不拦截", () => {
  assert.equal(shouldLockEvent({ type: "scroll" }, { running: true, isOutside: true }), false)
})

test("9. 内部交互在运行期始终通行：按钮点击（click, isOutside=false）不被拦", () => {
  // 直接对应“详情/独立 Dialog 内点关闭以外的按钮、滚动、文本选择”等正常交互。
  assert.equal(shouldLockEvent(ptr("click"), { running: true, isOutside: false }), false)
})

// ---------------------------------------------------------------------------
// Escape 防线：宿主 data-owns-escape（不依赖监听器注册顺序）
// ---------------------------------------------------------------------------

test("10. Escape 所有权只在 running 时声明，done 后撤销（恢复正常关闭）", () => {
  assert.equal(ownsEscapeWhileRunning("running"), true, "执行期必须声明，宿主才会放行而不 dismiss")
  assert.equal(ownsEscapeWhileRunning("done"), false, "完成后必须撤销，Escape 才能正常关闭")
})

test("11. Escape 防线在宿主 handler 内部，不依赖插件监听注册先后（源码结论固化为断言）", () => {
  // 源码事实（docs/host-interaction-verification.md）：宿主 onKeyDown 在 dispatch(dismiss) 之前
  // 检查 event.target.closest("[data-owns-escape]")，命中即 return；且宿主不检查 defaultPrevented。
  // 因此 window 捕获的 stopImmediatePropagation 对“先注册的宿主监听”无效，data-owns-escape 才可靠。
  // 这里断言我们确实依赖该正式能力而非仅靠事件拦截。
  const page = readFileSync(join(process.cwd(), "src/gui", "page.tsx"), "utf8")
  assert.match(page, /data-owns-escape=\{ownsEscapeWhileRunning\(/, "进度根未使用宿主 data-owns-escape 正式能力")
  assert.match(page, /autofocus[\s\S]{0,120}tabindex="-1"/, "焦点未引导到进度子树内（keydown target 命中前缀）")
  assert.match(page, /onMount\(\(\) => rootEl\?\.focus/, "挂载后未主动把焦点置于进度子树")
})

test("12. window keydown 仍作纵深防御，但 Escape 关闭锁主防线是 data-owns-escape", () => {
  // 即使 window 捕获监听因注册顺序失效，data-owns-escape 仍能让宿主自行放行。
  const lock = readFileSync(join(process.cwd(), "src/gui", "dialog-lock.ts"), "utf8")
  assert.match(lock, /data-owns-escape/, "未记录正式能力说明")
  assert.match(lock, /不受.*注册先后|注册先后/, "未说明不依赖注册顺序")
})
