/**
 * TASK-05 统一状态模型：对每种状态构造数据，验证判定准确、排序语义不变。
 * 这些是纯函数测试，确保列表徽章 / 摘要 / 排序与详情共用同一套口径。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { classifyState, severityOf, needsAttention, type StatusEntry, type StatusInput } from "../src/gui/status-view.ts"

const pkg: StatusEntry = { kind: "package", spec: "opencode-notify" }
const rt = (over: Partial<StatusInput["runtime"]> = {}): StatusInput["runtime"] => ({ available: true, ...over })

// ---------------------------------------------------------------------------
// 状态判定
// ---------------------------------------------------------------------------

test("01. 配置规则项：control / enable-rule / rule 标记一律返回规则状态", () => {
  assert.equal(classifyState({ kind: "control", spec: "-x" }, {}), "control")
  assert.equal(classifyState({ kind: "enable-rule", spec: "x" }, {}), "rule")
  assert.equal(classifyState({ kind: "package", spec: "x", rule: true }, {}), "rule")
})

test("02. 明确暂停优先于运行事实（被规则禁用时运行时不报告是正常现象）", () => {
  assert.equal(classifyState(pkg, { runtimeError: "", runtime: rt({ paused: true, status: "loaded" }) }), "paused")
})

test("03. 运行事实：loaded / failed 如实判定", () => {
  assert.equal(classifyState(pkg, { runtimeError: "", runtime: rt({ status: "loaded" }) }), "loaded")
  assert.equal(classifyState(pkg, { runtimeError: "", runtime: rt({ status: "failed" }) }), "failed")
})

test("04. 无 runtime 记录：读取未出错=待加载，读取出错=未验证（不误判为已安装/正常）", () => {
  assert.equal(classifyState(pkg, { runtimeError: "" }), "pending")
  assert.equal(classifyState(pkg, { runtimeError: "runtime 读取失败" }), "unknown")
})

test("05. 服务端应答但列表无记录：available=待加载，不可用=未验证", () => {
  assert.equal(classifyState(pkg, { runtimeError: "", runtime: rt({ status: "unknown", available: true }) }), "pending")
  assert.equal(classifyState(pkg, { runtimeError: "", runtime: rt({ status: "unknown", available: false }) }), "unknown")
})

test("06. 网络/版本查询失败不会把状态判成“已加载”（异常不被正常覆盖）", () => {
  const state = classifyState(pkg, { runtimeError: "连接失败", runtime: undefined })
  assert.equal(state, "unknown")
  assert.notEqual(state, "loaded")
})

// ---------------------------------------------------------------------------
// 排序语义：严格保持 失败→待加载→可更新→未验证→已暂停→正常→规则
// ---------------------------------------------------------------------------

test("07. 严重程度顺序严格保持既有语义", () => {
  assert.ok(severityOf("failed", false) < severityOf("pending", false))
  assert.ok(severityOf("pending", false) < severityOf("pending", true)) // 可更新(2) 在待加载(1)之后
  assert.ok(severityOf("pending", true) < severityOf("unknown", false)) // 可更新(2) 在未验证(3)之前
  assert.ok(severityOf("unknown", false) < severityOf("paused", false))
  assert.ok(severityOf("paused", false) < severityOf("loaded", false))
  assert.ok(severityOf("loaded", false) < severityOf("rule", false))
  assert.equal(severityOf("control", false), severityOf("rule", false))
})

test("08. 有更新的正常插件排在普通正常插件之前", () => {
  assert.ok(severityOf("loaded", true) < severityOf("loaded", false))
})

// ---------------------------------------------------------------------------
// 摘要纳入口径
// ---------------------------------------------------------------------------

test("09. 只有问题项进入“需要关注”，正常/规则不进入", () => {
  assert.equal(needsAttention("failed"), true)
  assert.equal(needsAttention("pending"), true)
  assert.equal(needsAttention("unknown"), true)
  assert.equal(needsAttention("paused"), true)
  assert.equal(needsAttention("loaded"), false)
  assert.equal(needsAttention("rule"), false)
  assert.equal(needsAttention("control"), false)
})
