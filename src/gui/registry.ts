/**
 * Which npm registry to talk to, and how to tell the UI what actually happened.
 *
 * The official registry is not reachable on every network: the TCP connect is blackholed and
 * undici reports the whole thing as a bare `fetch failed`, which says nothing about what to do.
 * Mirrors carry the same packuments and search API, so in auto mode this module probes the
 * candidates, prefers the official source when it answers, and falls back to the mirror when a
 * *request* fails — not only when a probe fails. Every lookup reports the source it finally used
 * and whether a fallback happened, so the UI never presents a mirror answer as an official one.
 *
 * Download counts are deliberately NOT part of this selection: they come only from npm's official
 * downloads API. A mirror reports its own traffic, which is a different number, so falling back
 * to one would silently replace the official figure instead of showing that it is unavailable.
 */
import { registryMode } from "./store"

export interface RegistryBase {
  /** Packuments, search and dist-tags. */
  registry: string
}

/** Ordered by trust: the canonical copy first, then the mirror most networks here can reach. */
const CANDIDATES: readonly RegistryBase[] = [
  { registry: "https://registry.npmjs.org" },
  { registry: "https://registry.npmmirror.com" },
]
const OFFICIAL = CANDIDATES[0]!
const MIRROR = CANDIDATES[1]!

/** The one and only source of download counts. Never a mirror, never a forced registry. */
export const NPM_DOWNLOADS_API = "https://api.npmjs.org/downloads"

/** A dead registry never answers, so a probe must give up quickly rather than hold the first paint. */
const PROBE_TIMEOUT = 3_000
/** One metadata request must end so a slow package cannot consume the whole budget. */
const REQUEST_TIMEOUT = 8_000
/** All attempts for a single lookup share this budget; slow sources cannot be tried in series forever. */
const TOTAL_BUDGET = 15_000
/** Probe results are reused briefly; a dead base is re-probed after this window or on failure. */
const PROBE_TTL = 60 * 1000
/** Successful download counts are stable enough to reuse for five minutes. */
const DOWNLOADS_TTL = 5 * 60 * 1000
/** A failed download lookup is retried sooner than a good one: the network may simply have blinked. */
const DOWNLOADS_FAILURE_TTL = 60 * 1000
/** One slow point request must not hold the whole card/detail view hostage. */
const DOWNLOADS_TIMEOUT_MS = 8_000

/** Effective source selection, after the environment override and the stored preference. */
export type EffectiveRegistryMode = "auto" | "official" | "mirror" | "custom"

/** What the UI needs to explain a lookup: where it came from, whether it fell back, why it failed. */
export interface RegistryResolution {
  mode: EffectiveRegistryMode
  /** Source that answered, URL. Empty when nothing answered. */
  registryUsed: string
  /** True when a preferred source failed and a different one was used for this lookup. */
  fallbackUsed: boolean
  /** Short, user-facing explanation (source, fallback, mirror lag, connection failure). */
  registryMessage: string
  /** Failure reason; empty on success. Never claims "up to date". */
  registryError: string
}

export interface RegistryResponse {
  response: Response
  resolution: RegistryResolution
}

function resolution(mode: EffectiveRegistryMode, used: string, fallback: boolean, message: string): RegistryResolution {
  return { mode, registryUsed: used, fallbackUsed: fallback, registryMessage: message, registryError: "" }
}

export class RegistryUnavailable extends Error {
  constructor(
    readonly tried: readonly string[],
    readonly resolution?: RegistryResolution,
  ) {
    super(resolution?.registryError || `无法连接 npm registry（已尝试 ${tried.join("、")}，可能是网络受限，需要代理或镜像）`)
    this.name = "RegistryUnavailable"
  }
}

/**
 * One request ran out of time while the registry itself was answering other requests. Kept as a
 * distinct error so existing callers that recognise a timeout can still say so; a *single* timeout
 * no longer aborts the whole lookup — the request layer tries the next source first.
 */
export class RegistryTimeout extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(
      `npm registry 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应这个包：可能它并不存在，或镜像正在回源。稍后重试。`,
    )
    this.name = "RegistryTimeout"
  }
}

/**
 * An explicit registry wins over everything: `OPENCODE_PLUGIN_HUB_REGISTRY=https://…`.
 * Useful for a private proxy that is reachable but not one of the built-in candidates.
 */
export function forcedBase(): RegistryBase | undefined {
  const raw = (process.env.OPENCODE_PLUGIN_HUB_REGISTRY ?? "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(raw)) return undefined
  return { registry: raw }
}

/** Mode selection: environment variable > stored UI choice > auto. */
export function effectiveMode(): EffectiveRegistryMode {
  if (forcedBase()) return "custom"
  return registryMode()
}

/**
 * Cache scope: a lookup result is only valid for the mode + concrete source that produced it.
 * Callers key their caches with this so switching source cannot reuse another source's answer.
 */
export function registryCacheScope(): string {
  const mode = effectiveMode()
  const base = mode === "custom" ? forcedBase()?.registry ?? "" : mode
  return `${mode}\u0000${base}`
}

/** Human label for a base, used in UI messages. */
function labelOf(base: RegistryBase): string {
  if (base.registry === OFFICIAL.registry) return "官方 npm"
  if (base.registry === MIRROR.registry) return "npmmirror"
  return "自定义 Registry"
}

/** The candidates a mode is allowed to touch, never including sources the mode forbids. */
function candidatesFor(mode: EffectiveRegistryMode): RegistryBase[] {
  if (mode === "official") return [OFFICIAL]
  if (mode === "mirror") return [MIRROR]
  if (mode === "custom") {
    const forced = forcedBase()
    return forced ? [forced] : []
  }
  return [OFFICIAL, MIRROR]
}

interface ProbeCache {
  at: number
  mode: EffectiveRegistryMode
  /** Answered bases first, but every candidate is kept so a request can still fall back. */
  ordered: RegistryBase[]
  /** Short reason each base was probed as down, for accurate failure reporting. */
  reasons: Record<string, string>
}
let probeCache: ProbeCache | undefined
let probing: Promise<ProbeCache> | undefined

async function ping(registry: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const response = await fetch(`${registry}/-/ping`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      headers: { accept: "application/json" },
    })
    // A 5xx from the probe is a live server but a bad answer; treat it as not usable.
    return response.ok ? { ok: true, reason: "" } : { ok: false, reason: `HTTP ${response.status}` }
  } catch (error) {
    const reason = isTimeout(error)
      ? `${Math.round(PROBE_TIMEOUT / 1000)} 秒内未响应`
      : isConnectionFailure(error)
        ? "连接失败"
        : "探测失败"
    return { ok: false, reason }
  }
}

/**
 * Probe once and cache briefly, per mode. In auto mode the answered source is ordered first but
 * both candidates remain available: a source that answered a ping can still fail the real request,
 * and the fallback must be reachable without another probe round-trip.
 */
async function probe(mode: EffectiveRegistryMode): Promise<ProbeCache> {
  const bases = candidatesFor(mode)
  // Single-source modes need no probe: they talk to their only base directly.
  if (bases.length <= 1) {
    return { at: Date.now(), mode, ordered: bases, reasons: {} }
  }
  const results = await Promise.all(
    bases.map(async (base) => ({ base, ...(await ping(base.registry)) })),
  )
  const reasons: Record<string, string> = {}
  for (const result of results) if (!result.ok) reasons[result.base.registry] = result.reason
  const ordered = [...results.filter((result) => result.ok).map((result) => result.base), ...results.filter((result) => !result.ok).map((result) => result.base)]
  return { at: Date.now(), mode, ordered, reasons }
}

async function probeFor(mode: EffectiveRegistryMode): Promise<ProbeCache> {
  const cachedBase = probeCache?.ordered[0]?.registry
  const wantedBase = mode === "custom" ? candidatesFor(mode)[0]?.registry : undefined
  const baseChanged = wantedBase !== undefined && wantedBase !== cachedBase
  if (probeCache && probeCache.mode === mode && !baseChanged && Date.now() - probeCache.at < PROBE_TTL) return probeCache
  probing ??= probe(mode)
    .then((value) => {
      probeCache = value
      return value
    })
    .finally(() => {
      probing = undefined
    })
  return probing
}

/** A base stopped answering real requests: drop the cached probe so the next lookup re-checks it. */
function invalidateProbe(): void {
  probeCache = undefined
}

/** Test seam: clear probe state between scenarios (each test drives its own fetch mock). */
export function resetRegistryCache(): void {
  probeCache = undefined
  probing = undefined
}

/** A base-wide reachability failure, as opposed to one request timing out on a slow package. */
function isConnectionFailure(error: unknown): boolean {
  if (error instanceof RegistryUnavailable) return true
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|UND_ERR|TLS|certificate/i.test(
    message,
  )
}

/** undici reports a per-request timeout as a bare `fetch failed` too, so the name has to be checked. */
function isTimeout(error: unknown): boolean {
  if (error instanceof RegistryTimeout) return true
  if (!(error instanceof Error)) return false
  return error.name === "TimeoutError" || /aborted due to timeout|The operation was aborted|timeout/i.test(error.message)
}

/** Classify an HTTP status the request layer must react to. */
type StatusAction = "ok" | "not-found" | "retry" | "definitive"
function statusAction(status: number): StatusAction {
  if (status >= 200 && status < 300) return "ok"
  if (status === 404) return "not-found"
  if (status === 429 || status >= 500) return "retry"
  return "definitive"
}

/**
 * One lookup against the registry, with source tracking and request-level fallback.
 *
 * Fallback happens on connection failure, TLS failure, timeout, 429 and 5xx — but a 404 is a
 * definite "not on this source" answer and is returned as-is. Every attempt is bounded by the
 * per-request timeout and the shared total budget, so slow sources cannot be tried in series
 * without end. The returned resolution tells the UI which source answered and whether it fell back.
 */
export async function registryFetchDetailed(
  path: string,
  options: { timeoutMs: number; accept?: string },
): Promise<RegistryResponse> {
  const mode = effectiveMode()
  const cache = await probeFor(mode)
  const deadline = Date.now() + TOTAL_BUDGET
  const tried: string[] = []
  const perRequest = Math.min(options.timeoutMs, REQUEST_TIMEOUT)
  let fallback = false
  // Probe-stage failures are part of the story the UI must tell: an official source that timed
  // out during probing and a mirror that answered still mean "automatically switched".
  const notes: string[] = Object.entries(cache.reasons).map(
    ([url, reason]) => `${labelOf({ registry: url })}${reason}`,
  )
  if (notes.length > 0) fallback = true

  for (const base of cache.ordered) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timeout = Math.max(1, Math.min(perRequest, remaining))
    tried.push(base.registry)
    let response: Response
    try {
      response = await fetch(`${base.registry}${path}`, {
        signal: AbortSignal.timeout(timeout),
        headers: { accept: options.accept ?? "application/json" },
      })
    } catch (error) {
      const why = isTimeout(error) ? "请求超时" : isConnectionFailure(error) ? "连接失败" : "请求失败"
      notes.push(`${labelOf(base)}${why}`)
      invalidateProbe()
      fallback = true
      continue
    }

    const action = statusAction(response.status)
    if (action === "ok") {
      const message = fallback
        ? `${notes.join("，")}，已自动切换到${labelOf(base)}（镜像结果可能有同步延迟）`
        : `${labelOf(base)}`
      return { response, resolution: resolution(mode, base.registry, fallback, message) }
    }
    if (action === "not-found") {
      // A 404 is a definite answer from this source, not a network failure to fall back from.
      const message = fallback ? `${notes.join("，")}，${labelOf(base)}明确返回不存在` : `${labelOf(base)}明确返回不存在`
      return { response, resolution: resolution(mode, base.registry, fallback, message) }
    }
    if (action === "definitive") {
      // Other 4xx (e.g. 400) is a real answer too; do not disguise it as a network failure.
      notes.push(`${labelOf(base)}HTTP ${response.status}`)
      return {
        response,
        resolution: resolution(mode, base.registry, fallback, notes.join("，")),
      }
    }
    // 429 / 5xx: this source is unhealthy for this lookup, try the next one.
    notes.push(`${labelOf(base)}HTTP ${response.status}`)
    invalidateProbe()
    fallback = true
  }

  const detail = notes.length > 0 ? notes.join("，") : "没有可用源"
  const fail = resolution(mode, "", fallback, "")
  fail.registryError = `无法取得版本信息（${detail}）。本次没有确认任何更新，请检查网络或切换 Registry 后重试。`
  throw new RegistryUnavailable(tried, fail)
}

/**
 * Backwards-compatible wrapper: callers that only need the body keep the old signature. Callers
 * that must show the source use `registryFetchDetailed` directly.
 */
export async function registryFetch(
  path: string,
  options: { timeoutMs: number; accept?: string },
): Promise<Response> {
  return (await registryFetchDetailed(path, options)).response
}

/** The registry in use, for anything that needs to show or derive a URL from it. */
export async function registryBase(): Promise<RegistryBase> {
  const mode = effectiveMode()
  const cache = await probeFor(mode)
  return cache.ordered[0] ?? candidatesFor(mode)[0] ?? OFFICIAL
}

/**
 * A field is absent when its own point request could not be answered. Callers turn that into
 * `-1` on the IPC wire, which the UI renders as 暂不可用 — never as a fabricated 0.
 */
export interface Downloads {
  weekly?: number
  monthly?: number
}

type Period = "last-week" | "last-month"
export type Metric = "weekly" | "monthly"

const POINTS: readonly { metric: Metric; period: Period }[] = [
  { metric: "weekly", period: "last-week" },
  { metric: "monthly", period: "last-month" },
]

interface CachedCount {
  at: number
  value: number
}

/**
 * Success values and failure retries are two different pieces of state, kept in two maps.
 * A failed refresh must never overwrite the last good value: doing so would erase data that is
 * still useful (and would make a later recovery look like a brand-new package). A failure only
 * opens a short cooldown during which the same request is not repeated. While that cooldown is
 * active, an expired value is NOT served — an old number must not be presented as a fresh one.
 * Both maps are keyed per metric, so week and month stay independent.
 */
const successCache = new Map<string, CachedCount>()
const failureCache = new Map<string, { at: number }>()
/** Coalesce concurrent lookups: the list and the detail dialog often ask for the same package. */
const inFlight = new Map<string, Promise<number | undefined>>()

function cacheKey(metric: Metric, name: string): string {
  return `${metric}\u0000${name}`
}

/** Read-only diagnostic view, used by the tests to prove a failure preserved the last good value. */
export function peekCachedCount(
  metric: Metric,
  name: string,
): { value?: number; at?: number; failedAt?: number } {
  const key = cacheKey(metric, name)
  const good = successCache.get(key)
  return { value: good?.value, at: good?.at, failedAt: failureCache.get(key)?.at }
}

/**
 * One official point request. Any bad status, malformed body, wrong package or timeout is an
 * unknown count, not a zero. This function never throws, so week and month stay independent.
 */
async function fetchPoint(name: string, period: Period): Promise<number | undefined> {
  const url = `${NPM_DOWNLOADS_API}/point/${period}/${encodeURIComponent(name)}`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOADS_TIMEOUT_MS),
      headers: { accept: "application/json" },
    })
    if (!response.ok) return undefined
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return undefined
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
    const record = body as { downloads?: unknown; package?: unknown }
    // A proxy answering with somebody else's count is bad data, not a valid count.
    if (record.package !== undefined && record.package !== name) return undefined
    const count = record.downloads
    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      return undefined
    }
    return count
  } catch {
    // Timeout, DNS failure, TLS reset, aborted body: all mean "unknown".
    return undefined
  }
}

async function cachedPoint(name: string, metric: Metric, period: Period): Promise<number | undefined> {
  const key = cacheKey(metric, name)
  const now = Date.now()
  const good = successCache.get(key)
  const failed = failureCache.get(key)

  // A still-valid good value wins, even if a concurrent refresh happened to fail.
  if (good && now - good.at < DOWNLOADS_TTL) return good.value
  // In the retry cooldown: do not re-request, and do not serve the now-expired value.
  if (failed && now - failed.at < DOWNLOADS_FAILURE_TTL) return undefined

  // Concurrent callers share the same request, whichever of them got here first.
  const pending = inFlight.get(key)
  if (pending) return pending
  const request = fetchPoint(name, period)
    .then((value) => {
      if (value === undefined) {
        // Keep successCache untouched: the previous good value stays in place (though expired,
        // so it will never be displayed as current). Only the retry window is refreshed.
        failureCache.set(key, { at: Date.now() })
      } else {
        successCache.set(key, { at: Date.now(), value })
        failureCache.delete(key)
      }
      return value
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}

/**
 * Weekly and monthly counts from two separate official point requests. Both run concurrently;
 * a failure in one only leaves that one field absent. The cache and request coalescing here are
 * the single source shared by the search list and the detail dialog.
 */
export async function downloadsFor(name: string): Promise<Downloads> {
  const [weekly, monthly] = await Promise.all(
    POINTS.map((point) => cachedPoint(name, point.metric, point.period)),
  )
  const counts: Downloads = {}
  if (weekly !== undefined) counts.weekly = weekly
  if (monthly !== undefined) counts.monthly = monthly
  return counts
}
