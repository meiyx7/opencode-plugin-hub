/**
 * Which npm registry to talk to.
 *
 * The official registry is not reachable on every network: the TCP connect is blackholed and
 * undici reports the whole thing as a bare `fetch failed`, which says nothing about what to do.
 * Mirrors carry the same packuments and search API, so the page probes the candidates once and
 * only ever talks to the ones that answered. A base that dies mid-session is evicted and the
 * probe runs again, instead of paying its timeout on every request.
 *
 * Download counts are deliberately NOT part of this selection: they come only from npm's official
 * downloads API. A mirror reports its own traffic, which is a different number, so falling back
 * to one would silently replace the official figure instead of showing that it is unavailable.
 */

export interface RegistryBase {
  /** Packuments, search and dist-tags. */
  registry: string
}

/** Ordered by trust: the canonical copy first, then the mirror most networks here can reach. */
const CANDIDATES: readonly RegistryBase[] = [
  { registry: "https://registry.npmjs.org" },
  { registry: "https://registry.npmmirror.com" },
]

/** The one and only source of download counts. Never a mirror, never a forced registry. */
export const NPM_DOWNLOADS_API = "https://api.npmjs.org/downloads"

/** A dead registry never answers, so a probe must give up quickly rather than hold the first paint. */
const PROBE_TIMEOUT = 1_500
/** Successful download counts are stable enough to reuse for five minutes. */
const DOWNLOADS_TTL = 5 * 60 * 1000
/** A failed download lookup is retried sooner than a good one: the network may simply have blinked. */
const DOWNLOADS_FAILURE_TTL = 60 * 1000
/** One slow point request must not hold the whole card/detail view hostage. */
const DOWNLOADS_TIMEOUT_MS = 8_000

export class RegistryUnavailable extends Error {
  constructor(readonly tried: readonly string[]) {
    super(`无法连接 npm registry（已尝试 ${tried.join("、")}，可能是网络受限，需要代理或镜像）`)
    this.name = "RegistryUnavailable"
  }
}

/**
 * One request ran out of time while the registry itself was answering other requests. That is a
 * property of the package (mirrors stall on an uncached 404 while fetching from upstream), not
 * evidence that the registry is down, so it must not be reported as a network failure.
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

/** Bases that answered a probe. Empty until the first probe finishes. */
let alive: RegistryBase[] = []
let probing: Promise<RegistryBase[]> | undefined

/**
 * An explicit registry wins over probing: `OPENCODE_PLUGIN_HUB_REGISTRY=https://…`.
 * Useful for a private proxy that is reachable but not one of the built-in candidates.
 */
export function forcedBase(): RegistryBase | undefined {
  const raw = (process.env.OPENCODE_PLUGIN_HUB_REGISTRY ?? "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(raw)) return undefined
  return { registry: raw }
}

async function ping(registry: string): Promise<boolean> {
  try {
    const response = await fetch(`${registry}/-/ping`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      headers: { accept: "application/json" },
    })
    return response.ok
  } catch {
    return false
  }
}

async function probe(): Promise<RegistryBase[]> {
  const forced = forcedBase()
  if (forced) return [forced]
  // Probe in parallel: on a blackholed network the dead candidate only costs its own timeout,
  // not a timeout per candidate in sequence.
  const answers = await Promise.all(
    CANDIDATES.map(async (candidate) => ((await ping(candidate.registry)) ? candidate : undefined)),
  )
  return answers.filter((candidate): candidate is RegistryBase => candidate !== undefined)
}

/** The registries known to answer, probed once and then cached. */
export async function registryBases(): Promise<RegistryBase[]> {
  if (alive.length > 0) return alive
  probing ??= probe()
    .then((bases) => {
      alive = bases
      return bases
    })
    .finally(() => {
      probing = undefined
    })
  const bases = await probing
  if (bases.length === 0) throw new RegistryUnavailable(CANDIDATES.map((candidate) => candidate.registry))
  return bases
}

/** The registry in use, for anything that needs to show or derive a URL from it. */
export async function registryBase(): Promise<RegistryBase> {
  const [first] = await registryBases()
  return first!
}

/** A base-wide reachability failure, as opposed to one request timing out on a slow package. */
function isConnectionFailure(error: unknown): boolean {
  if (error instanceof RegistryUnavailable) return true
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|UND_ERR/i.test(
    message,
  )
}

/** undici reports a per-request timeout as a bare `fetch failed` too, so the name has to be checked. */
function isTimeout(error: unknown): boolean {
  if (error instanceof RegistryTimeout) return true
  if (!(error instanceof Error)) return false
  return error.name === "TimeoutError" || /aborted due to timeout|The operation was aborted/i.test(error.message)
}

/**
 * One request against the registry. Any HTTP status is a real answer and is returned as-is
 * (a 404 is how "this package does not exist" arrives). Only a connection-level failure moves on
 * to the next base — a timeout is reported as-is, because a package whose metadata stalls is not
 * evidence that the registry is down.
 */
export async function registryFetch(
  path: string,
  options: { timeoutMs: number; accept?: string },
): Promise<Response> {
  const bases = await registryBases()
  let lastError: unknown
  for (const base of bases) {
    try {
      return await fetch(`${base.registry}${path}`, {
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { accept: options.accept ?? "application/json" },
      })
    } catch (error) {
      lastError = error
      if (isTimeout(error)) throw new RegistryTimeout(path, options.timeoutMs)
      if (!isConnectionFailure(error)) throw error
      // The base stopped answering: drop it and let the next call probe again.
      alive = alive.filter((candidate) => candidate.registry !== base.registry)
    }
  }
  if (lastError instanceof Error && !isConnectionFailure(lastError) && !(lastError instanceof RegistryUnavailable)) {
    throw lastError
  }
  throw new RegistryUnavailable(bases.map((base) => base.registry))
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
type Metric = "weekly" | "monthly"

const POINTS: readonly { metric: Metric; period: Period }[] = [
  { metric: "weekly", period: "last-week" },
  { metric: "monthly", period: "last-month" },
]

interface CachedCount {
  at: number
  /** `undefined` is a remembered failure, cached for the shorter failure TTL. */
  value: number | undefined
}

/**
 * One entry per metric, not one per package: a successful week and a failed month must keep
 * their own expiry, so a single flaky response never poisons the other number.
 */
const downloadsCache = new Map<string, CachedCount>()
/** Coalesce concurrent lookups: the list and the detail dialog often ask for the same package. */
const inFlight = new Map<string, Promise<number | undefined>>()

function cacheKey(metric: Metric, name: string): string {
  return `${metric}\u0000${name}`
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
  const cached = downloadsCache.get(key)
  if (cached) {
    const ttl = cached.value === undefined ? DOWNLOADS_FAILURE_TTL : DOWNLOADS_TTL
    if (Date.now() - cached.at < ttl) return cached.value
  }
  const pending = inFlight.get(key)
  if (pending) return pending
  const request = fetchPoint(name, period)
    .then((value) => {
      downloadsCache.set(key, { at: Date.now(), value })
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
