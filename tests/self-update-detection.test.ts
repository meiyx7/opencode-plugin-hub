/**
 * 插件中心「自身更新检测 + 安全升级目标」回归。
 *
 * 关键点：插件中心自己以精确版本运行时，`opencode plugin check` 会跳过它，
 * 所以自身是否有新版本、以及升级到哪个版本，都必须来自 npm registry，而不是官方检查。
 *
 * 用隔离的临时配置 + CLI fixture + fetch mock，绝不碰真实配置或 npm 缓存。
 * - A 组：updates() 的自身检测矩阵（精确锁定 / 裸包名 / 已是最新 / 无更新 / 请求失败 / 无效版本）
 * - B 组：普通插件精确锁定行为完全不变
 * - C 组：latestForSelf 经 update() 体现的目标版本与安全失败路径
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as admin from "../src/gui/admin.ts"

const FIXTURE = join(process.cwd(), "tests", "fixtures", "opencode-cli.mjs")
const SELF_VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version
/** 一个确定高于当前版本的稳定版（保证不依赖 package.json 的具体号）。 */
const NEWER = `${Number(SELF_VERSION.split(".")[0])}.${Number(SELF_VERSION.split(".")[1])}.${Number(SELF_VERSION.split(".")[2]) + 50}`
const OLDER = `${Number(SELF_VERSION.split(".")[0])}.${Number(SELF_VERSION.split(".")[1])}.${Math.max(0, Number(SELF_VERSION.split(".")[2]) - 1)}`

const REAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_PLUGIN_HUB_REGISTRY",
  "FAKE_CLI_LOG",
  "FAKE_CLI_LIST",
  "FAKE_CLI_CHECK",
  "FAKE_CLI_FAIL",
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

let temp = ""

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
function selfRow(result: admin.UpdatesResultValue): admin.UpdateInfoValue | undefined {
  return result.items.find((item) => item.name === "opencode-plugin-hub")
}

/** 见 self-update.test.ts 的同名 helper：返回版本清单，或 404 / 抛错 / 无效版本。 */
function mockSelfRegistry(version: string | null | "throw"): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/opencode-plugin-hub/latest")) {
      if (version === "throw") throw new Error("registry unreachable")
      if (version === null || version === "") return new Response("", { status: 404 })
      return new Response(JSON.stringify({ name: "opencode-plugin-hub", version, description: "hub" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("", { status: 404 })
  }) as typeof fetch
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-self-detect-"))
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
  // 官方 check 对自身什么都不报：这正是要修复的场景（精确锁定被官方跳过）。
  process.env.FAKE_CLI_CHECK = "Server\n  (no rows)\n"
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
// A. 自身更新检测：registry 是依据，精确锁定不再屏蔽
// ---------------------------------------------------------------------------

test("A1. 当前 0.5.0 / npm 0.6.0 / 精确锁定 → 可更新（不受 pinned 限制）", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(NEWER)
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.selfUpdate, true)
  assert.equal(self.pinned, true)
  assert.equal(self.hasUpdate, true, "registry 发现新版本，精确锁定也要提示")
  assert.equal(self.latest, NEWER)
  assert.equal(self.current, SELF_VERSION)
  assert.equal(self.official, "outdated")
})

test("A2. 当前 / npm 更新 / 裸包名 → 可更新", async () => {
  await writeConfig(["opencode-plugin-hub"])
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${SELF_VERSION}  opencode-plugin-hub`])
  // 裸包名的当前版本来自宿主/官方检查这一事实来源；决定是否更新仍只看 registry。
  process.env.FAKE_CLI_CHECK = `Server\n  plugin-hub ${SELF_VERSION} (current)\n`
  mockSelfRegistry(NEWER)
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.pinned, false)
  assert.equal(self.hasUpdate, true)
  assert.equal(self.latest, NEWER)
  assert.equal(self.current, SELF_VERSION)
})

test("A3. 当前 == npm（精确锁定）→ 已是最新", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(SELF_VERSION)
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, false)
  assert.equal(self.official, "current")
})

test("A4. npm 版本低于当前（精确锁定）→ 不显示更新", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(OLDER)
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, false)
  assert.equal(self.official, "current")
})

test("A5. registry 请求失败（精确锁定）→ 未能检查，不谎报已是最新", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry("throw")
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, false)
  assert.equal(self.official, "failed")
  assert.match(self.reason, /无法连接|未能确认/)
})

test("A6. registry 返回无效/非稳定版本（精确锁定）→ 不允许升级", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry("not-a-version")
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, false)
  assert.equal(self.official, "failed")
  assert.match(self.reason, /不是有效稳定版本/)
})

test("A7. registry 返回 prerelease → 不当作正式更新", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(`${NEWER}-beta.1`)
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, false, "预发布版本不应被当成稳定更新")
})

// ---------------------------------------------------------------------------
// B. 普通插件回归：精确锁定 / 裸包名 / 本地目录 / 配置规则都不变
// ---------------------------------------------------------------------------

test("B1. 普通插件精确锁定且有更新 → 仍显示精确锁定，无更新按钮", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  1.0.0  opencode-notify@1.0.0"])
  // 官方 check 报告有更新，但精确锁定仍跳过。
  process.env.FAKE_CLI_CHECK = "Server\n  opencode-notify-callback 1.0.0 \u2192 1.2.0\n"
  const result = await admin.updates()
  const row = result.items.find((item) => item.name === "opencode-notify")!
  assert.equal(row.pinned, true)
  assert.equal(row.hasUpdate, false, "普通插件精确锁定仍不提供更新")
  assert.match(row.reason, /精确|跳过/)
  assert.equal(row.selfUpdate, undefined, "普通插件不标记 selfUpdate")
})

test("B2. 普通插件裸包名且有更新 → 正常显示可更新", async () => {
  await writeConfig(["opencode-usage-center"])
  process.env.FAKE_CLI_LIST = listOutput(["usage-center  0.3.2  opencode-usage-center"])
  process.env.FAKE_CLI_CHECK = "Server\n  usage-center 0.3.2 \u2192 0.4.0\n"
  const result = await admin.updates()
  const row = result.items.find((item) => item.name === "opencode-usage-center")!
  assert.equal(row.hasUpdate, true)
  assert.equal(row.latest, "0.4.0")
  assert.equal(row.selfUpdate, undefined)
})

test("B3. 本地目录插件仍跳过官方更新", async () => {
  const dir = join(temp, "dir-plugin")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dir-plugin", version: "1.0.0" }), "utf8")
  await writeConfig([dir])
  const result = await admin.updates()
  const row = result.items.find((item) => item.kind === "path")!
  assert.equal(row.official, "skipped")
  assert.equal(row.managed, false)
  assert.match(row.reason, /本地目录/)
})

test("B4. 配置规则不作为插件包检查更新", async () => {
  await writeConfig(["-acme.reviewer", "*"])
  const result = await admin.updates()
  assert.equal(result.items.length, 2)
  assert.equal(result.items.every((item) => item.official === "skipped"), true)
})

// ---------------------------------------------------------------------------
// C. 自身升级目标版本与安全失败路径（经 update() 体现 latestForSelf）
// ---------------------------------------------------------------------------

test("C1. registry 给出目标版本 → 进入自升级并成功加载", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(NEWER)
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${NEWER}  opencode-plugin-hub@${NEWER}`])
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${NEWER}`])
  assert.deepEqual(calls().filter((line) => line.startsWith("plugin update")), [], "不走 plugin update")
  assert.equal(result.stages?.runtime, "loaded")
})

test("C2. registry 请求失败 → 不修改配置", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry("throw")
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, false)
  assert.match(result.message, /npm registry|目标版本/)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${SELF_VERSION}`], "配置未改动")
})

test("C3. registry 返回无效版本 → 不修改配置", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry("garbage-version")
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, false)
  assert.match(result.message, /不是有效稳定版本/)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${SELF_VERSION}`])
})

test("C4. registry 版本不高于当前 → 不修改配置", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(OLDER)
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, false)
  assert.match(result.message, /不高于当前/)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${SELF_VERSION}`])
})

test("C5. 目标包准备失败 → 旧配置保留", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(NEWER)
  process.env.FAKE_CLI_FAIL = "add"
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, false)
  assert.deepEqual(await readPlugins(), [`opencode-plugin-hub@${SELF_VERSION}`], "准备失败不动配置")
  assert.equal(result.stages?.config, "unchanged")
})

test("C6. 新版本未被宿主确认 → 不返回成功", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  mockSelfRegistry(NEWER)
  // 配置切到目标版本，但 plugin list 仍只报旧版本（宿主未确认新构建）。
  process.env.FAKE_CLI_LIST = listOutput([`plugin-hub  ${SELF_VERSION}  opencode-plugin-hub@${NEWER}`])
  const result = await admin.update(`opencode-plugin-hub@${SELF_VERSION}`)
  assert.equal(result.ok, false, "宿主未确认加载时不能报成功")
  assert.equal(result.stages?.runtime, "unknown")
})
