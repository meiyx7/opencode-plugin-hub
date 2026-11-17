/**
 * 更新检测解耦专项（阶段 2）。
 *
 * 证明两条路径互不阻塞、互不覆盖：
 * - 插件中心自身更新由 registry 决定，不依赖 CLI，也不被 list/check 的超时拖住；
 * - 普通非精确锁定插件仍由官方 plugin check 决定；
 * - 精确锁定 npm 包经 registry 发现稳定更新，失败不谎报最新，预发布不作为目标。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as admin from "../src/gui/admin.ts"
import { resetStoreCache, setRegistryMode } from "../src/gui/store.ts"
import { resetRegistryCache } from "../src/gui/registry.ts"

const FIXTURE = join(process.cwd(), "tests", "fixtures", "opencode-cli.mjs")
const SELF_VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version
const NEWER = `${Number(SELF_VERSION.split(".")[0])}.${Number(SELF_VERSION.split(".")[1])}.${Number(SELF_VERSION.split(".")[2]) + 50}`

const REAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_PLUGIN_HUB_REGISTRY", "OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS",
  "FAKE_CLI_LOG", "FAKE_CLI_LIST", "FAKE_CLI_CHECK", "FAKE_CLI_FAIL", "FAKE_CLI_HANG", "FAKE_CLI_MODE",
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

let temp = ""
function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json")
}
async function writeConfig(plugins: unknown[]): Promise<void> {
  await writeFile(configPath(), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8")
}
function selfRow(result: admin.UpdatesResultValue): admin.UpdateInfoValue | undefined {
  return result.items.find((item) => item.name === "opencode-plugin-hub")
}
function listOutput(rows: string[]): string {
  return ["ID  VERSION  SOURCE", ...rows].join("\n")
}

/** registry only answers the hub's /latest with a controlled version; all else 404. */
function mockRegistry(version: string | "throw" = NEWER): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/-/ping")) return new Response("{}", { status: 200 })
    if (url.includes("/opencode-plugin-hub/latest")) {
      if (version === "throw") throw new Error("registry unreachable")
      return new Response(JSON.stringify({ name: "opencode-plugin-hub", version }), { status: 200 })
    }
    // Pinned plugin registry probe.
    if (url.includes("/opencode-notify/latest")) {
      return new Response(JSON.stringify({ name: "opencode-notify", version: "1.2.0" }), { status: 200 })
    }
    return new Response("", { status: 404 })
  }) as typeof fetch
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "update-decouple-"))
  await mkdir(join(temp, "config", "opencode"), { recursive: true })
  await mkdir(join(temp, "cache"), { recursive: true })
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  process.env.XDG_CACHE_HOME = join(temp, "cache")
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://plugin-hub.test"
  delete process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS
  process.env.FAKE_CLI_LOG = join(temp, "cli.log")
  process.env.FAKE_CLI_LIST = listOutput([])
  process.env.FAKE_CLI_CHECK = "Server\n  (no rows)\n"
  delete process.env.FAKE_CLI_FAIL
  delete process.env.FAKE_CLI_HANG
  delete process.env.FAKE_CLI_MODE
  resetStoreCache()
  await setRegistryMode("auto")
  resetRegistryCache()
  mockRegistry()
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

// ---- 自身更新独立于 CLI ----

test("D1. 没有 CLI 仍能检测插件中心自身更新", async () => {
  admin.useCli(undefined)
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.selfUpdate, true)
  assert.equal(self.hasUpdate, true)
  assert.equal(self.latest, NEWER)
  assert.match(result.cliError ?? "", /找不到 opencode CLI/)
  assert.equal(result.registry.registryUsed, "http://plugin-hub.test")
})

test("D2. plugin list 超时不影响自身更新检测", async () => {
  process.env.FAKE_CLI_HANG = "list"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "300"
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`, "opencode-usage-center"])
  process.env.FAKE_CLI_CHECK = "Server\n  usage-center 0.3.2 (current)\n"
  const start = Date.now()
  const result = await admin.updates()
  const elapsed = Date.now() - start
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, true, "registry 结果不受 list 超时影响")
  assert.ok(elapsed < 8000, `不应被 30s 默认超时拖住，实际 ${elapsed}ms`)
  assert.match(result.cliError ?? "", /官方|超时|失败/)
})

test("D3. plugin check 超时不影响自身更新检测", async () => {
  process.env.FAKE_CLI_HANG = "check"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "300"
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, true)
  assert.match(result.cliError ?? "", /官方|超时|失败/)
})

test("D4. 普通插件检查失败不覆盖自身更新结果", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`, "opencode-usage-center"])
  process.env.FAKE_CLI_LIST = listOutput([
    `plugin-hub  ${SELF_VERSION}  opencode-plugin-hub`,
    "usage-center  0.3.2  opencode-usage-center",
  ])
  // check-fail：exit 1 但 stdout 仍给出表，其中一个插件报告 failed。
  process.env.FAKE_CLI_CHECK = "Server\n  usage-center (check failed)\n  unable to resolve\n"
  process.env.FAKE_CLI_MODE = "check-fail"
  const result = await admin.updates()
  const self = selfRow(result)!
  const usage = result.items.find((item) => item.name === "opencode-usage-center")!
  assert.equal(self.hasUpdate, true, "自身结果不被普通插件失败覆盖")
  assert.equal(usage.official, "failed")
})

// ---- registry 失败与无效版本 ----

test("D5. registry 失败：自身标记失败，不谎报最新，registry 状态带错误", async () => {
  mockRegistry("throw")
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.hasUpdate, false)
  assert.equal(self.official, "failed")
  assert.notEqual(result.registry.error, "")
})

test("D6. 精确锁定自身版本仍能检测更新（沿用既有语义）", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  const result = await admin.updates()
  const self = selfRow(result)!
  assert.equal(self.pinned, true)
  assert.equal(self.hasUpdate, true)
})

// ---- 精确锁定普通插件 ----

test("D7. 精确锁定 npm 包经 registry 发现新稳定版，显示确认型更新", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  process.env.FAKE_CLI_LIST = listOutput(["opencode-notify-callback  1.0.0  opencode-notify@1.0.0"])
  process.env.FAKE_CLI_CHECK = "Server\n  (no rows)\n"
  const result = await admin.updates()
  const row = result.items.find((item) => item.name === "opencode-notify")!
  assert.equal(row.pinned, true)
  assert.equal(row.pinnedRegistryUpdate, true)
  assert.equal(row.hasUpdate, true)
  assert.equal(row.latest, "1.2.0")
  assert.match(row.reason ?? "", /确认|精确锁定/)
})

test("D8. 精确锁定 npm 包 registry 查询失败：不显示最新也不显示更新", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/-/ping")) return new Response("{}", { status: 200 })
    if (url.includes("/opencode-notify/latest")) throw new Error("down")
    return new Response("", { status: 404 })
  }) as typeof fetch
  await writeConfig(["opencode-notify@1.0.0"])
  const result = await admin.updates()
  const row = result.items.find((item) => item.name === "opencode-notify")!
  assert.equal(row.hasUpdate, false)
  assert.notEqual(row.official, "current")
  assert.match(row.reason ?? "", /失败|无法确认/)
})

test("D9. 预发布版本不作为精确锁定的更新目标", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/-/ping")) return new Response("{}", { status: 200 })
    if (url.includes("/opencode-notify/latest")) {
      return new Response(JSON.stringify({ version: "9.9.9-beta.1" }), { status: 200 })
    }
    return new Response("", { status: 404 })
  }) as typeof fetch
  await writeConfig(["opencode-notify@1.0.0"])
  const result = await admin.updates()
  const row = result.items.find((item) => item.name === "opencode-notify")!
  assert.equal(row.hasUpdate, false)
})

test("D10. 本地目录与配置规则不进入 registry 更新流程", async () => {
  const dir = join(temp, "dir-plugin")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dir-plugin", version: "1.0.0" }), "utf8")
  await writeConfig([dir, "-acme.reviewer"])
  const result = await admin.updates()
  for (const row of result.items) {
    assert.equal(row.pinnedRegistryUpdate, undefined)
    assert.equal(row.official, "skipped")
  }
})

test("D11. registry 汇总标记实际使用源与 mode", async () => {
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`])
  const result = await admin.updates()
  assert.equal(result.registry.mode, "custom")
  assert.equal(result.registry.registryUsed, "http://plugin-hub.test")
})
