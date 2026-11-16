/**
 * 已安装页「需要关注」摘要：只展示“数量 > 0”的状态，全部为 0 时整块消失。
 *
 * 这是纯函数（buildAttentionItems）的单元测试，不走 DOM：
 * 组件渲染时只用这个函数产出的数组决定要不要渲染、渲染哪几项，
 * 所以这里断言清楚，就等价于界面上「没有内容就不出现」。
 *
 * 重点覆盖需求里的几条硬规则：
 * - 全 0 → 空数组（界面据此不渲染整个摘要）；
 * - 单项/多项的正确显示；
 * - 数量从 >0 变 0 → 该项消失；
 * - 统计的是全量，不是“过滤/搜索后”的局部数量（由调用方传入全量计数保证）。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { buildAttentionItems } from "../src/gui/attention.ts"

test("01. 全部状态为 0 时返回空数组", () => {
  assert.deepEqual(
    buildAttentionItems({ failed: 0, pending: 0, update: 0, paused: 0, unknown: 0 }),
    [],
  )
})

test("02. 只有加载失败 2：只显示这一项", () => {
  assert.deepEqual(buildAttentionItems({ failed: 2, pending: 0, update: 0, paused: 0, unknown: 0 }), [
    { id: "failed", label: "加载失败", count: 2, tone: "danger" },
  ])
})

test("03. 失败 / 更新 / 暂停同时存在：只显示这三项且顺序固定", () => {
  assert.deepEqual(
    buildAttentionItems({ failed: 1, pending: 0, update: 3, paused: 1, unknown: 0 }),
    [
      { id: "failed", label: "加载失败", count: 1, tone: "danger" },
      { id: "update", label: "可更新", count: 3, tone: "warning" },
      { id: "paused", label: "已暂停", count: 1, tone: "accent" },
    ],
  )
})

test("04. 五项全部存在：按严重程度顺序输出 5 项", () => {
  const items = buildAttentionItems({ failed: 1, pending: 2, update: 3, paused: 1, unknown: 2 })
  assert.deepEqual(
    items.map((item) => item.id),
    ["failed", "pending", "update", "paused", "unknown"],
  )
  assert.equal(items[0]!.count, 1)
  assert.equal(items[1]!.count, 2)
  assert.equal(items[2]!.count, 3)
})

test("05. 数量从大于 0 变为 0：该项立即消失", () => {
  const before = buildAttentionItems({ failed: 1, pending: 0, update: 2, paused: 0, unknown: 0 })
  assert.equal(before.some((item) => item.id === "failed"), true)
  const after = buildAttentionItems({ failed: 0, pending: 0, update: 2, paused: 0, unknown: 0 })
  assert.equal(after.some((item) => item.id === "failed"), false)
  assert.deepEqual(
    after.map((item) => item.id),
    ["update"],
  )
})

test("06. 最后一项消失后整个摘要为空", () => {
  assert.equal(buildAttentionItems({ failed: 0, pending: 0, update: 1, paused: 0, unknown: 0 }).length, 1)
  assert.equal(buildAttentionItems({ failed: 0, pending: 0, update: 0, paused: 0, unknown: 0 }).length, 0)
})

test("07. 负数按 0 处理（不会误产出负数的异常项）", () => {
  // 口径上计数不应为负；这里防御一下，避免异常值渲染出怪异行。
  assert.deepEqual(buildAttentionItems({ failed: -1, pending: 0, update: 0, paused: 0, unknown: 0 }), [])
})

test("08. 待加载与未验证单独存在时语气正确", () => {
  assert.deepEqual(buildAttentionItems({ failed: 0, pending: 1, update: 0, paused: 0, unknown: 0 }), [
    { id: "pending", label: "待加载", count: 1, tone: "accent" },
  ])
  assert.deepEqual(buildAttentionItems({ failed: 0, pending: 0, update: 0, paused: 0, unknown: 1 }), [
    { id: "unknown", label: "未验证", count: 1, tone: "warning" },
  ])
})