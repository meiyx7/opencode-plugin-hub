/**
 * 官方 CLI 接入与暂停/恢复的行为测试。
 *
 * 用一个假的 `opencode` 可执行文件（tests/fixtures/opencode-cli.mjs）代替真机 CLI：
 * 它按真实 CLI 的约定写配置、按真实输出格式回话，并把每次调用记进日志，
 * 于是「到底执行了什么命令」「配置被改成什么样」都能断言，而不是只看按钮点没点上。
 *
 * 覆盖验收清单里可离线验证的部分：安装/换版本/更新/移除、暂停/恢复、
 * 精确锁定与本地目录的跳过、自定义 ID、通配符禁用后恢复、CLI 缺失与超时。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as admin from "../src/gui/admin.ts"

const FIXTURE = join(process.cwd(), "tests", "fixtures", "opencode-cli.mjs")
const REAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_PLUGIN_HUB_REGISTRY",
  "FAKE_CLI_MODE",
  "FAKE_CLI_LOG",
  "FAKE_CLI_LIST",
  "FAKE_CLI_CHECK",
  "FAKE_CLI_UPDATE_TO",
  "OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS",
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

let temp = ""

// No test may reach the network: an explicit registry plus a 404 for everything makes
// npmLatest() answer "no published version" without a socket.
globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json")
}

function logPath(): string {
  return join(temp, "cli.log")
}

async function writeConfig(plugins: unknown[]): Promise<void> {
  await writeFile(configPath(), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8")
}

async function readPlugins(): Promise<unknown[]> {
  const raw = JSON.parse(await readFile(configPath(), "utf8")) as { plugins?: unknown[] }
  return raw.plugins ?? []
}

function calls(): string[] {
  if (!existsSync(logPath())) return []
  return readFileSync(logPath(), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
}

/** Only the mutating package commands; the "re-read runtime" step also calls `plugin list`. */
function packageCalls(): string[] {
  return calls().filter((line) => /^plugin (add|remove|update)\b/.test(line))
}

function clearCalls(): void {
  if (existsSync(logPath())) writeFileSync(logPath(), "")
}

function listOutput(rows: string[]): string {
  return ["ID  VERSION  SOURCE", ...rows].join("\n")
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-cli-"))
  await mkdir(join(temp, "config", "opencode"), { recursive: true })
  await mkdir(join(temp, "cache"), { recursive: true })
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  process.env.XDG_CACHE_HOME = join(temp, "cache")
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://plugin-hub.test"
  process.env.FAKE_CLI_LOG = join(temp, "cli.log")
  delete process.env.FAKE_CLI_MODE
  delete process.env.FAKE_CLI_UPDATE_TO
  delete process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS
  process.env.FAKE_CLI_LIST = listOutput([])
  delete process.env.FAKE_CLI_CHECK
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
// 安装：官方 opencode plugin add
// ---------------------------------------------------------------------------

test("1. 安装 npm 插件走 opencode plugin add，配置由 CLI 写入", async () => {
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin add opencode-notify"])
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
  assert.match(result.message, /opencode plugin add/)
})

test("2. 安装指定版本写成 pkg@version 一个参数，不拼 shell 字符串", async () => {
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin add opencode-notify@1.2.0"])
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.2.0"])
})

test("3. 安装失败时如实失败：命令输出保留，配置不变", async () => {
  process.env.FAKE_CLI_MODE = "fail"
  const result = await admin.install("opencode-notify", "9.9.9")
  assert.equal(result.ok, false)
  assert.match(result.message, /No matching version found/)
  assert.deepEqual(await readPlugins(), [], "失败不能留下半截配置")
})

test("4. 已配置的插件不会重复写入，也不会再跑一次安装", async () => {
  await writeConfig(["opencode-notify"])
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true)
  assert.match(result.message, /已在配置中/)
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("5. 换版本先移除旧条目再安装新版本，不留两条同名条目", async () => {
  await writeConfig(["opencode-notify@1.0.0", "other-plugin"])
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin remove opencode-notify@1.0.0", "plugin add opencode-notify@1.2.0"])
  assert.deepEqual(await readPlugins(), ["other-plugin", "opencode-notify@1.2.0"])
})

test("6. 换版本失败时把旧条目装回去，并说明恢复结果", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_MODE = "fail"
  const result = await admin.install("opencode-notify", "9.9.9")
  assert.equal(result.ok, false)
  // fail 模式对 add/remove 都报错：移除失败即中止，不允许继续把配置改坏。
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
  assert.match(result.message, /失败/)
})

test("7. 本地目录条目拒绝被 npm 安装覆盖，也不调用 CLI", async () => {
  const dir = join(temp, "local-plugin")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "local-plugin", version: "1.0.0" }), "utf8")
  await writeConfig([dir])
  const result = await admin.install("local-plugin", "")
  assert.equal(result.ok, false)
  assert.match(result.message, /本地目录/)
  assert.deepEqual(packageCalls(), [], "不该执行任何包命令")
  assert.deepEqual(await readPlugins(), [dir], "目录条目原样保留")
})

test("8. 没有 CLI 时明确失败，不偷偷改配置", async () => {
  admin.useCli([])
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, false)
  assert.match(result.message, /找不到 opencode CLI/)
  assert.deepEqual(await readPlugins(), [])
})

// ---------------------------------------------------------------------------
// 更新：官方 opencode plugin update
// ---------------------------------------------------------------------------

test("9. 更新走 opencode plugin update <configured target>，并报出版本变化", async () => {
  await writeConfig(["opencode-usage-center"])
  process.env.FAKE_CLI_UPDATE_TO = "0.3.2"
  const result = await admin.update("opencode-usage-center")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin update opencode-usage-center"])
  assert.match(result.message, /v0\.3\.2/)
  assert.deepEqual(await readPlugins(), ["opencode-usage-center@0.3.2"])
})

test("10. 官方报告没有可更新项时，说明被跳过而不是声称已最新", async () => {
  await writeConfig(["opencode-usage-center"])
  const result = await admin.update("opencode-usage-center")
  assert.equal(result.ok, true)
  assert.match(result.message, /跳过/)
  assert.doesNotMatch(result.message, /已是最新/)
})

test("11. 本地目录插件不进入官方更新流程", async () => {
  const dir = join(temp, "local-plugin")
  await mkdir(dir, { recursive: true })
  await writeConfig([dir])
  const result = await admin.update(dir)
  assert.equal(result.ok, false)
  assert.match(result.message, /本地目录/)
  assert.deepEqual(packageCalls(), [])
})

// ---------------------------------------------------------------------------
// 移除：npm 走 CLI，目录只改配置
// ---------------------------------------------------------------------------

test("12. 移除 npm 插件走 opencode plugin remove，只改配置", async () => {
  await writeConfig(["opencode-notify", "other"])
  const result = await admin.remove("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin remove opencode-notify"])
  assert.deepEqual(await readPlugins(), ["other"])
})

test("13. 官方说“未配置”时不算成功", async () => {
  await writeConfig([])
  const result = await admin.remove("opencode-notify")
  assert.equal(result.ok, false)
  assert.match(result.message, /配置中没有这一项/)
})

test("14. 移除本地目录条目只删配置，磁盘目录保留，且不调用 npm 命令", async () => {
  const dir = join(temp, "keep-me")
  await mkdir(dir, { recursive: true })
  await writeConfig([dir])
  const result = await admin.remove(dir)
  assert.equal(result.ok, true, result.message)
  assert.equal(existsSync(dir), true, "目录必须还在")
  assert.match(result.message, /没有被删除/)
  assert.deepEqual(packageCalls(), [], "目录条目不走官方 remove")
  assert.deepEqual(await readPlugins(), [])
})

// ---------------------------------------------------------------------------
// 暂停：追加 -<真实 ID>
// ---------------------------------------------------------------------------

test("15. 暂停用运行时报告的真实 ID，而不是包名", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.pause("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["opencode-notify", "-opencode-notify-callback"])
  assert.match(result.message, /opencode-notify-callback/)
  assert.match(result.message, /插件条目与包文件都没有改动/)
})

test("16. 禁用规则追加在末尾，用户已有的规则顺序不变", async () => {
  await writeConfig(["acme.alpha", "acme.beta", "-acme.beta", "-other.plugin"])
  process.env.FAKE_CLI_LIST = listOutput(["acme.alpha  1.0.0  acme.alpha", "acme.beta  1.0.0  acme.beta"])
  const result = await admin.pause("acme.alpha")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(
    await readPlugins(),
    ["acme.alpha", "acme.beta", "-acme.beta", "-other.plugin", "-acme.alpha"],
    "只追加，不改动已有规则与顺序",
  )
})

test("17. 无法确认插件 ID 时拒绝暂停，不改配置", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput(["-  -  opencode-notify"])
  const result = await admin.pause("opencode-notify")
  assert.equal(result.ok, false)
  assert.match(result.message, /无法确认.*插件 ID/)
  assert.deepEqual(await readPlugins(), ["opencode-notify"], "不猜测 ID，不写无效规则")
})

test("18. 已经被规则禁用时不重复写入", async () => {
  await writeConfig(["acme.alpha", "-*"])
  process.env.FAKE_CLI_LIST = listOutput(["acme.alpha  1.0.0  acme.alpha"])
  const result = await admin.pause("acme.alpha")
  assert.equal(result.ok, true)
  assert.match(result.message, /已经被规则/)
  assert.deepEqual(await readPlugins(), ["acme.alpha", "-*"], "通配规则原样保留，没有新增条目")
})

test("19. 对象条目（带 options）暂停后参数不丢", async () => {
  await writeConfig([{ package: "opencode-notify", options: { agent: "reviewer" } }])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.pause("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), [
    { package: "opencode-notify", options: { agent: "reviewer" } },
    "-opencode-notify-callback",
  ])
})

// ---------------------------------------------------------------------------
// 恢复：删精确规则，必要时补一条裸 ID
// ---------------------------------------------------------------------------

test("20. 恢复只删这条精确禁用规则，不碰其他条目", async () => {
  await writeConfig(["opencode-notify", "-opencode-notify-callback", "other"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.resume("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["opencode-notify", "other"])
  assert.match(result.message, /删除禁用规则 -opencode-notify-callback/)
  assert.match(result.message, /版本与配置参数没有改动/)
})

test("21. 通配符禁用后恢复单个插件：追加裸 ID，通配规则保留", async () => {
  await writeConfig(["acme.alpha", "-*"])
  process.env.FAKE_CLI_LIST = listOutput(["acme.alpha  1.0.0  acme.alpha"])
  const result = await admin.resume("acme.alpha")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["acme.alpha", "-*", "acme.alpha"], "末尾追加启用规则，通配不动")
  assert.match(result.message, /通配规则保持原样/)
})

test("22. 通配符禁用但拿不到 ID 时不写启用规则", async () => {
  await writeConfig(["acme.alpha", "-*"])
  process.env.FAKE_CLI_LIST = listOutput(["-  -  acme.alpha"])
  const result = await admin.resume("acme.alpha")
  assert.equal(result.ok, false)
  assert.match(result.message, /无法确认.*插件 ID/)
  assert.deepEqual(await readPlugins(), ["acme.alpha", "-*"], "配置完全不动")
})

test("23. 本来就没被禁用时，恢复只做说明，不改配置", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.resume("opencode-notify")
  assert.equal(result.ok, true)
  assert.match(result.message, /不需要恢复/)
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("24. 暂停后即使运行时不报 ID，也能靠本机记录恢复", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  await admin.pause("opencode-notify")
  // 暂停之后宿主不再加载它，列表里自然没有它的 ID —— 只能用上次记录。
  process.env.FAKE_CLI_LIST = listOutput([])
  const result = await admin.resume("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["opencode-notify"], "精确规则被删掉，插件恢复原样")
})

// ---------------------------------------------------------------------------
// 运行状态：ID 与“已暂停”分开表达
// ---------------------------------------------------------------------------

test("25. 运行状态同时给出 ID 与是否被规则禁用", async () => {
  await writeConfig(["opencode-notify", "-opencode-notify-callback"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const live = await admin.runtime(undefined)
  const info = live.items.find((item) => item.spec === "opencode-notify")!
  assert.equal(info.id, "opencode-notify-callback")
  assert.equal(info.paused, true)
  assert.equal(info.rule, "-opencode-notify-callback")
  assert.equal(info.status, "loaded", "运行时仍报告它，但配置说它应该被禁用 —— 两件事分开说")
})

test("26. 配置规则本身不是插件：状态为 control，没有 ID", async () => {
  await writeConfig(["-acme.beta", "*"])
  process.env.FAKE_CLI_LIST = listOutput([])
  const live = await admin.runtime(undefined)
  assert.equal(live.items.every((item) => item.status === "control"), true)
  assert.equal(live.items.every((item) => item.id === ""), true)
})

test("27. 运行时发现但配置里没有的插件单独列出", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput([
    "opencode-notify-callback  0.1.2  opencode-notify",
    "some-discovered  1.0.0  /tmp/discovered-plugin",
  ])
  const live = await admin.runtime(undefined)
  assert.equal(live.items.length, 1)
  assert.equal(live.discovered.length, 1)
  assert.equal(live.discovered[0]!.id, "some-discovered")
})

// ---------------------------------------------------------------------------
// 更新检查：官方 check 按运行时 ID 对上配置条目
// ---------------------------------------------------------------------------

test("28. 官方 check 用运行时 ID 匹配（usage-center 对应 opencode-usage-center）", async () => {
  await writeConfig(["opencode-usage-center", "opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput([
    "usage-center  0.3.2  opencode-usage-center@0.3.2",
    "opencode-notify-callback  0.1.2  opencode-notify",
  ])
  process.env.FAKE_CLI_CHECK = "Server\n  usage-center 0.3.2 → 0.4.0\n  opencode-notify-callback 0.1.2 (current)\n"
  const result = await admin.updates()
  const usage = result.items.find((item) => item.name === "opencode-usage-center")!
  assert.equal(usage.official, "outdated")
  assert.equal(usage.hasUpdate, true)
  assert.equal(usage.latest, "0.4.0")

  const notify = result.items.find((item) => item.name === "opencode-notify")!
  assert.equal(notify.official, "current")
  assert.equal(notify.hasUpdate, false)
})

test("29. 本地目录与精确锁定被标成跳过，并给出原因", async () => {
  const dir = join(temp, "dir-plugin")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dir-plugin", version: "1.0.0" }), "utf8")
  await writeConfig([dir, "opencode-notify@1.2.0"])
  process.env.FAKE_CLI_LIST = listOutput([`dir-plugin  local  ${dir}`, "opencode-notify-callback  1.2.0  opencode-notify@1.2.0"])
  process.env.FAKE_CLI_CHECK = "Server\n  opencode-notify-callback 1.2.0 (current)\n"
  const result = await admin.updates()
  const local = result.items.find((item) => item.kind === "path")!
  assert.equal(local.official, "skipped")
  assert.equal(local.managed, false)
  assert.match(local.reason, /本地目录/)

  const pinned = result.items.find((item) => item.kind === "package")!
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.hasUpdate, false, "精确锁定不提供更新按钮")
})

test("30. 官方检查失败不伪装成“已是最新”", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  process.env.FAKE_CLI_CHECK = 'Server\n  opencode-notify-callback (check failed)\n'
  const result = await admin.updates()
  const row = result.items.find((item) => item.name === "opencode-notify")!
  assert.equal(row.official, "failed")
  assert.equal(row.hasUpdate, false)
})

// ---------------------------------------------------------------------------
// 命令失败形态：缺失、超时、重载
// ---------------------------------------------------------------------------

test("31. CLI 超时按超时报告，不落在“成功”上", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_MODE = "timeout"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "400"
  process.env.FAKE_CLI_LIST = listOutput([])
  const started = Date.now()
  const result = await admin.pause("opencode-notify")
  assert.equal(result.ok, false)
  assert.ok(Date.now() - started < 15_000, "必须靠自己的 deadline 结束，而不是等子进程")
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("32. 重载读退出码，成功与失败分开报告", async () => {
  const ok = await admin.reload()
  assert.equal(ok.ok, true, ok.message)
  assert.deepEqual(calls(), ["reload"])

  clearCalls()
  admin.useCli([join(temp, "definitely-not-opencode")])
  const missing = await admin.reload()
  assert.equal(missing.ok, false)
  assert.match(missing.message, /无法启动 opencode CLI|找不到 opencode CLI|ENOENT/)
})
