/**
 * The rule engine on its own: what a config entry means as a control rule, and which rule wins.
 *
 * These are the semantics the pause/resume buttons rely on, and the ones that must never be
 * guessed — "which ID is disabled" is decided here, not by inspecting package names.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  disableRule,
  enableRule,
  evaluateRules,
  exactRulesFor,
  isControlSpec,
  parseControl,
  ruleMatches,
} from "../src/gui/rules.ts"

test("规则识别：官方的 -id / * / 前缀通配是规则，包名不是", () => {
  const rules = ["-acme.reviewer", "*", ".*", "acme.*", "acme.reviewer.*", "-acme.*", "-acme"]
  for (const spec of rules) {
    assert.equal(isControlSpec(spec), true, `${spec} 应识别为规则`)
  }
  const packages = ["foo@*", "@scope/foo@*", "foo@latest", "foo@^1.2.0", "opencode-notify", "@scope/foo", "./local", "", "-"]
  for (const spec of packages) {
    assert.equal(isControlSpec(spec), false, `${spec} 不是规则`)
  }
})

test("规则解析：去掉 - 前缀，保留原始写法与位置", () => {
  const rule = parseControl("-acme.reviewer", 3)
  assert.equal(rule?.negate, true)
  assert.equal(rule?.target, "acme.reviewer")
  assert.equal(rule?.scope, "exact")
  assert.equal(rule?.raw, "-acme.reviewer")
  assert.equal(rule?.index, 3)
  assert.equal(parseControl("opencode-notify", 0), undefined, "包名不是规则")
})

test("规则匹配：前缀通配覆盖子 ID，精确规则只覆盖自己", () => {
  const prefix = parseControl("-opencode.provider.*", 0)!
  assert.equal(ruleMatches(prefix, "opencode.provider.openai"), true)
  assert.equal(ruleMatches(prefix, "opencode.provider"), true)
  assert.equal(ruleMatches(prefix, "opencode.models.x"), false)

  const exact = parseControl("-acme.reviewer", 0)!
  assert.equal(ruleMatches(exact, "acme.reviewer"), true)
  assert.equal(ruleMatches(exact, "acme.reviewer.pro"), false, "精确规则不越界")
  assert.equal(ruleMatches(exact, "ACME.REVIEWER"), true, "ID 比较不区分大小写")

  const all = parseControl("*", 0)!
  assert.equal(ruleMatches(all, "anything.at.all"), true)
})

test("优先级：后写的规则赢，后面的裸 ID 可以重新启用", () => {
  const verdict = evaluateRules(["*", "-opencode.provider.*", "opencode.provider.openai", "-acme.reviewer"], "opencode.provider.openai")
  assert.equal(verdict.disabled, false, "文档里的例子：后面的裸 ID 重新启用它")
  assert.equal(verdict.rule?.raw, "opencode.provider.openai")
  assert.deepEqual(
    verdict.matches.map((rule) => rule.raw),
    ["*", "-opencode.provider.*", "opencode.provider.openai"],
    "命中三条：通配、前缀禁用、后面的裸 ID",
  )

  const disabled = evaluateRules(["-acme.reviewer", "acme.reviewer"], "acme.reviewer")
  assert.equal(disabled.disabled, false)
  const reDisabled = evaluateRules(["acme.reviewer", "-acme.reviewer"], "acme.reviewer")
  assert.equal(reDisabled.disabled, true)
})

test("没有任何规则提到它时，不虚构“已启用”", () => {
  const verdict = evaluateRules(["opencode-notify", "-other.plugin"], "some.plugin")
  assert.equal(verdict.disabled, false)
  assert.equal(verdict.rule, undefined, "没有命中规则，界面不该说出“被哪条规则启用”")
  assert.equal(verdict.matches.length, 0)
})

test("对象条目与其他形状不参与规则求值", () => {
  const entries = [{ package: "-acme", options: {} } as unknown as string]
  const verdict = evaluateRules(entries, "acme")
  assert.equal(verdict.matches.length, 0)
})

test("exactRulesFor 只挑精确规则，不碰通配", () => {
  const entries = ["-acme.reviewer", "-acme.*", "*", "acme.reviewer", "-other"]
  const exact = exactRulesFor(entries, ["acme.reviewer"])
  assert.deepEqual(
    exact.map((rule) => rule.raw),
    ["-acme.reviewer"],
    "只挑精确的禁用规则：通配不删，正向条目更不能删（那是插件本身）",
  )
})

test("暂停/恢复写出的规则形状固定", () => {
  assert.equal(disableRule("plugin-hub"), "-plugin-hub")
  assert.equal(enableRule("plugin-hub"), "plugin-hub")
})
