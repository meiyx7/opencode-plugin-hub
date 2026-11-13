/**
 * Which npm registry to talk to.
 *
 * The official registry is not reachable on every network: the TCP connect is blackholed and
 * undici reports the whole thing as a bare `fetch failed`, which says nothing about what to do.
 * Mirrors carry the same packuments and search API, so the page probes the candidates once and
 * only ever talks to the ones that answered. A base that dies mid-session is evicted and the
 * probe runs again, instead of paying its timeout on every request.
 */

export interface RegistryBase {
  /** Packuments, search and dist-tags. */
  registry: string
  /** Download counts. Official npm serves them from another host; a mirror without one leaves this empty. */
  downloads: string
}

/** Ordered by trust: the canonical copy first, then the mirror most networks here can reach. */
const CANDIDATES: readonly RegistryBase[] = [
  { registry: "https://registry.npmjs.org", downloads: "https://api.npmjs.org/downloads" },
  { registry: "https://registry.npmmirror.com", downloads: "https://registry.npmmirror.com/downloads" },
]

/** A dead registry never answers, so a probe must give up quickly rather than hold the first paint. */
const PROBE_TIMEOUT = 1_500
const DOWNLOADS_TTL = 5 * 60 * 1000
/** A failed download lookup is retried sooner than a good one: the network may simply have blinked. */
const DOWNLOADS_FAILURE_TTL = 60 * 1000

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
  return { registry: raw, downloads: `${raw}/downloads` }
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

export interface Downloads {
  weekly: number
  monthly: number
}

const downloadsCache = new Map<string, { at: number; value: Downloads | undefined }>()

/**
 * Weekly and monthly downloads from one `range/last-month` call: the daily series is summed,
 * which is how the official API itself derives the two numbers. `undefined` means "could not be
 * asked" — the UI renders that as 暂不可用, never as 0.
 */
export async function downloadsFor(name: string): Promise<Downloads | undefined> {
  const cached = downloadsCache.get(name)
  if (cached) {
    const ttl = cached.value ? DOWNLOADS_TTL : DOWNLOADS_FAILURE_TTL
    if (Date.now() - cached.at < ttl) return cached.value
  }
  const value = await fetchDownloads(name)
  downloadsCache.set(name, { at: Date.now(), value })
  return value
}

async function fetchDownloads(name: string): Promise<Downloads | undefined> {
  let bases: RegistryBase[]
  try {
    bases = await registryBases()
  } catch {
    return undefined
  }
  for (const base of bases) {
    if (!base.downloads) continue
    try {
      const response = await fetch(`${base.downloads}/range/last-month/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(8_000),
        headers: { accept: "application/json" },
      })
      if (!response.ok) continue
      const body = (await response.json()) as { downloads?: { downloads?: number }[] }
      const days = body.downloads ?? []
      if (days.length === 0) continue
      const sum = (list: readonly { downloads?: number }[]) =>
        list.reduce((total, day) => total + (Number(day.downloads) || 0), 0)
      return { weekly: sum(days.slice(-7)), monthly: sum(days) }
    } catch {
      // Try the next base; a mirror without a downloads API also lands here via its 404 above.
    }
  }
  return undefined
}
