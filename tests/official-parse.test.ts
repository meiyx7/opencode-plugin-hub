/**
 * Parsers for the two official read commands, tested against the output the CLI actually printed
 * on this machine (columns, `-` placeholders, `local` for directory plugins, scoped IDs).
 *
 * The important property is not "it parses"; it is "it never invents an answer". A line it does not
 * recognise becomes `unknown`, and a row the CLI did not report is never turned into "up to date".
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  packageNameOf,
  parsePluginCheck,
  parsePluginList,
  parsePluginUpdate,
  isPathSource,
} from "../src/gui/official-parse.js"

const LIST = `ID                                         VERSION  SOURCE
@magpie-community/opencode-qoder-auth      0.2.68   @magpie-community/opencode-qoder-auth@0.2.68
opencode-notify-callback                   0.1.2    opencode-mobile-notifications
opencode-schedule-center                   0.1.15   opencode-schedule-center@0.1.15
opencode-trae-auth-multi                   local    /Users/meiyx/.config/opencode/local-plugins/trae-auth-multi
plugin-hub                                 0.4.0    opencode-plugin-hub@0.4.0
`

test("plugin list：解析 ID、版本与来源，本地目录带 local 版本", () => {
  const rows = parsePluginList(LIST)
  assert.equal(rows.length, 5)
  const hub = rows.find((row) => row.id === "plugin-hub")!
  assert.equal(hub.version, "0.4.0")
  assert.equal(hub.source, "opencode-plugin-hub@0.4.0")
  assert.equal(hub.kind, "package")

  const local = rows.find((row) => row.source.endsWith("trae-auth-multi"))!
  assert.equal(local.id, "opencode-trae-auth-multi")
  assert.equal(local.version, "local")
  assert.equal(local.kind, "path")

  const notify = rows.find((row) => row.id === "opencode-notify-callback")!
  assert.equal(notify.source, "opencode-mobile-notifications", "ID 与包名不同也要照实记录")
})

test("plugin list：未加载的条目用 - 占位，不能当成 ID", () => {
  const rows = parsePluginList("ID  VERSION  SOURCE\n-   -        opencode-notify\n")
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, "", "- 是“没加载”，不是插件 ID")
  assert.equal(rows[0]!.version, "")
  assert.equal(rows[0]!.source, "opencode-notify")
})

test("plugin list：空列表与无关输出不产生行", () => {
  assert.deepEqual(parsePluginList("No plugins found\n"), [])
  assert.deepEqual(parsePluginList(""), [])
  assert.deepEqual(parsePluginList("Error: Server process exited with code 1\n"), [])
})

test("plugin list：分段标题被记录，不当作行", () => {
  const rows = parsePluginList("Server\n  plugin-hub  0.4.0  opencode-plugin-hub@0.4.0\n")
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.section, "Server")
  assert.equal(rows[0]!.id, "plugin-hub")
})

test("包名拆分：scoped 名称只在第二个 @ 处断开", () => {
  assert.equal(packageNameOf("@scope/name@1.2.3"), "@scope/name")
  assert.equal(packageNameOf("plain@latest"), "plain")
  assert.equal(packageNameOf("plain"), "plain")
  assert.equal(isPathSource("/abs/path"), true)
  assert.equal(isPathSource("./relative"), true)
  assert.equal(isPathSource("plain"), false)
})

const CHECK = `Server
  opencode-notify-callback 0.1.2 (current)
  usage-center 0.2.0 (current)
  plugin-hub (check failed)
Failed to check Server plugin "plugin-hub": Plugin must export a default definition
`

test("plugin check：current 行带版本，failed 行不带版本并附上原因", () => {
  const rows = parsePluginCheck(CHECK)
  const notify = rows.find((row) => row.id === "opencode-notify-callback")!
  assert.equal(notify.status, "current")
  assert.equal(notify.version, "0.1.2")

  const hub = rows.find((row) => row.id === "plugin-hub")!
  assert.equal(hub.status, "failed")
  assert.match(hub.note, /must export a default definition/)
})

test("plugin check：有更新时取 CLI 给的第二个版本，而不是猜 registry", () => {
  const arrows = parsePluginCheck("Server\n  usage-center 0.2.0 → 0.3.2\n")
  assert.equal(arrows[0]!.status, "outdated")
  assert.equal(arrows[0]!.version, "0.2.0")
  assert.equal(arrows[0]!.latest, "0.3.2")

  const ascii = parsePluginCheck("Server\n  usage-center 0.2.0 -> 0.3.2\n")
  assert.equal(ascii[0]!.latest, "0.3.2")

  const labelled = parsePluginCheck("Server\n  usage-center 0.2.0 (outdated, latest 0.3.2)\n")
  assert.equal(labelled[0]!.status, "outdated")
  assert.equal(labelled[0]!.latest, "0.3.2")
})

test("plugin check：认不出的行是 unknown，绝不报成“最新”", () => {
  const rows = parsePluginCheck("Server\n  usage-center 0.2.0 weird new column\n")
  assert.equal(rows[0]!.status, "unknown")
  assert.match(rows[0]!.note, /weird new column/)
})

test("plugin check：只报失败的插件也要出现，不能悄悄丢掉", () => {
  const rows = parsePluginCheck('Server\nFailed to check Server plugin "ghost": boom\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, "ghost")
  assert.equal(rows[0]!.status, "failed")
  assert.equal(rows[0]!.note, "boom")
})

test("plugin update：空结果、更新结果与失败都能分辨", () => {
  const none = parsePluginUpdate("No plugin updates available\n")
  assert.equal(none.none, true)
  assert.deepEqual(none.updated, [])

  const done = parsePluginUpdate("Updated usage-center to 0.3.2\n")
  assert.deepEqual(done.updated, ["usage-center"])

  const failed = parsePluginUpdate(
    'No plugin updates available\nFailed to check Server plugin "opencode-notify": bad manifest\n',
  )
  assert.equal(failed.failures.length, 1)
  assert.equal(failed.failures[0]!.id, "opencode-notify")
  assert.equal(failed.failures[0]!.reason, "bad manifest")
})
