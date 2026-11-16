/**
 * 生命周期安全性：0.5.1 这一轮修的就是这些路径。
 *
 * 与 official-cli.test.ts 的分工：那边验证「正常路径走的还是官方 CLI」，
 * 这边专门验证「每一个阶段单独失败时，配置和旧版本会怎样」。
 *
 * 每个用例只注入一个阶段的故障（见 tests/fixtures/opencode-cli.mjs 的 FAKE_CLI_FAIL），
 * 而不是用一个总开关代替所有失败路径——同一个开关测不出「包装好了但入口是坏的」这种情形。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { parse } from "jsonc-parser"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as admin from "../src/gui/admin.ts"

const FIXTURE = join(process.cwd(), "tests", "fixtures", "opencode-cli.mjs")
const SELF = "opencode-plugin-hub"
const SELF_VERSION = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }
).version
const LATER = SELF_VERSION.replace(/\.(\d+)$/, (_match, patch: string) => `.${Number(patch) + 1}`)

const REAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_PLUGIN_HUB_REGISTRY",
  "FAKE_CLI_MODE",
  "FAKE_CLI_FAIL",
  "FAKE_CLI_HANG",
  "FAKE_CLI_LOG",
  "FAKE_CLI_LIST",
  "FAKE_CLI_CHECK",
  "FAKE_CLI_UPDATE_TO",
  "FAKE_CLI_REAL_CONFIG",
  "OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS",
  "OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS",
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

let temp = ""

// No test may reach the network: a 404 for everything makes npmLatest() answer "no published
// version" without a socket.
globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME!, "opencode")
}
function jsonPath(): string {
  return join(configDir(), "opencode.json")
}
function jsoncPath(): string {
  return join(configDir(), "opencode.jsonc")
}
function logPath(): string {
  return join(temp, "cli.log")
}

async function writeConfig(plugins: unknown[]): Promise<void> {
  await writeFile(jsonPath(), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8")
}

async function readPlugins(): Promise<unknown[]> {
  const raw = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins?: unknown[] }
  return raw.plugins ?? []
}

function calls(): string[] {
  if (!existsSync(logPath())) return []
  return readFileSync(logPath(), "utf8").split("\n").filter((line) => line.trim().length > 0)
}

function packageCalls(): string[] {
  return calls().filter((line) => /^plugin (add|remove|update)\b/.test(line))
}

function listOutput(rows: string[]): string {
  return ["ID  VERSION  SOURCE", ...rows].join("\n")
}

/** Seeds the shared npm cache the way an earlier install would have left it. */
async function seedCache(name: string, version: string, options: { entry?: boolean } = {}): Promise<void> {
  const dir = join(
    process.env.XDG_CACHE_HOME!,
    "opencode",
    "npm",
    `${name}@${version}`,
    "1700000000000",
    "node_modules",
    name,
  )
  await mkdir(join(dir, "dist"), { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version, main: "./dist/index.js" }),
    "utf8",
  )
  if (options.entry !== false) await writeFile(join(dir, "dist", "index.js"), "export default {}\n", "utf8")
}

/**
 * The rest of the suite stubs `fetch` so nothing reaches npm. The rollback tests need one real
 * socket to a loopback server, so they swap in a stub that only lets 127.0.0.1 through.
 */
function allowLoopback(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("127.0.0.1")) return REAL_FETCH(input as RequestInfo, init)
    return new Response("", { status: 404 })
  }) as typeof fetch
}

/** A fake sidecar that answers `/api/plugin`; `once` lets a test change its answer mid-operation. */
async function sidecar(answer: () => unknown): Promise<{ endpoint: { url: string; headers: Record<string, string> }; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (!request.url?.startsWith("/api/plugin")) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    endpoint: { url: `http://127.0.0.1:${port}`, headers: {} },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-safety-"))
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  process.env.XDG_CACHE_HOME = join(temp, "cache")
  await mkdir(configDir(), { recursive: true })
  await mkdir(join(temp, "cache"), { recursive: true })
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://plugin-hub.test"
  process.env.FAKE_CLI_LOG = logPath()
  for (const key of ["FAKE_CLI_MODE", "FAKE_CLI_FAIL", "FAKE_CLI_HANG", "FAKE_CLI_CHECK", "FAKE_CLI_UPDATE_TO", "FAKE_CLI_REAL_CONFIG", "OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS", "OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS"]) {
    delete process.env[key]
  }
  process.env.FAKE_CLI_LIST = listOutput([])
  await writeConfig([])
  admin.useCli([process.execPath, FIXTURE])
})

afterEach(async () => {
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch
  await chmod(configDir(), 0o755).catch(() => undefined)
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
// TASK-01 版本替换：不再先删后补
// ---------------------------------------------------------------------------

test("01. 换版本全程不调用 remove，旧条目在切换前一直留在配置里", async () => {
  await writeConfig(["opencode-notify@1.0.0", "keep-me"])
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin add opencode-notify@1.2.0"], "只有一次 add，没有 remove")
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.2.0", "keep-me"])
  assert.equal(result.stages?.command, "succeeded")
  assert.equal(result.stages?.config, "updated")
})

test("02. 新版本装好但入口文件缺失：拒绝切换，旧版本仍是配置里的那一条", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_FAIL = "add-entry"
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, false)
  assert.match(result.message, /入口/)
  assert.equal(result.stages?.config, "unchanged")
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
})

test("03. 配置写入失败：旧配置原样保留，并说明包其实已经准备好", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  await chmod(configDir(), 0o500)
  const result = await admin.install("opencode-notify", "1.2.0")
  await chmod(configDir(), 0o755)
  assert.equal(result.ok, false)
  assert.equal(result.stages?.config, "failed")
  assert.equal(result.stages?.command, "succeeded", "包那一步是成功的")
  assert.match(result.message, /旧条目 opencode-notify@1\.0\.0 没有被改动/)
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
})

test("04. 官方 CLI 超时：不得先删旧配置，也不写入任何条目", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_HANG = "add"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "400"
  const started = Date.now()
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, false)
  assert.ok(Date.now() - started < 20_000, "靠自己的 deadline 结束")
  assert.deepEqual(packageCalls(), ["plugin add opencode-notify@1.2.0"])
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
  assert.match(result.message, /超时/)
})

test("05. CLI 返回非预期输出：不当作安装成功", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_FAIL = "add-garbage"
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, false)
  assert.match(result.message, /临时配置里没有出现/)
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
})

test("06. 命令成功但包没有落盘：不认为安装完成", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_FAIL = "add-nomaterialize"
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, false)
  assert.match(result.message, /缓存里找不到/)
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
})

test("07. 退出码 0 但输出里有 Error：按失败处理", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_FAIL = "add-exit-zero-error"
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, false)
  assert.equal(result.stages?.command, "failed")
  assert.deepEqual(await readPlugins(), ["opencode-notify@1.0.0"])
})

test("08. 对象形式条目换版本后 options 与其他字段完整保留", async () => {
  await writeConfig([{ package: "opencode-notify@1.0.0", options: { agent: "reviewer", strict: true } }, "other"])
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), [
    { package: "opencode-notify@1.2.0", options: { agent: "reviewer", strict: true } },
    "other",
  ])
})

test("08b. 从精确版本切回“不锁版本”：准备 pkg(latest)，配置改成裸包名", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(packageCalls(), ["plugin add opencode-notify"], "准备的是裸包名（= latest）")
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("09. 换版本后不出现重复声明", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  await admin.install("opencode-notify", "1.2.0")
  const plugins = await readPlugins()
  assert.equal(plugins.length, 1)
  assert.deepEqual(plugins, ["opencode-notify@1.2.0"])
})

// ---------------------------------------------------------------------------
// TASK-06 / TASK-07 配置保护与并发
// ---------------------------------------------------------------------------

test("10. 配置解析失败：快照报错，写入被拒绝，文件一个字节都没动", async () => {
  const broken = '{ "plugins": [ "opencode-notify", ] \n "theme": '
  writeFileSync(jsonPath(), broken, "utf8")
  const state = await admin.snapshot()
  assert.notEqual(state.error, "", "解析失败必须作为错误报出来")
  assert.deepEqual(state.plugins, [])

  const install = await admin.install("opencode-notify", "1.2.0")
  assert.equal(install.ok, false)
  assert.match(install.message, /无法解析/)

  const pause = await admin.pause("opencode-notify")
  assert.equal(pause.ok, false)

  assert.equal(readFileSync(jsonPath(), "utf8"), broken, "损坏的配置不能被覆盖")
})

test("11. 外部进程在操作期间改掉目标条目：拒绝写入，而不是按旧下标改", async () => {
  await writeConfig(["opencode-notify@1.0.0", "keep-me"])
  process.env.FAKE_CLI_FAIL = "external-edit"
  process.env.FAKE_CLI_REAL_CONFIG = jsonPath()
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, false)
  assert.match(result.message, /被改动/)
  assert.equal(result.stages?.config, "failed")
  // 配置由“外部修改”决定：那一条已经不在了，插件中心没有另外加一条新的。
  assert.deepEqual(await readPlugins(), ["keep-me"])
})

test("12. 同一个插件的两个生命周期操作并发触发：一个执行，一个被拒绝", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  const [first, second] = await Promise.all([
    admin.install("opencode-notify", "1.2.0"),
    admin.install("opencode-notify", "1.3.0"),
  ])
  const results = [first, second]
  assert.equal(results.filter((item) => item.ok).length, 1, "只能有一个成功")
  const rejected = results.find((item) => !item.ok)!
  assert.match(rejected.message, /还有一个操作没有结束/)
  assert.equal(rejected.stages?.command, "skipped")
  const plugins = (await readPlugins()) as string[]
  assert.equal(plugins.length, 1, "不能出现两条同名条目")
})

test("13. JSONC 注释、缩进与其他字段在改规则后仍然保留", async () => {
  const jsonc = `{
  // 我的注释：这两个插件别动
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "plugins": [
    "opencode-notify", // 通知
    "keep-me"
  ]
}
`
  writeFileSync(jsoncPath(), jsonc, "utf8")
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.pause("opencode-notify")
  assert.equal(result.ok, true, result.message)
  const after = readFileSync(jsoncPath(), "utf8")
  assert.match(after, /\/\/ 我的注释：这两个插件别动/)
  assert.match(after, /\/\/ 通知/)
  assert.match(after, /"\$schema": "https:\/\/opencode\.ai\/config\.json"/)
  assert.match(after, /"theme": "dark"/)
  const parsed = parse(after) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["opencode-notify", "keep-me", "-opencode-notify-callback"])
})

// ---------------------------------------------------------------------------
// TASK-04 / TASK-05 暂停与恢复
// ---------------------------------------------------------------------------

test("14. 精确规则与通配规则同时存在：一次写入里删精确、补裸 ID，通配原样保留", async () => {
  await writeConfig(["acme.alpha", "-acme.alpha", "-*", "-other.rule"])
  process.env.FAKE_CLI_LIST = listOutput(["acme.alpha  1.0.0  acme.alpha"])
  const result = await admin.resume("acme.alpha")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(
    await readPlugins(),
    ["acme.alpha", "-*", "-other.rule", "acme.alpha"],
    "删除精确规则后仍被 - * 挡住，因此在末尾追加裸 ID；用户的通配规则没有被动",
  )
  assert.match(result.message, /同一次写入/)
})

test("15. 通配禁用且拿不到真实 ID：整个操作零改动（不再先删后失败）", async () => {
  const before = JSON.stringify(["acme.alpha", "-acme.alpha", "-*"], null, 2)
  await writeConfig(JSON.parse(before))
  const raw = readFileSync(jsonPath(), "utf8")
  process.env.FAKE_CLI_LIST = listOutput(["-  -  acme.alpha"])
  const result = await admin.resume("acme.alpha")
  assert.equal(result.ok, false)
  assert.match(result.message, /无法确认.*插件 ID/)
  assert.equal(readFileSync(jsonPath(), "utf8"), raw, "配置必须逐字节不变")
})

test("16. 自定义 ID：精确禁用规则按运行时 ID 删除，不按包名猜", async () => {
  await writeConfig(["opencode-notify", "-opencode-notify-callback"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.resume("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("17. 重复暂停 / 重复恢复都不重复写条目", async () => {
  await writeConfig(["opencode-notify"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  await admin.pause("opencode-notify")
  const again = await admin.pause("opencode-notify")
  assert.equal(again.ok, true)
  assert.match(again.message, /已经被规则/)
  assert.deepEqual(await readPlugins(), ["opencode-notify", "-opencode-notify-callback"])

  await admin.resume("opencode-notify")
  const twice = await admin.resume("opencode-notify")
  assert.equal(twice.ok, true)
  assert.match(twice.message, /不需要恢复/)
  assert.deepEqual(await readPlugins(), ["opencode-notify"])
})

test("18. 暂停只追加规则：包条目、options 与用户自己的规则都不动", async () => {
  await writeConfig([{ package: "opencode-notify", options: { agent: "reviewer" } }, "-other.plugin"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const result = await admin.pause("opencode-notify")
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), [
    { package: "opencode-notify", options: { agent: "reviewer" } },
    "-other.plugin",
    "-opencode-notify-callback",
  ])
  // 已经被通配规则禁用时不再追加第二条规则。
  await writeConfig(["opencode-notify", "-*"])
  const blocked = await admin.pause("opencode-notify")
  assert.equal(blocked.ok, true)
  assert.match(blocked.message, /已经被规则/)
  assert.deepEqual(await readPlugins(), ["opencode-notify", "-*"])
})

test("19. 运行状态区分“被精确规则禁用”和“被通配规则禁用”", async () => {
  await writeConfig(["opencode-notify", "-opencode-notify-callback"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  0.1.2  opencode-notify"])
  const exact = await admin.runtime(undefined)
  assert.equal(exact.items.find((item) => item.spec === "opencode-notify")?.pausedBy, "exact")

  await writeConfig(["opencode-notify", "-*"])
  const wildcard = await admin.runtime(undefined)
  const info = wildcard.items.find((item) => item.spec === "opencode-notify")!
  assert.equal(info.paused, true)
  assert.equal(info.pausedBy, "wildcard")
  assert.deepEqual(info.rules, ["-*"])
})

// ---------------------------------------------------------------------------
// TASK-02 / TASK-14 自升级
// ---------------------------------------------------------------------------

test("20. 自升级成功：准备 → 切换 → 宿主确认加载，才报成功", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  await seedCache(SELF, SELF_VERSION)
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${LATER}  ${SELF}@${LATER}`])
  process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS = "900"
  const result = await admin.install(SELF, LATER)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.selfUpdated, true)
  assert.deepEqual(await readPlugins(), [`${SELF}@${LATER}`])
  assert.equal(result.stages?.config, "updated")
  assert.equal(result.stages?.runtime, "loaded")
  assert.match(result.message, /当前窗口仍是旧构建/)
  assert.deepEqual(packageCalls(), [`plugin add ${SELF}@${LATER}`], "自升级不调用 remove/update")
})

test("21. 自升级安装失败：配置一个字节都没动", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  process.env.FAKE_CLI_FAIL = "add"
  process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS = "900"
  const result = await admin.install(SELF, LATER)
  assert.equal(result.ok, false)
  assert.equal(result.stages?.config, "unchanged")
  assert.deepEqual(await readPlugins(), [`${SELF}@${SELF_VERSION}`])
  assert.match(result.message, /配置没有被改动/)
})

test("22. 自升级入口校验失败：同样不切换", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  process.env.FAKE_CLI_FAIL = "add-entry"
  const result = await admin.install(SELF, LATER)
  assert.equal(result.ok, false)
  assert.deepEqual(await readPlugins(), [`${SELF}@${SELF_VERSION}`])
})

test("23. 自升级配置写入失败：旧版本继续可用", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  await chmod(configDir(), 0o500)
  const result = await admin.install(SELF, LATER)
  await chmod(configDir(), 0o755)
  assert.equal(result.ok, false)
  assert.equal(result.stages?.config, "failed")
  assert.deepEqual(await readPlugins(), [`${SELF}@${SELF_VERSION}`])
})

test("24. 目标版本不明确时拒绝自升级（不做“装最新”的猜测）", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  const result = await admin.install(SELF, "")
  assert.equal(result.ok, false)
  assert.match(result.message, /必须给出具体版本号/)
  assert.deepEqual(await readPlugins(), [`${SELF}@${SELF_VERSION}`])
})

test("25. 自升级后宿主没确认新版本：不报成功，但如实说明配置已切换", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  await seedCache(SELF, SELF_VERSION)
  // 宿主仍报告旧版本：配置换了，运行中的还是旧的。
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${SELF_VERSION}  ${SELF}@${SELF_VERSION}`])
  process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS = "700"
  const result = await admin.install(SELF, LATER)
  assert.equal(result.ok, false, "没确认加载就不能说成功")
  assert.equal(result.stages?.config, "updated")
  assert.equal(result.stages?.runtime, "unknown")
  assert.equal(result.selfUpdated, true, "配置确实已经指向新版本，界面要提示旧构建仍在跑")
  assert.deepEqual(await readPlugins(), [`${SELF}@${LATER}`])
  assert.match(result.message, /不等于升级成功/)
})

test("26. 新版本加载失败且旧包仍在缓存：自动回滚并确认旧版本可用", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  await seedCache(SELF, SELF_VERSION)
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${SELF_VERSION}  ${SELF}@${SELF_VERSION}`])
  process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS = "700"
  allowLoopback()
  let calls = 0
  const service = await sidecar(() => {
    calls += 1
    // 第一次问答「新版本加载失败」，之后恢复正常，用来验证回滚后的旧版本能被确认。
    return calls === 1
      ? {
          data: [
            {
              source: { type: "package", target: `${SELF}@${LATER}` },
              state: { status: "failed", error: "entry not found" },
            },
          ],
        }
      : { data: [] }
  })
  try {
    const result = await admin.install(SELF, LATER, { endpoint: service.endpoint })
    assert.equal(result.ok, false)
    assert.equal(result.stages?.runtime, "failed")
    assert.equal(result.stages?.rollback, "succeeded")
    assert.deepEqual(await readPlugins(), [`${SELF}@${SELF_VERSION}`], "配置回到旧版本")
    assert.match(result.message, /已回滚/)
  } finally {
    await service.close()
  }
})

test("27. 新版本加载失败但旧包已不在缓存：不盲目回滚，明确告知需要手动处理", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  // 故意不 seed 旧版本的包：回滚到硬盘上没有的东西只会让插件中心彻底不可用。
  process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS = "700"
  allowLoopback()
  const service = await sidecar(() => ({
    data: [
      {
        source: { type: "package", target: `${SELF}@${LATER}` },
        state: { status: "failed", error: "entry not found" },
      },
    ],
  }))
  try {
    const result = await admin.install(SELF, LATER, { endpoint: service.endpoint })
    assert.equal(result.ok, false)
    assert.equal(result.stages?.rollback, "failed")
    assert.deepEqual(await readPlugins(), [`${SELF}@${LATER}`], "没有回滚，配置保持新版本")
    assert.match(result.message, /自动回滚不安全/)
  } finally {
    await service.close()
  }
})

test("28. 连续两次自升级：第二次被拒绝，不会叠加写入", async () => {
  await writeConfig([`${SELF}@${SELF_VERSION}`])
  await seedCache(SELF, SELF_VERSION)
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${LATER}  ${SELF}@${LATER}`])
  process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS = "700"
  const [first, second] = await Promise.all([admin.install(SELF, LATER), admin.install(SELF, LATER)])
  assert.equal([first, second].filter((item) => item.ok).length, 1)
  const rejected = [first, second].find((item) => !item.ok)!
  assert.match(rejected.message, /还有一个操作没有结束/)
  assert.deepEqual(await readPlugins(), [`${SELF}@${LATER}`])
})

// ---------------------------------------------------------------------------
// 移除：目录只改配置，npm 命令失败不谎报
// ---------------------------------------------------------------------------

test("29. remove 命令失败：配置不变，也不声称已移除", async () => {
  await writeConfig(["opencode-notify", "keep-me"])
  process.env.FAKE_CLI_FAIL = "remove"
  const result = await admin.remove("opencode-notify")
  assert.equal(result.ok, false)
  assert.equal(result.stages?.config, "unchanged")
  assert.deepEqual(await readPlugins(), ["opencode-notify", "keep-me"])
})

test("30. 本地目录插件移除：不删除磁盘目录，也不调用官方 remove", async () => {
  const dir = join(temp, "keep-me-dir")
  await mkdir(dir, { recursive: true })
  await writeConfig([dir])
  const result = await admin.remove(dir)
  assert.equal(result.ok, true, result.message)
  assert.equal(existsSync(dir), true)
  assert.deepEqual(packageCalls(), [])
  assert.deepEqual(await readPlugins(), [])
})
