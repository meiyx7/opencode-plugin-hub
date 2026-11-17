/**
 * 安装 / 更新进度 Dialog 的阶段与结果映射（纯函数，无 DOM）。
 *
 * 核心契约（来自任务约束）：
 * - 执行期间只显示“正在执行官方命令”一个进行中状态，不预支阶段为完成、不显示百分比；
 * - 阶段状态只来自后端 result.stages，不在结果回来前宣称任何阶段完成；
 * - 配置成功 ≠ 运行成功：runtime=unknown/failed 分别映射为“未确认/失败”，不冒报成功；
 * - 回滚只在后端确实报告时出现，不虚构必经步骤；
 * - 结果语气沿用 explainMutation 的统一出口，本模块不重复解释（也不 import 它）。
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  buildProgressReport,
  runningSteps,
  type ProgressInput,
  type ProgressMutation,
} from "../src/gui/progress-view.ts"

function input(overrides: Partial<ProgressInput> = {}): ProgressInput {
  return {
    kind: "update",
    name: "opencode-usage-center",
    from: "0.3.1",
    to: "0.3.2",
    selfUpdate: false,
    mutationTone: "success",
    mutationText: "更新成功",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 执行中：不预支阶段、不伪造进度
// ---------------------------------------------------------------------------

test("01. 执行中只有一个进行中阶段，其余待执行（无百分比/定时器痕迹）", () => {
  const steps = runningSteps(input())
  assert.equal(steps.filter((s) => s.state === "running").length, 1)
  assert.equal(steps.filter((s) => s.state === "done").length, 0)
  assert.equal(steps.every((s) => !/%|剩余|秒|MB/.test(s.desc)), true)
  assert.match(steps[0]!.desc, /官方命令/)
})

test("02. 安装与更新的进行中阶段标题不同，符合实际操作", () => {
  assert.equal(runningSteps(input({ kind: "install" }))[0]!.title, "执行安装命令")
  assert.equal(runningSteps(input({ kind: "update" }))[0]!.title, "执行更新命令")
})

// ---------------------------------------------------------------------------
// 结果阶段：完全来自 result.stages
// ---------------------------------------------------------------------------

test("03. 全成功：三阶段 done，结论 success", () => {
  const result: ProgressMutation = {
    ok: true,
    message: "已更新",
    stages: { command: "succeeded", config: "updated", runtime: "loaded", version: "0.3.2" },
  }
  const report = buildProgressReport(input(), result)
  assert.equal(report.tone, "success")
  assert.deepEqual(report.steps.map((s) => s.state), ["done", "done", "done"])
  assert.equal(report.rows.find((r) => r.key === "运行状态")!.value, "已加载")
})

test("04. 命令失败：命令阶段 failed，结论随统一语气 error→failed，节点就地展示真实错误", () => {
  const report = buildProgressReport(
    input({ mutationTone: "error", mutationText: "安装失败（CLI：NpmInstallFailedError）" }),
    { ok: false, message: "失败", stages: { command: "failed", config: "unchanged", runtime: "skipped" } },
  )
  assert.equal(report.tone, "failed")
  assert.equal(report.steps[0]!.state, "failed")
  assert.match(report.steps[0]!.desc, /失败/)
  assert.equal(report.steps[0]!.error, "安装失败（CLI：NpmInstallFailedError）", "失败节点携带真实错误")
})

test("05. 配置成功但运行未确认：runtime→unknown，不冒报成功", () => {
  const report = buildProgressReport(
    input({ mutationTone: "warning", mutationText: "配置已切换，运行时未确认" }),
    { ok: true, message: "更新完成", stages: { command: "succeeded", config: "updated", runtime: "unknown", version: "0.3.2" } },
  )
  assert.equal(report.tone, "attention")
  assert.equal(report.steps[2]!.state, "unknown")
  assert.equal(report.rows.find((r) => r.key === "运行状态")!.value, "未确认")
})

test("06. 配置成功但运行失败：runtime→failed，判失败", () => {
  const report = buildProgressReport(
    input({ mutationTone: "error", mutationText: "插件加载失败" }),
    { ok: false, message: "更新完成但加载失败", stages: { command: "succeeded", config: "updated", runtime: "failed" } },
  )
  assert.equal(report.tone, "failed")
  assert.equal(report.steps[2]!.state, "failed")
  assert.equal(report.rows.find((r) => r.key === "运行状态")!.value, "加载失败")
})

// ---------------------------------------------------------------------------
// 自身更新：独立阶段 + 回滚只在后端报告时出现
// ---------------------------------------------------------------------------

test("07. 自身更新执行中：准备阶段进行中，含切换与加载确认", () => {
  const steps = runningSteps(input({ kind: "update", selfUpdate: true, name: "opencode-plugin-hub" }))
  assert.equal(steps[0]!.title, "准备并校验目标版本")
  assert.equal(steps[0]!.state, "running")
  assert.deepEqual(steps.map((s) => s.title), ["准备并校验目标版本", "切换配置", "加载确认"])
})

test("08. 自身更新成功：三阶段 done，无回滚阶段", () => {
  const report = buildProgressReport(
    input({ kind: "update", selfUpdate: true, name: "opencode-plugin-hub", mutationTone: "warning", mutationText: "已升级，当前窗口仍为旧构建" }),
    { ok: true, message: "已升级", stages: { command: "succeeded", config: "updated", runtime: "loaded", version: "0.6.1" } },
  )
  assert.deepEqual(report.steps.map((s) => s.title), ["准备并校验目标版本", "核验插件配置", "确认运行状态"])
  assert.equal(report.steps.every((s) => s.state === "done"), true)
  assert.equal(report.steps.some((s) => s.title === "回滚处理"), false)
})

test("09. 回滚只在后端报告时出现：succeeded→done，failed→failed", () => {
  const ok = buildProgressReport(
    input({ selfUpdate: true, mutationTone: "warning", mutationText: "已回滚" }),
    { ok: false, message: "加载失败", stages: { command: "succeeded", config: "updated", runtime: "failed", rollback: "succeeded", version: "0.6.1" } },
  )
  assert.equal(ok.steps.find((s) => s.title === "回滚处理")!.state, "done")
  assert.equal(ok.rows.find((r) => r.key === "回滚")!.value, "已回滚")

  const bad = buildProgressReport(
    input({ selfUpdate: true, mutationTone: "error", mutationText: "回滚未成功" }),
    { ok: false, message: "加载失败", stages: { command: "succeeded", config: "updated", runtime: "failed", rollback: "failed", version: "0.6.1" } },
  )
  assert.equal(bad.steps.find((s) => s.title === "回滚处理")!.state, "failed")
  assert.equal(bad.tone, "failed")
})

test("10. rollback=none 不展示回滚阶段", () => {
  const report = buildProgressReport(
    input({ selfUpdate: true }),
    { ok: true, message: "完成", stages: { command: "succeeded", config: "updated", runtime: "loaded", rollback: "none" } },
  )
  assert.equal(report.steps.some((s) => s.title === "回滚处理"), false)
})

test("11. 缺少 stages（旧后端）不冒报成功，阶段标记未取得", () => {
  const report = buildProgressReport(input(), { ok: true, message: "完成" })
  assert.equal(report.steps[0]!.state, "unknown")
  assert.equal(report.rows.find((r) => r.key === "命令执行")!.value, "未确认")
})

test("12. 结论文案与语气沿用统一出口入参，不二次解释", () => {
  const report = buildProgressReport(
    input({ mutationTone: "warning", mutationText: "配置已切换，运行时仍是旧状态" }),
    { ok: true, message: "更新完成", stages: { command: "succeeded", config: "updated", runtime: "unchanged" } },
  )
  assert.equal(report.summary, "配置已切换，运行时仍是旧状态")
  assert.equal(report.tone, "attention")
})
