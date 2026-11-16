/**
 * 前端操作反馈：**配置写成功不等于插件跑起来了**。
 *
 * 这里测两件事：
 * 1. explainMutation 对每种「配置阶段 × 运行时阶段」给出什么文案和什么语气；
 * 2. 五个入口（安装 / 更新 / 暂停 / 恢复 / 移除）确实都走同一个出口，没有哪个入口
 *    自己判断成功与否——否则「配置改了、运行时挂了」又会在某个按钮上报成绿色。
 *
 * 第 2 条是源码结构断言，不是 DOM 级点击测试（项目没有 jsdom），它能防的是「新加入口
 * 绕过统一出口」，防不了「Solid 渲染出错」，后者靠构建和预览核对。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { explainMutation, type MutationShape } from "../src/gui/feedback.ts"

const PAGE = readFileSync(join(process.cwd(), "src/gui", "page.tsx"), "utf8")

function result(overrides: Partial<MutationShape> & { stages?: MutationShape["stages"] }): MutationShape {
  return {
    ok: true,
    message: "服务端那句话",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 配置阶段 × 运行时阶段
// ---------------------------------------------------------------------------

test("01. 配置未改动 + 命令失败：报错误，并说明配置没动", () => {
  const report = explainMutation(
    result({ ok: false, stages: { command: "failed", config: "unchanged", runtime: "skipped" } }),
  )
  assert.match(report.text, /配置未改动/)
  assert.equal(report.tone, "error")
})

test("02. 配置写入失败：报错误，并说明写入未完成", () => {
  const report = explainMutation(
    result({ ok: false, stages: { command: "succeeded", config: "failed", runtime: "skipped" } }),
  )
  assert.match(report.text, /配置写入未完成/)
  assert.equal(report.tone, "error")
})

test("03. 配置已切换 + 运行时确认：成功，文案说清两者都已确认", () => {
  const report = explainMutation(
    result({ stages: { command: "succeeded", config: "updated", runtime: "loaded" } }),
  )
  assert.match(report.text, /配置已切换，运行时已确认/)
  assert.equal(report.tone, "success")
})

test("04. 配置已切换 + 运行时未知：警告，不能报成功", () => {
  const report = explainMutation(
    result({ stages: { command: "succeeded", config: "updated", runtime: "unknown" } }),
  )
  assert.match(report.text, /配置已切换，运行时未确认/)
  assert.equal(report.tone, "warning")
})

test("05. 配置已切换 + 运行时明确失败：错误，不能说成升级成功", () => {
  const report = explainMutation(
    result({ ok: false, stages: { command: "succeeded", config: "updated", runtime: "failed" } }),
  )
  assert.match(report.text, /配置已切换，但插件加载失败/)
  assert.equal(report.tone, "error")
})

test("06. 配置已切换 + 运行时仍是旧状态：警告", () => {
  const report = explainMutation(
    result({ ok: false, stages: { command: "succeeded", config: "updated", runtime: "unchanged" } }),
  )
  assert.match(report.text, /配置已切换，但运行时仍是旧状态/)
  assert.equal(report.tone, "warning")
})

test("07. 配置已切换 + 运行时尚未验证：警告", () => {
  const report = explainMutation(
    result({ stages: { command: "succeeded", config: "updated", runtime: "skipped" } }),
  )
  assert.match(report.text, /配置已切换，运行时尚未验证/)
  assert.equal(report.tone, "warning")
})

test("08. 配置未改动但操作本身成功（已装同版本）：不是失败，用成功语气", () => {
  const report = explainMutation(
    result({ ok: true, stages: { command: "succeeded", config: "unchanged", runtime: "skipped" } }),
  )
  assert.match(report.text, /配置未改动/)
  assert.equal(report.tone, "success")
})

// ---------------------------------------------------------------------------
// 回滚与传统字段
// ---------------------------------------------------------------------------

test("09. 新版本加载失败但回滚成功：警告，并明确说已回滚", () => {
  const report = explainMutation(
    result({
      ok: false,
      stages: { command: "succeeded", config: "updated", runtime: "failed", rollback: "succeeded" },
    }),
  )
  assert.match(report.text, /插件加载失败/)
  assert.match(report.text, /已回滚到原版本/)
  assert.equal(report.tone, "warning", "回滚成功说明状态是安全的，但这不是成功")
})

test("10. 回滚失败：错误，并且必须提示配置与运行时可能不一致", () => {
  const report = explainMutation(
    result({
      ok: false,
      stages: { command: "succeeded", config: "updated", runtime: "failed", rollback: "failed" },
    }),
  )
  assert.match(report.text, /回滚未成功/)
  assert.match(report.text, /配置与运行时可能不一致/)
  assert.equal(report.tone, "error")
})

test("11. 自升级已生效且运行时确认：仍然是警告（当前窗口是旧构建）", () => {
  const report = explainMutation(
    result({
      ok: true,
      selfUpdated: true,
      stages: { command: "succeeded", config: "updated", runtime: "loaded" },
    }),
  )
  assert.match(report.text, /配置已切换，运行时已确认/)
  assert.equal(report.tone, "warning")
})

test("12. 服务端没带 stages 时退回 ok + verification，不编造阶段结论", () => {
  const ok = explainMutation(result({ ok: true, verification: "已写入配置" }))
  assert.match(ok.text, /已写入配置/)
  assert.equal(ok.tone, "success")
  const bad = explainMutation(result({ ok: false }))
  assert.equal(bad.tone, "error")
})

test("13. 暂停这类中性操作用 info，但运行时未确认仍然升级为警告", () => {
  const neutral = explainMutation(
    result({ stages: { command: "skipped", config: "unchanged", runtime: "skipped" } }),
    "info",
  )
  assert.equal(neutral.tone, "info", "本来无需改动时保持中性语气")

  const pending = explainMutation(
    result({ stages: { command: "skipped", config: "updated", runtime: "unknown" } }),
    "info",
  )
  assert.equal(pending.tone, "warning", "info 不能盖过「运行时未确认」")
})

// ---------------------------------------------------------------------------
// 入口一致性：五个入口都从同一个出口出结果
// ---------------------------------------------------------------------------

function bodyOf(name: string): string {
  const start = PAGE.indexOf(`const ${name} = async`)
  assert.ok(start >= 0, `page.tsx 里找不到入口 ${name}`)
  const rest = PAGE.slice(start + 10)
  const end = rest.indexOf("\n  const ")
  return end < 0 ? rest : rest.slice(0, end)
}

test("14. 安装 / 更新 / 暂停 / 恢复 / 移除都通过 reportMutation 报告结果", () => {
  for (const entry of ["install", "updatePlugin", "pausePlugin", "resumePlugin", "uninstall"]) {
    assert.match(bodyOf(entry), /reportMutation\(result/, `${entry} 没有走统一出口`)
  }
})

test("15. 没有任何入口自己判断成功语气：mutation 结果不直接调 notify", () => {
  for (const entry of ["install", "updatePlugin", "pausePlugin", "resumePlugin", "uninstall"]) {
    const body = bodyOf(entry)
    assert.doesNotMatch(body, /notify\(\s*result\.message/, `${entry} 绕过了统一出口`)
    assert.doesNotMatch(body, /notify\([^)]*"success"/, `${entry} 自己定了成功语气`)
  }
})

test("16. 只有 reportMutation 调用 explainMutation，避免出现第二套解释", () => {
  const calls = PAGE.split("\n").filter((line) => line.includes("explainMutation("))
  assert.equal(calls.length, 1, `explainMutation 应该只被 reportMutation 调用，实际：\n${calls.join("\n")}`)
  assert.match(calls[0]!, /const report = explainMutation\(/)
  assert.match(PAGE, /import \{ explainMutation, type Tone \} from "\.\/feedback"/, "入口没有引用统一出口")
})
