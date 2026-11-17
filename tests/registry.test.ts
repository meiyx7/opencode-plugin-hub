/**
 * Registry 探测与故障回退专项。
 *
 * 网络全部由 fetch 桩驱动：探测走 `/-/ping`，实际查询走 `<base><path>`。
 * 覆盖：自动模式优先级、探测超时、请求超时回退、连接失败回退、5xx 回退、
 * 404 不回退、双源失败、单一模式隔离、环境变量优先级、模式切换缓存失效、
 * 来源标记、镜像旧版本、无效数据不被认定为成功。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  RegistryUnavailable,
  effectiveMode,
  registryFetchDetailed,
  resetRegistryCache,
} from "../src/gui/registry.ts"
import { resetStoreCache, setRegistryMode } from "../src/gui/store.ts"

const OFFICIAL = "https://registry.npmjs.org"
const MIRROR = "https://registry.npmmirror.com"
const PATH = "/fixture-plugin/latest"
const REAL_FETCH = globalThis.fetch

type Reply = Response | Error
let ping: Record<string, Reply> = {}
let query: Record<string, Reply> = {}
let calls: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
function timeout(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
}
function refused(): Error {
  return Object.assign(new Error("fetch failed"), { name: "TypeError" })
}

globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String(input)
  calls.push(url)
  const reply = url.endsWith("/-/ping")
    ? (ping[url.replace("/-/ping", "")] ?? json({ ok: true }))
    : (query[url] ?? query["*"] ?? json({}, 404))
  if (reply instanceof Error) throw reply
  return reply
}) as typeof fetch

const ENV_KEYS = ["OPENCODE_PLUGIN_HUB_REGISTRY", "XDG_CACHE_HOME"] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

beforeEach(async () => {
  process.env.XDG_CACHE_HOME = `/tmp/registry-test-cache-${process.pid}-${Math.random().toString(36).slice(2)}`
  delete process.env.OPENCODE_PLUGIN_HUB_REGISTRY
  resetStoreCache()
  resetRegistryCache()
  await setRegistryMode("auto")
  ping = {}
  query = {}
  calls = []
})

afterEach(() => {
  resetStoreCache()
  resetRegistryCache()
})

after(() => {
  globalThis.fetch = REAL_FETCH
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

function answered(url: string): boolean {
  return calls.includes(`${url}${PATH}`)
}

// 1. 自动模式官方正常 → 用官方
test("R1. 自动模式官方正常优先用官方，不访问镜像", async () => {
  query[`${OFFICIAL}${PATH}`] = json({ version: "1.2.0" })
  const { response, resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(response.status, 200)
  assert.equal(resolution.mode, "auto")
  assert.equal(resolution.registryUsed, OFFICIAL)
  assert.equal(resolution.fallbackUsed, false)
  assert.equal(answered(MIRROR), false)
})

// 2. 官方探测超时，镜像正常 → 用镜像
test("R2. 官方探测超时、镜像正常 → 用镜像并标记回退", async () => {
  ping[OFFICIAL] = timeout()
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.registryUsed, MIRROR)
  assert.equal(resolution.fallbackUsed, true)
  assert.match(resolution.registryMessage, /自动切换/)
})

// 3. 官方探测正常但实际请求超时 → 回退镜像
test("R3. 官方探测正常、实际请求超时 → 尝试镜像且不误判不存在", async () => {
  query[`${OFFICIAL}${PATH}`] = timeout()
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.registryUsed, MIRROR)
  assert.equal(resolution.fallbackUsed, true)
  assert.match(resolution.registryMessage, /请求超时/)
})

// 4. 官方连接失败 → 回退镜像
test("R4. 官方连接失败 → 回退镜像", async () => {
  query[`${OFFICIAL}${PATH}`] = refused()
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.registryUsed, MIRROR)
  assert.equal(resolution.fallbackUsed, true)
})

// 5. 官方 5xx → 回退
test("R5. 官方 HTTP 5xx → 按规则尝试备用源", async () => {
  query[`${OFFICIAL}${PATH}`] = json({}, 503)
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.registryUsed, MIRROR)
  assert.equal(resolution.fallbackUsed, true)
  assert.match(resolution.registryMessage, /503/)
})

// 6. 官方 404 → 不作为网络故障回退
test("R6. 官方 404 → 当作明确不存在，不回退镜像", async () => {
  query[`${OFFICIAL}${PATH}`] = new Response("", { status: 404 })
  const { response, resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(response.status, 404)
  assert.equal(resolution.registryUsed, OFFICIAL)
  assert.equal(resolution.fallbackUsed, false)
  assert.equal(answered(MIRROR), false)
})

// 7 + 8. 双源失败 → 明确失败且不返回虚假最新
test("R7. 两源都失败 → 抛 RegistryUnavailable，标记实际尝试过的源", async () => {
  query[`${OFFICIAL}${PATH}`] = timeout()
  query[`${MIRROR}${PATH}`] = json({}, 500)
  await assert.rejects(
    () => registryFetchDetailed(PATH, { timeoutMs: 8000 }),
    (error: unknown) => {
      assert.ok(error instanceof RegistryUnavailable)
      assert.deepEqual([...error.tried], [OFFICIAL, MIRROR])
      assert.ok(error.resolution && error.resolution.registryUsed === "")
      assert.match(error.resolution!.registryError, /没有确认任何更新/)
      return true
    },
  )
})

// 9. 官方模式不访问镜像
test("R9. 官方模式只访问官方，官方失败不切换", async () => {
  await setRegistryMode("official")
  assert.equal(effectiveMode(), "official")
  query[`${OFFICIAL}${PATH}`] = timeout()
  await assert.rejects(() => registryFetchDetailed(PATH, { timeoutMs: 8000 }), RegistryUnavailable)
  assert.equal(answered(MIRROR), false)
})

// 10. 镜像模式不访问官方
test("R10. 镜像模式只访问镜像", async () => {
  await setRegistryMode("mirror")
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.registryUsed, MIRROR)
  assert.equal(answered(OFFICIAL), false)
})

// 11. 环境变量优先级最高
test("R11. 环境变量指定的源优先级高于 UI 选择", async () => {
  await setRegistryMode("official")
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://custom.registry.test"
  assert.equal(effectiveMode(), "custom")
  query["http://custom.registry.test/latest"] = json({ version: "9.9.9" })
  // 用 custom 源自己的路径；这里用 /latest 而非固定 PATH
  const { response, resolution } = await registryFetchDetailed("/latest", { timeoutMs: 8000 })
  assert.equal(response.status, 200)
  assert.equal(resolution.mode, "custom")
  assert.equal(resolution.registryUsed, "http://custom.registry.test")
  assert.equal(answered(MIRROR), false)
})

// 12. 模式切换后不使用旧模式的探测结果
test("R12. 切换模式后重新探测，不复用旧模式缓存", async () => {
  await setRegistryMode("mirror")
  const first = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(first.resolution.registryUsed, MIRROR)
  await setRegistryMode("official")
  query[`${OFFICIAL}${PATH}`] = json({ version: "2.0.0" })
  const second = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(second.resolution.registryUsed, OFFICIAL)
  assert.equal(second.resolution.mode, "official")
})

// 13. 自动回退携带最终使用源
test("R13. 自动回退结果携带 fallbackUsed 与最终源", async () => {
  query[`${OFFICIAL}${PATH}`] = refused()
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.mode, "auto")
  assert.equal(resolution.fallbackUsed, true)
  assert.equal(resolution.registryUsed, MIRROR)
  assert.equal(resolution.registryError, "")
})

// 14. 镜像返回旧版本保留镜像来源
test("R14. 镜像返回旧版本时结果仍标记来自镜像（可能被认定滞后）", async () => {
  query[`${OFFICIAL}${PATH}`] = timeout()
  query[`${MIRROR}${PATH}`] = json({ version: "1.1.0" })
  const { resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(resolution.registryUsed, MIRROR)
  assert.match(resolution.registryMessage, /镜像/)
})

// 15. 无效 JSON / 版本不算成功，由上层 admin 判定；这里确认 200 仍被如实返回来源
test("R15. 源返回 200 但内容无效：registry 层如实返回来源，不伪造当前版本", async () => {
  query[`${OFFICIAL}${PATH}`] = new Response("not-json", { status: 200 })
  const { response, resolution } = await registryFetchDetailed(PATH, { timeoutMs: 8000 })
  assert.equal(response.status, 200)
  assert.equal(resolution.registryUsed, OFFICIAL)
  // 解析责任在 admin.npmLatest；此处证明 registry 层没有把非法响应当成功版本。
  assert.equal(resolution.registryError, "")
})
