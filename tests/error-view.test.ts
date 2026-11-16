/**
 * TASK-06 异常反馈分类：不同异常给出不同可读文案，且保留底层原因。
 * 纯函数测试，不涉及 DOM 或真实文件系统。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { classifyError } from "../src/gui/error-view.ts"

test("01. 版本不一致：提示重载，不甩 SchemaError 原文", () => {
  const r = classifyError(new Error("SchemaError(Missing key at plugins[0])"))
  assert.equal(r.kind, "version-mismatch")
  assert.match(r.text, /重新加载/)
  assert.doesNotMatch(r.text, /SchemaError/)
})

test("02. 旧接口：提示后台服务版本旧", () => {
  const r = classifyError("unknown method: plugin.foobar")
  assert.equal(r.kind, "version-mismatch")
  assert.match(r.text, /旧版本/)
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
