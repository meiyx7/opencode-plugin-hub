/**
 * 生命周期语义：selfUpdated 判定、配置控制项识别、以及“规则不是插件包”的展示约定。
 *
 * 安装/更新/移除的具体命令行为在 official-cli.test.ts 里验证；这里只盯住
 * 「插件中心不会误报自己已被更新」与「规则项不会被当成可安装的包」。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as admin from "../src/gui/admin.ts"

const FIXTURE = join(process.cwd(), "tests", "fixtures", "opencode-cli.mjs")
const SELF_VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version
const LATER_VERSION = SELF_VERSION.replace(/\.(\d+)$/, (_match, patch: string) => `.${Number(patch) + 1}`)

const REAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_PLUGIN_HUB_REGISTRY",
  "FAKE_CLI_LOG",
  "FAKE_CLI_LIST",
  "FAKE_CLI_CHECK",
  "FAKE_CLI_UPDATE_TO",
  "FAKE_CLI_FAIL",
  "OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS",
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

let temp = ""

globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json")
}

async function writeConfig(plugins: unknown[]): Promise<void> {
  await writeFile(configPath(), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8")
}

async function readPlugins(): Promise<unknown[]> {
  const raw = JSON.parse(await readFile(configPath(), "utf8")) as { plugins?: unknown[] }
  return raw.plugins ?? []
}

function calls(): string[] {
  const path = join(temp, "cli.log")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0)
}

function listOutput(rows: string[]): string {
  return ["ID  VERSION  SOURCE", ...rows].join("\n")
}

/**
 * Registry mock for the plugin-center's own version lookup. `npmLatest` asks
 * `${OPENCODE_PLUGIN_HUB_REGISTRY}/opencode-plugin-hub/latest`; anything else stays 404.
 * Pass a version to answer with that manifest, "" for a definite 404 (no published version),
 * "throw" to simulate an unreachable registry, or null to leave the default 404 in place.
 */
function mockSelfRegistry(version: string | null | "throw", extra?: Record<string, unknown>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/opencode-plugin-hub/latest")) {
      if (version === "throw") throw new Error("registry unreachable")
      if (version === null || version === "") return new Response("", { status: 404 })
      return new Response(
        JSON.stringify({ name: "opencode-plugin-hub", version, description: "hub", ...extra }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("", { status: 404 })
  }) as typeof fetch
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-lifecycle-"))
  await mkdir(join(temp, "config", "opencode"), { recursive: true })
  await mkdir(join(temp, "cache"), { recursive: true })
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  process.env.XDG_CACHE_HOME = join(temp, "cache")
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://plugin-hub.test"
  process.env.FAKE_CLI_LOG = join(temp, "cli.log")
  process.env.FAKE_CLI_LIST = listOutput([])
  delete process.env.FAKE_CLI_UPDATE_TO
  delete process.env.FAKE_CLI_CHECK
  delete process.env.FAKE_CLI_FAIL
  delete process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch
  await writeConfig([])
  admin.useCli([process.execPath, FIXTURE])
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined)
})

after(() => {
  globalThis.fetch = REAL_FETCH
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

// ---------------------------------------------------------------------------
// selfUpdated：只有换掉“正在运行的这一份”才算
// ---------------------------------------------------------------------------

test("1. 普通 npm 插件安装不触发 selfUpdated", async () => {
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true, result.message)
  assert.notEqual(result.selfUpdated, true)
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("2. 普通 npm 插件换版本不触发 selfUpdated", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, true, result.message)
  assert.notEqual(result.selfUpdated, true)
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.2.0"])
})

test("3. 安装插件中心自身触发 selfUpdated", async () => {
  const result = await admin.install("opencode-plugin-hub", LATER_VERSION)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.selfUpdated, true)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${LATER_VERSION}`])
})

test("4. 更新插件中心自身走自升级流程：目标版本取自 npm registry，且不改用 plugin update", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(LATER_VERSION)
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${LATER_VERSION}  opencode-plugin-hub@${LATER_VERSION}`])
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.selfUpdated, true)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${LATER_VERSION}`], "配置指向目标版本")
  // 自升级不走 plugin update：那条路径会直接重写配置，跳过准备与校验。
  assert.deepEqual(calls().filter((line) => line.startsWith("plugin update")), [], "不该调用 plugin update")
  assert.equal(result.stages?.runtime, "loaded", "宿主报告新版本加载后才算成功")
})

test("5. 插件中心自身不能被移除", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  const result = await admin.remove(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, false)
  assert.match(result.message, /不能移除/)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${SELF_VERSION}`])
  assert.deepEqual(calls(), [], "拒绝之前不能调用任何命令")
})

// ---------------------------------------------------------------------------
// 配置控制项：`-id` 禁用规则与 `*` 通配是规则，不是已安装的插件包
// ---------------------------------------------------------------------------

test("6. 禁用规则与通配项按规则展示，不伪装成插件包", async () => {
  await writeConfig(["-acme.reviewer", "*", "opencode-notify"])
  const state = await admin.snapshot()
  const bySpec = new Map(state.plugins.map((entry) => [entry.spec, entry]))
  assert.equal(bySpec.get("-acme.reviewer")!.kind, "control")
  assert.equal(bySpec.get("-acme.reviewer")!.name, "acme.reviewer", "规则名不带 - 前缀")
  assert.equal(bySpec.get("*")!.kind, "control")
  assert.equal(bySpec.get("opencode-notify")!.kind, "package")
})

test("7. 控制项不触发 registry 查询，也不会被判定为可更新", async () => {
  await writeConfig(["-acme.reviewer", "*"])
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response("", { status: 404 })
  }) as typeof fetch
  const result = await admin.updates()
  assert.equal(calls, 0, "控制项不应发任何 registry 请求")
  assert.equal(
    result.items.every((item) => item.hasUpdate === false && item.official === "skipped"),
    true,
  )
})

test("8. 移除禁用规则只删掉这一条，其他条目保留", async () => {
  await writeConfig(["-acme.reviewer", "opencode-notify"])
  const result = await admin.remove("-acme.reviewer")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
  assert.deepEqual(calls(), [], "规则不是 npm 包，不该走官方 remove")
})

test("9. 安装插件时追加条目，不改写已有禁用规则", async () => {
  await writeConfig(["-acme.reviewer"])
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["-acme.reviewer", "opencode-notify"])
})

// ---------------------------------------------------------------------------
// 包名与规则的分界：`foo@*` 是 npm 版本范围
// ---------------------------------------------------------------------------

test("10. isControlSpec 只认官方语法的规则项", () => {
  const controls = ["-acme.reviewer", "*", ".*", "acme.*", "acme.reviewer.*", "-acme.*", "-acme.reviewer.*"]
  for (const spec of controls) {
    assert.equal(admin.isControlSpec(spec), true, `${spec} 应识别为控制项`)
  }
  for (const spec of ["  *  ", " -acme.reviewer "]) {
    assert.equal(admin.isControlSpec(spec), true, `${spec} 去掉空白后仍是控制项`)
  }
})

test("11. 带版本范围的包名不会被误判成控制项", () => {
  const packages = ["foo@*", "@scope/foo@*", "foo@latest", "foo@^1.2.0", "foo@1.2.3", "opencode-notify", "@scope/foo", "./local-plugin", "", "-"]
  for (const spec of packages) {
    assert.equal(admin.isControlSpec(spec), false, `${spec} 不是控制项`)
  }
})

test("12. foo@* 按包展示，名字与版本范围分开", async () => {
  await writeConfig(["foo@*", "@scope/foo@*", "-acme.reviewer"])
  const state = await admin.snapshot()
  const bySpec = new Map(state.plugins.map((entry) => [entry.spec, entry]))
  assert.equal(bySpec.get("foo@*")!.kind, "package")
  assert.equal(bySpec.get("foo@*")!.name, "foo")
  assert.equal(bySpec.get("@scope/foo@*")!.kind, "package")
  assert.equal(bySpec.get("@scope/foo@*")!.name, "@scope/foo")
  assert.equal(bySpec.get("-acme.reviewer")!.kind, "control")
})

test("13. 带 options 的对象条目在快照里保留原样，编辑时不丢参数", async () => {
  await writeConfig([{ package: "opencode-notify", options: { agent: "reviewer", strict: true } }])
  const state = await admin.snapshot()
  const entry = state.plugins.find((item) => item.name === "opencode-notify")!
  assert.equal(entry.options, true)
  // 停用/恢复只追加规则，不重写这条对象
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  await admin.pause("opencode-notify")
  const raw = JSON.parse(await readFile(configPath(), "utf8")) as { plugins: unknown[] }
  assert.deepEqual(raw.plugins[0], { package: "opencode-notify", options: { agent: "reviewer", strict: true } })
})

test("14. 语法错误或缺失的配置不会让快照抛异常", async () => {
  writeFileSync(configPath(), "{ not json", "utf8")
  const state = await admin.snapshot()
  assert.equal(Array.isArray(state.plugins), true)
})
