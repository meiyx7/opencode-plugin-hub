/**
 * 下载量统计专项测试。
 *
 * 全部网络请求都替换成受控的 fetch 桩；只有第四阶段的 scripts/verify-downloads.mjs
 * 会真正访问 npm 官方接口。这里断言的是：请求路径、数据源唯一性、周/月独立性、
 * 异常数据处理、缓存语义，以及列表与详情共用同一份数据。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NPM_DOWNLOADS_API, downloadsFor } from "../src/gui/registry.ts"
import * as admin from "../src/gui/admin.ts"
import { countTitle, countWithUnit, formatCount } from "../src/gui/download-format.ts"

const REAL_NOW = Date.now
const REAL_FETCH = globalThis.fetch

let clock = 0
let calls: string[] = []
let route: (url: string) => Response | Promise<Response> = () => new Response("", { status: 404 })

// A config directory that does not exist keeps readConfig() free of the user's real opencode.json.
process.env.XDG_CONFIG_HOME = join(process.cwd(), "node_modules", ".cache", "plugin-hub-test-config")
process.env.XDG_CACHE_HOME = join(process.cwd(), "node_modules", ".cache", "plugin-hub-test-cache")

globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String(input)
  calls.push(url)
  return route(url)
}) as typeof fetch

beforeEach(() => {
  clock = 1_760_000_000_000
  Date.now = () => clock
  calls = []
  route = () => new Response("", { status: 404 })
})

afterEach(() => {
  Date.now = REAL_NOW
})

after(() => {
  globalThis.fetch = REAL_FETCH
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function pointUrl(period: "last-week" | "last-month", name: string): string {
  return `${NPM_DOWNLOADS_API}/point/${period}/${encodeURIComponent(name)}`
}

function pointBody(url: string, count: unknown): { downloads: unknown; package: string } {
  const rest = url.split("/point/")[1] ?? ""
  const [, ...nameParts] = rest.split("/")
  return { downloads: count, package: decodeURIComponent(nameParts.join("/")) }
}

/** A normal official answer, with the package name taken from the requested URL. */
function pointOk(url: string, count: number): Response {
  return json(pointBody(url, count))
}

function isPoint(url: string): boolean {
  return url.includes("/downloads/point/")
}

function pointCalls(): string[] {
  return calls.filter(isPoint)
}

const WEEK = 1511
const MONTH = 2204

// ---------------------------------------------------------------------------
// 1. 周/月 API 路径正确性
// ---------------------------------------------------------------------------

test("周、月分别请求官方 point 接口，不再使用 range 累加", async () => {
  const name = "fixture-path"
  route = (url) => (isPoint(url) ? pointOk(url, url.includes("last-week") ? WEEK : MONTH) : new Response("", { status: 404 }))

  const counts = await downloadsFor(name)

  assert.deepEqual(counts, { weekly: WEEK, monthly: MONTH })
  assert.deepEqual(pointCalls().sort(), [pointUrl("last-week", name), pointUrl("last-month", name)].sort())
  assert.equal(pointCalls().length, 2, "恰好两次 point 请求")
  assert.ok(pointCalls().every((url) => !url.includes("/range/")), "不得出现 range 接口")
})

test("scoped 包名按 npm 规定的路径编码", async () => {
  const name = "@scope/fixture-pkg"
  route = (url) => (isPoint(url) ? pointOk(url, url.includes("last-week") ? 1 : 2) : new Response("", { status: 404 }))

  const counts = await downloadsFor(name)
  assert.deepEqual(counts, { weekly: 1, monthly: 2 })
  assert.ok(pointCalls().every((url) => url.startsWith(NPM_DOWNLOADS_API)))
})

// ---------------------------------------------------------------------------
// 2. 官方数据源唯一性
// ---------------------------------------------------------------------------

test("下载量只来自 api.npmjs.org，强制 registry 与镜像都不参与", async () => {
  const name = "fixture-official-only"
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "https://registry.npmmirror.com"
  try {
    route = (url) => (isPoint(url) ? pointOk(url, 7) : new Response("", { status: 404 }))
    await downloadsFor(name)
    assert.equal(NPM_DOWNLOADS_API, "https://api.npmjs.org/downloads")
    assert.equal(pointCalls().length, 2)
    assert.ok(pointCalls().every((url) => new URL(url).hostname === "api.npmjs.org"))
    assert.ok(calls.every((url) => !url.includes("npmmirror")), "不得请求镜像")
  } finally {
    delete process.env.OPENCODE_PLUGIN_HUB_REGISTRY
  }
})

test("官方接口失败时也不回退到镜像下载量", async () => {
  route = (url) => (isPoint(url) ? new Response("down", { status: 503 }) : new Response("", { status: 404 }))
  const counts = await downloadsFor("fixture-no-fallback")
  assert.deepEqual(counts, {})
  assert.ok(calls.every((url) => !url.includes("npmmirror")))
  assert.equal(pointCalls().length, 2)
})

test("源码中不存在 range 累加、镜像下载量端点或搜索索引下载量的读取", () => {
  const registry = readFileSync(join(process.cwd(), "src/gui/registry.ts"), "utf8")
  const adminSource = readFileSync(join(process.cwd(), "src/gui/admin.ts"), "utf8")
  assert.ok(!registry.includes("range/last-month"))
  assert.ok(!registry.includes("npmmirror.com/downloads"))
  assert.ok(!adminSource.includes("item.downloads"))
  assert.ok(registry.includes("point/${period}"))
})

// ---------------------------------------------------------------------------
// 3. 周/月接口独立失败
// ---------------------------------------------------------------------------

test("周接口失败不影响月接口", async () => {
  route = (url) => {
    if (!isPoint(url)) return new Response("", { status: 404 })
    if (url.includes("last-week")) return new Response("", { status: 500 })
    return pointOk(url, MONTH)
  }
  const counts = await downloadsFor("fixture-week-fails")
  assert.deepEqual(counts, { monthly: MONTH })
})

test("月接口失败不影响周接口", async () => {
  route = (url) => {
    if (!isPoint(url)) return new Response("", { status: 404 })
    // A rejected fetch models a network-level timeout deterministically.
    if (url.includes("last-month")) throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
    return pointOk(url, WEEK)
  }
  const counts = await downloadsFor("fixture-month-fails")
  assert.deepEqual(counts, { weekly: WEEK })
})

test("两个接口同时失败时结果为空对象，不是 0", async () => {
  route = (url) => (isPoint(url) ? new Response("", { status: 502 }) : new Response("", { status: 404 }))
  const counts = await downloadsFor("fixture-both-fail")
  assert.deepEqual(counts, {})
  assert.equal(counts.weekly, undefined)
  assert.equal(counts.monthly, undefined)
})

// ---------------------------------------------------------------------------
// 4. 异常响应及非法数据
// ---------------------------------------------------------------------------

const BAD_BODIES: readonly [string, unknown][] = [
  ["downloads 是字符串", "1511"],
  ["downloads 是 null", null],
  ["downloads 缺失", undefined],
  ["downloads 为 NaN 文本", "not-a-number"],
  ["downloads 为负数", -3],
  ["downloads 为小数", 1.5],
  ["下载量字段是数组", [1, 2, 3]],
]

test("异常响应与非法数据一律视为不可用", async () => {
  for (const [index, [label, value]] of BAD_BODIES.entries()) {
    const name = `fixture-invalid-${index}`
    route = (url) => {
      if (!isPoint(url)) return new Response("", { status: 404 })
      const body = pointBody(url, value)
      if (value === undefined) delete (body as { downloads?: unknown }).downloads
      return json(body)
    }
    const counts = await downloadsFor(name)
    assert.deepEqual(counts, {}, `${label} 不应产生数字`)
  }
})

test("非 200 状态、非法 JSON、错误包名都不产生 0", async () => {
  const cases: readonly ((url: string) => Response)[] = [
    () => new Response("", { status: 404 }),
    () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    (url) => json({ downloads: 999, package: `another-${pointBody(url, 0).package}` }),
    () => new Response("null", { status: 200 }),
    () => new Response("[]", { status: 200 }),
  ]
  for (const [index, make] of cases.entries()) {
    route = (url) => (isPoint(url) ? make(url) : new Response("", { status: 404 }))
    const counts = await downloadsFor(`fixture-bad-response-${index}`)
    assert.deepEqual(counts, {})
  }
})

test("请求超时只影响该指标", async () => {
  route = (url) => {
    if (!isPoint(url)) return new Response("", { status: 404 })
    if (url.includes("last-week")) {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    }
    return pointOk(url, MONTH)
  }
  assert.deepEqual(await downloadsFor("fixture-timeout"), { monthly: MONTH })
})

// ---------------------------------------------------------------------------
// 5. 缓存命中、过期、失败缓存、并发去重
// ---------------------------------------------------------------------------

test("成功结果在 TTL 内命中缓存", async () => {
  route = (url) => (isPoint(url) ? pointOk(url, url.includes("last-week") ? WEEK : MONTH) : new Response("", { status: 404 }))
  const name = "fixture-cache-hit"
  assert.deepEqual(await downloadsFor(name), { weekly: WEEK, monthly: MONTH })
  assert.deepEqual(await downloadsFor(name), { weekly: WEEK, monthly: MONTH })
  assert.equal(pointCalls().length, 2, "第二次调用不再发请求")
})

test("成功缓存过期后重新请求", async () => {
  route = (url) => (isPoint(url) ? pointOk(url, 1) : new Response("", { status: 404 }))
  const name = "fixture-cache-expire"
  await downloadsFor(name)
  clock += 5 * 60 * 1000 - 1
  await downloadsFor(name)
  assert.equal(pointCalls().length, 2)
  clock += 1
  await downloadsFor(name)
  assert.equal(pointCalls().length, 4)
})

test("失败按较短 TTL 缓存，恢复后重新读取成功值", async () => {
  let healthy = false
  route = (url) =>
    isPoint(url) ? (healthy ? pointOk(url, WEEK) : new Response("", { status: 503 })) : new Response("", { status: 404 })
  const name = "fixture-failure-cache"
  assert.deepEqual(await downloadsFor(name), {})
  assert.equal(pointCalls().length, 2)

  healthy = true
  clock += 60 * 1000 - 1
  assert.deepEqual(await downloadsFor(name), {}, "失败缓存未过期时不重试")
  assert.equal(pointCalls().length, 2)

  clock += 1
  assert.deepEqual(await downloadsFor(name), { weekly: WEEK, monthly: WEEK })
  assert.equal(pointCalls().length, 4)

  clock += 5 * 60 * 1000 - 1
  await downloadsFor(name)
  assert.equal(pointCalls().length, 4, "成功值用较长的 TTL")
})

test("周失败、月成功各自按自己的 TTL 过期", async () => {
  let weekHealthy = false
  route = (url) => {
    if (!isPoint(url)) return new Response("", { status: 404 })
    if (url.includes("last-week")) return weekHealthy ? pointOk(url, WEEK) : new Response("", { status: 500 })
    return pointOk(url, MONTH)
  }
  const name = "fixture-split-cache"
  assert.deepEqual(await downloadsFor(name), { monthly: MONTH })
  weekHealthy = true
  clock += 60 * 1000
  assert.deepEqual(await downloadsFor(name), { weekly: WEEK, monthly: MONTH })
  assert.equal(pointCalls().filter((url) => url.includes("last-month")).length, 1, "月数据仍命中 5 分钟缓存")
})

test("并发的同包查询合并为一组请求", async () => {
  route = (url) => (isPoint(url) ? pointOk(url, 3) : new Response("", { status: 404 }))
  const [a, b] = await Promise.all([downloadsFor("fixture-inflight"), downloadsFor("fixture-inflight")])
  assert.deepEqual(a, b)
  assert.equal(pointCalls().length, 2)
})

// ---------------------------------------------------------------------------
// 6-7. 列表/详情一致性、暂不可用不显示为 0
// ---------------------------------------------------------------------------

function adminRoute(name: string, opts: { point?: (url: string) => Response; searchDownloads?: unknown } = {}) {
  return (url: string): Response => {
    if (url.endsWith("/-/ping")) return json({ ok: true })
    if (url.includes("/-/v1/search")) {
      return json({
        objects: [
          {
            ...(opts.searchDownloads === undefined ? {} : { downloads: opts.searchDownloads }),
            package: {
              name,
              version: "0.3.4",
              description: "fixture plugin",
              date: "2026-11-01",
              keywords: ["opencode-plugin"],
              links: { npm: `https://www.npmjs.com/package/${name}`, homepage: "https://example.com" },
            },
          },
        ],
      })
    }
    if (url === `https://registry.npmjs.org/${name}`) {
      return json({
        name,
        readme: "# fixture",
        "dist-tags": { latest: "0.3.4" },
        versions: { "0.3.4": { version: "0.3.4", description: "fixture plugin" } },
        time: { created: "2026-01-01", "0.3.4": "2026-11-01" },
      })
    }
    if (isPoint(url)) return opts.point ? opts.point(url) : pointOk(url, url.includes("last-week") ? WEEK : MONTH)
    return new Response("", { status: 404 })
  }
}

test("列表和详情使用同一份官方数据，且共用缓存", async () => {
  const name = "fixture-consistency"
  route = adminRoute(name)
  const result = await admin.search("fixture")
  assert.equal(result.error, "")
  const hit = result.hits[0]!
  const detail = await admin.detail(name)
  assert.equal(detail.error, "")
  assert.equal(hit.weekly, detail.weekly)
  assert.equal(hit.monthly, detail.monthly)
  assert.deepEqual([hit.weekly, hit.monthly], [WEEK, MONTH])
  assert.equal(pointCalls().length, 2, "第二次读取命中同一份缓存")
})

test("搜索索引里的镜像下载量被忽略", async () => {
  const name = "fixture-index-ignored"
  route = adminRoute(name, { searchDownloads: { weekly: 999999, monthly: 999999, all: 999999 } })
  const hit = (await admin.search("fixture")).hits[0]!
  assert.deepEqual([hit.weekly, hit.monthly], [WEEK, MONTH])
  assert.ok(pointCalls().some((url) => url.includes("last-week")))
  assert.ok(pointCalls().some((url) => url.includes("last-month")))
})

test("周接口失败时列表与详情均为 -1，另一项仍为官方月数据", async () => {
  const name = "fixture-unknown-not-zero"
  route = adminRoute(name, {
    point: (url) => (url.includes("last-week") ? new Response("", { status: 503 }) : pointOk(url, MONTH)),
  })
  const hit = (await admin.search("fixture")).hits[0]!
  const detail = await admin.detail(name)
  assert.equal(hit.weekly, -1)
  assert.equal(detail.weekly, -1)
  assert.equal(hit.monthly, MONTH)
  assert.equal(detail.monthly, MONTH)
  assert.equal(formatCount(hit.weekly), "暂不可用")
  assert.equal(countWithUnit(hit.weekly, "周"), "暂不可用")
  assert.equal(countWithUnit(hit.monthly, "月"), `${MONTH}/月`)
  assert.equal(countTitle(detail.weekly, "周下载"), "周下载暂不可用")
  assert.notEqual(formatCount(hit.weekly), "0")
  assert.ok(calls.every((url) => !url.includes("npmmirror.com/downloads")))
})

test("详情失败的兜底数据也是 -1 而不是 0", async () => {
  const detail = await admin.detail("不是一个包名!")
  assert.equal(detail.error, "不是 npm 包名，无法查询详情")
  assert.equal(detail.weekly, -1)
  assert.equal(detail.monthly, -1)
})

test("暂不可用的渲染契约", () => {
  assert.equal(formatCount(-1), "暂不可用")
  assert.equal(countWithUnit(-1, "周"), "暂不可用")
  assert.equal(countWithUnit(-1, "月"), "暂不可用")
  assert.equal(countTitle(-1, "周下载"), "周下载暂不可用")
  assert.equal(countTitle(-1, "月下载"), "月下载暂不可用")
  assert.notEqual(formatCount(-1), "0")
  assert.notEqual(countWithUnit(-1, "周"), "0/周")
  assert.equal(formatCount(0), "0")
  assert.equal(countWithUnit(0, "月"), "0/月")
  assert.match(countTitle(1511, "周下载") ?? "", /周下载 1,?511 次/)
})
