/**
 * TASK-06 异常反馈分类：不同异常给出不同可读文案，且保留底层原因。
 * 纯函数测试，不涉及 DOM 或真实文件系统。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { classifyError } from "../src/gui/error-view.ts"

test("01. 结构不兼容：如实说明并保留原始错误，重载只作人工建议而非结论", () => {
  const raw = "SchemaError(Missing key at plugins[0])"
  const r = classifyError(new Error(raw))
  assert.equal(r.kind, "schema-mismatch")
  assert.match(r.text, /数据结构.*不一致/, "如实说明接口数据结构不兼容")
  assert.match(r.text, /SchemaError\(Missing key at plugins\[0\]\)/, "保留原始错误，不丢诊断信息")
  assert.match(r.text, /重新加载 OpenCode 插件/, "把重新加载作为人工排查建议")
  assert.match(r.text, /不代表已确认版本不一致/, "不断言一定存在版本不一致")
  assert.match(r.text, /不代表必须重载/, "不断言必须重载")
  assert.doesNotMatch(r.text, /需要 OpenCode 重新加载/, "不再使用下结论式的旧文案")
})

test("02. no method：保留真实错误、给恢复建议，但不判定必须重启、不归咎版本/registry", () => {
  const raw = 'Ipc "plugin-hub.admin" is unavailable: no method "officialUpdates"'
  const r = classifyError(raw)
  assert.equal(r.kind, "ipc-unavailable")
  assert.match(r.text, /插件接口暂不可用/, "给出明确的错误说明")
  assert.match(r.text, /重新加载 OpenCode 插件/, "给出人工恢复建议")
  assert.match(r.text, /重新启动 OpenCode/, "给出人工恢复建议")
  assert.match(r.text, /不代表系统已经确认必须重启/, "仅为建议，不推断必须重启")
  assert.match(r.text, /no method "officialUpdates"/, "保留官方 IPC 返回的真实错误")
  assert.doesNotMatch(r.text, /旧版本|registry/i, "不归咎版本不一致或 npm Registry")
})

test("02b. Provider 不可用同样按官方 IPC 错误展示真实原因", () => {
  const raw = 'Ipc "plugin-hub.admin" is unavailable: no provider'
  const r = classifyError(raw)
  assert.equal(r.kind, "ipc-unavailable")
  assert.match(r.text, /插件接口暂不可用/)
  assert.match(r.text, /no provider/, "保留真实错误")
})

test("03. 网络异常：提示网络/registry，并保留原始诊断", () => {
  const raw = "fetch failed: ECONNREFUSED 127.0.0.1:443"
  const r = classifyError(new Error(raw))
  assert.equal(r.kind, "network")
  assert.match(r.text, /网络|registry/)
  assert.match(r.text, /ECONNREFUSED/, "保留底层原因")
})

test("04. 权限异常：提示权限，不伪装成配置损坏", () => {
  const r = classifyError(new Error("EACCES: permission denied, open opencode.json"))
  assert.equal(r.kind, "permission")
  assert.match(r.text, /权限/)
})

test("05. 配置异常：提示未做修改，避免损坏配置", () => {
  const r = classifyError(new Error("配置文件无法解析：unexpected token"))
  assert.equal(r.kind, "config")
  assert.match(r.text, /配置文件异常|未做修改/)
})

test("06. 版本异常：提示版本不可用/不存在", () => {
  const r = classifyError(new Error("No matching version found for opencode-notify@9.9.9"))
  assert.equal(r.kind, "version")
  assert.match(r.text, /版本/)
})

test("07. 未知异常：原样保留文本，不臆造分类", () => {
  const raw = "something unexpected happened"
  const r = classifyError(raw)
  assert.equal(r.kind, "unknown")
  assert.equal(r.text, raw)
})

test("08. 不同异常不会得到同一个提示", () => {
  const kinds = [
    classifyError("SchemaError x").text,
    classifyError("fetch failed").text,
    classifyError("EACCES denied").text,
    classifyError("No matching version found").text,
  ]
  assert.equal(new Set(kinds).size, kinds.length, "四类异常文案应各不相同")
})
