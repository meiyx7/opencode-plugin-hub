/**
 * 详情 Dialog 关闭后进度残留修复的回归测试。
 *
 * 问题：详情 Dialog 的 onClose 原先只 dialog.close()，不清 progress；重开同一插件详情时
 * 仍命中旧进度，误显示上一次安装/更新结果。独立进度 Dialog 的 onClose 已有清理逻辑。
 *
 * 修复决策抽成纯函数 shouldClearProgress（按包名匹配 + 仅 phase=done 才清），此处：
 * - 纯函数覆盖场景 A/B/C/D 的判定；
 * - 源码结构断言覆盖「详情 onClose 已接线」「独立 Dialog 清理逻辑未变」「执行期锁未被破坏」。
 * 项目无 jsdom，真实 DOM 点击由宿主交互清单（docs）记录为未验证，不在此冒充。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { shouldClearProgress } from "../src/gui/progress-view.ts"

const PAGE = readFileSync(join(process.cwd(), "src/gui", "page.tsx"), "utf8")

const done = (name: string) => ({ op: { name }, phase: "done" as const })
const running = (name: string) => ({ op: { name }, phase: "running" as const })

// ---------------------------------------------------------------------------
// 纯函数判定：场景 A/B/C/D
// ---------------------------------------------------------------------------

test("A. 详情页安装完成后关闭：相同包 + done → 清理", () => {
  assert.equal(shouldClearProgress(done("opencode-notify"), "opencode-notify"), true)
})

test("B. 详情页更新完成后关闭：install/update 都是 done，按包名清理（与 kind 无关）", () => {
  assert.equal(shouldClearProgress(done("opencode-usage-center"), "opencode-usage-center"), true)
})

test("C. 失败后关闭：done（失败也是已结束）→ 清理，不残留失败进度", () => {
  // 失败/成功都属于 phase=done，只是 report.tone 不同；清理只看 phase。
  assert.equal(shouldClearProgress(done("opencode-notify"), "opencode-notify"), true)
})

test("D. 操作期间不清理：running → 不清理（关闭被锁住，Promise 不受影响）", () => {
  assert.equal(shouldClearProgress(running("opencode-notify"), "opencode-notify"), false)
})

test("D2. 没有进度时关闭详情：不清理（无需动作）", () => {
  assert.equal(shouldClearProgress(undefined, "opencode-notify"), false)
})

test("F. 只清理对应包：别的包在跑/已完成，不能误清", () => {
  assert.equal(shouldClearProgress(done("plugin-B"), "plugin-A"), false)
  assert.equal(shouldClearProgress(running("plugin-B"), "plugin-A"), false)
})

// ---------------------------------------------------------------------------
// 源码结构：接线未被遗漏、既有逻辑未被破坏
// ---------------------------------------------------------------------------

test("E1. 详情 onClose 已接入条件清理（shouldClearProgress + setProgress(undefined)）", () => {
  const start = PAGE.indexOf("const openDetail =")
  assert.ok(start >= 0)
  const block = PAGE.slice(start, start + 1200)
  assert.match(block, /shouldClearProgress\(progress\(\), name\)/, "详情关闭未调用清理判定")
  assert.match(block, /setProgress\(undefined\)/, "详情关闭未清理进度")
  assert.match(block, /dialog\.close\(\)/, "详情关闭仍要关闭 Dialog")
})

test("E2. 独立进度 Dialog 的清理逻辑未变", () => {
  const start = PAGE.indexOf("const openStandaloneProgress =")
  assert.ok(start >= 0)
  const block = PAGE.slice(start, start + 500)
  assert.match(block, /setProgress\(undefined\)/, "独立 Dialog 关停止清理进度")
  assert.match(block, /dialog\.close\(\)/, "独立 Dialog 关闭未关 Dialog")
})

test("E3. 执行期关闭锁仍在（Escape/外部点击/关闭按钮）", () => {
  assert.match(PAGE, /useLockDialogWhileRunning/, "缺少执行期关闭锁")
  assert.match(PAGE, /closable=\{!running\(\)\}/, "独立 Dialog 执行期未隐藏关闭按钮")
  assert.match(PAGE, /closable=\{!progressRunning\(\)\}/, "详情 Dialog 执行期未隐藏关闭按钮")
})

test("E4. 清理只改界面状态：onClose 内不触发 loadRuntime/checkUpdates/重复关闭", () => {
  const start = PAGE.indexOf("const openDetail =")
  const block = PAGE.slice(start, start + 1200)
  // 关闭回调里不应重新拉取运行事实或检查结果，也不应重复 close。
  assert.doesNotMatch(block, /onClose[\s\S]{0,300}loadRuntime/, "关闭时不应触发运行时刷新")
  assert.doesNotMatch(block, /onClose[\s\S]{0,300}checkUpdates/, "关闭时不应触发更新检查")
  const closeCalls = (block.match(/dialog\.close\(\)/g) ?? []).length
  assert.equal(closeCalls, 1, "关闭回调应只调用一次 dialog.close()")
})
