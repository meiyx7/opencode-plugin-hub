/**
 * 更新检测真正解耦的时序证明（最小修复专项）。
 *
 * 关键：不是"把 CLI 超时设成 300ms 再断言整体 8 秒内返回"那种伪证，而是用确定性的
 * 相对时序 + 零 CLI 调用证据，证明 registry 结果先于 CLI 结果独立交付：
 * - registryUpdates() 全程不触发任何 opencode 命令（FAKE_CLI_LOG 为空）；
 * - 并发发起时，registry 阶段已 resolve，而 CLI 阶段此刻仍未 settle（CLI 被挂起）；
 * - CLI 超时/失败后，registry 阶段拿到的自身更新结果仍然保留；
 * - CLI 正常完成后，普通插件结果由官方阶段独立补充，且不含 registry 已定案的行。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
function configPath(): string { return join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json") }
function cliLogPath(): string { return join(temp, "cli.log") }
async function writeConfig(plugins: unknown[]): Promise<void> {
  await writeFile(configPath(), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8")
}
function cliCalls(): string[] {
  const path = cliLogPath()
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0)
}
function listOutput(rows: string[]): string { return ["ID  VERSION  SOURCE", ...rows].join("\n") }
function selfRow(items: readonly admin.UpdateInfoValue[]): admin.UpdateInfoValue | undefined {
  return items.find((item) => item.name === "opencode-plugin-hub")
}

/** registry only answers the hub's /latest with a controlled newer version; all else 404. */
function mockRegistry(version: string = NEWER): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/-/ping")) return new Response("{}", { status: 200 })
    if (url.includes("/opencode-plugin-hub/latest")) {
      return new Response(JSON.stringify({ name: "opencode-plugin-hub", version }), { status: 200 })
    }
    return new Response("", { status: 404 })
  }) as typeof fetch
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "update-timing-"))
  await mkdir(join(temp, "config", "opencode"), { recursive: true })
  await mkdir(join(temp, "cache"), { recursive: true })
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  process.env.XDG_CACHE_HOME = join(temp, "cache")
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://plugin-hub.test"
  delete process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS
  process.env.FAKE_CLI_LOG = cliLogPath()
  process.env.FAKE_CLI_LIST = listOutput([])
  process.env.FAKE_CLI_CHECK = "Server\n  (no rows)\n"
  delete process.env.FAKE_CLI_FAIL
  delete process.env.FAKE_CLI_HANG
  delete process.env.FAKE_CLI_MODE
  resetStoreCache()
  await setRegistryMode("auto")
  resetRegistryCache()
  mockRegistry()
  await writeConfig([`opencode-plugin-hub@${SELF_VERSION}`, "opencode-usage-center"])
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

test("T1. CLI 挂起时 registry 结果先行交付：registry 阶段零 CLI 调用，且 CLI 此刻未 settle", async () => {
  // CLI 的 list 与 check 都挂起，1500ms 后才由 hub 超时结束；不设更短超时来伪造速度。
  process.env.FAKE_CLI_HANG = "list,check"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "1500"

  let cliSettled = false
  const cliPromise = admin.officialUpdates().then((value) => {
    cliSettled = true
    return value
  })

  const start = Date.now()
  const reg = await admin.registryUpdates()
  const elapsed = Date.now() - start

  // 证据 1：自身更新结果已经交付，且不等挂起的 CLI。
  const self = selfRow(reg.items)!
  assert.equal(self.selfUpdate, true)
  assert.equal(self.hasUpdate, true, "registry 发现新版本，应立即可见")
  assert.equal(self.latest, NEWER)
  assert.equal(reg.registryOnly, true)
  assert.ok(elapsed < 1000, `registry 应远早于 1500ms 的 CLI 超时返回，实际 ${elapsed}ms`)

  // 证据 2：registry 阶段返回时，CLI 阶段尚未完成——结果确实先于 CLI 独立交付。
  assert.equal(cliSettled, false, "registry 结果返回时 CLI 阶段不应已 settle")
  // 证据 3：registry 阶段本身没有触发任何 opencode 命令（与超时无关的解耦证明）。
  assert.deepEqual(cliCalls(), [], "registryUpdates 不应调用 plugin list/check")

  // 收尾：等 CLI 超时结束，避免挂起子进程残留。
  const cli = await cliPromise
  assert.equal(cliSettled, true)
  assert.notEqual(cli.error, "", "CLI 阶段最终失败应如实报告")
})

test("T2. plugin list 延迟不影响自身更新结果", async () => {
  process.env.FAKE_CLI_HANG = "list"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "1200"

  let cliSettled = false
  const cliPromise = admin.officialUpdates().then((value) => { cliSettled = true; return value })
  const reg = await admin.registryUpdates()

  assert.equal(selfRow(reg.items)!.hasUpdate, true, "list 挂起不影响自身更新")
  assert.equal(cliSettled, false, "registry 结果先于 list 完成")
  assert.deepEqual(cliCalls(), [], "registry 阶段未触发 list")
  await cliPromise
})

test("T3. plugin check 延迟不影响自身更新结果", async () => {
  process.env.FAKE_CLI_HANG = "check"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "1200"

  let cliSettled = false
  const cliPromise = admin.officialUpdates().then((value) => { cliSettled = true; return value })
  const reg = await admin.registryUpdates()

  assert.equal(selfRow(reg.items)!.hasUpdate, true, "check 挂起不影响自身更新")
  assert.equal(cliSettled, false, "registry 结果先于 check 完成")
  assert.deepEqual(cliCalls(), [], "registry 阶段未触发 check")
  await cliPromise
})

test("T4. CLI 最终失败时，已得的自身更新结果仍然保留", async () => {
  // registry 阶段先拿到自身结果（此对象此后不再变化）。
  const reg = await admin.registryUpdates()
  const selfBefore = selfRow(reg.items)!
  assert.equal(selfBefore.hasUpdate, true)

  // CLI 阶段超时失败。
  process.env.FAKE_CLI_HANG = "list,check"
  process.env.OPENCODE_PLUGIN_HUB_CLI_TIMEOUT_MS = "400"
  const cli = await admin.officialUpdates()

  assert.notEqual(cli.error, "", "CLI 失败应如实返回")
  assert.equal(cli.items.some((item) => item.name === "opencode-plugin-hub"), false, "CLI 阶段不得返回自身行")
  // registry 结果对象未被 CLI 阶段触碰：用户已看到的更新仍在。
  const selfAfter = selfRow(reg.items)!
  assert.equal(selfAfter.hasUpdate, true)
  assert.equal(selfAfter.latest, NEWER)
})

test("T5. CLI 正常完成后，普通插件结果独立补充且不含 registry 已定案的行", async () => {
  process.env.FAKE_CLI_LIST = listOutput([
    `plugin-hub  ${SELF_VERSION}  opencode-plugin-hub`,
    "usage-center  0.3.2  opencode-usage-center",
  ])
  process.env.FAKE_CLI_CHECK = "Server\n  usage-center 0.3.2 → 0.4.0\n"

  const reg = await admin.registryUpdates()
  const cli = await admin.officialUpdates()

  assert.equal(cli.error, "")
  assert.equal(selfRow(reg.items)!.hasUpdate, true, "自身更新由 registry 阶段给出")
  assert.equal(
    cli.items.some((item) => item.selfUpdate || item.pinnedRegistryUpdate),
    false,
    "官方阶段不得携带 registry 定案的自身/精确锁定行，避免覆盖",
  )
  const usage = cli.items.find((item) => item.name === "opencode-usage-center")!
  assert.equal(usage.official, "outdated", "普通插件仍由官方 CLI 决定")
  assert.equal(usage.hasUpdate, true)
  assert.equal(usage.latest, "0.4.0")
})

test("T6. 无 CLI 时自身更新仍能正常检测，官方阶段如实报告", async () => {
  admin.useCli(undefined)
  const reg = await admin.registryUpdates()
  const self = selfRow(reg.items)!
  assert.equal(self.selfUpdate, true)
  assert.equal(self.hasUpdate, true)
  assert.equal(self.latest, NEWER)

  const cli = await admin.officialUpdates()
  assert.match(cli.error, /找不到 opencode CLI|没有 CLI/)
  assert.equal(cli.items.some((item) => item.selfUpdate), false, "官方阶段不含自身行")
  const usage = cli.items.find((item) => item.name === "opencode-usage-center")!
  assert.equal(usage.official, "unknown", "无 CLI 时普通插件保持未知，不谎报最新")
  assert.equal(selfRow(reg.items)!.hasUpdate, true, "registry 结果不受无 CLI 影响")
})
