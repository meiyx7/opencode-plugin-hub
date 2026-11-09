import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import builtin from "./registry-snapshot.json"

export interface CatalogEntryValue {
  /** Human-facing label from the curated registry. */
  name: string
  /** npm package name, empty when the project only ships from GitHub. */
  pkg: string
  /** Latest npm version, or the version verified at build time. */
  version: string
  /** `plugins`, `mcp` or `themes`. */
  type: string
  /** One-line tagline. */
  desc: string
  /** Long description, may be empty. */
  long: string
  /** Source repository, used for the "open" action. */
  repo: string
  tags: string[]
  /** True when this package already sits in the config. */
  installed: boolean
}

export interface CatalogResultValue {
  entries: CatalogEntryValue[]
  /** Where the list came from: `network`, `cache` or `builtin`. */
  source: string
  /** The registry URL the entries came from. */
  registry: string
  /** Epoch milliseconds of the data, 0 for the built-in snapshot. */
  fetchedAt: number
  error: string
}

interface SnapshotEntry {
  name: string
  pkg: string
  ver: string
  type: string
  desc: string
  long: string
  repo: string
  tags: string[]
}

interface Source {
  url: string
  /** Extra `Accept` value this source needs. The GitHub contents API only returns the raw file for its raw media type. */
  accept?: string
}

/**
 * The same curated list, reachable several ways. `raw.githubusercontent.com` is TLS-reset on some
 * networks (the handshake is dropped with "connection reset by peer") while `api.github.com` stays
 * reachable, so every repository is offered through both: the CDN first — no rate limit, and it is
 * the canonical copy — then the contents API as a fallback. The fork occasionally carries newer
 * entries and only matters when the upstream copies fail.
 */
const SOURCES: Source[] = [
  { url: "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json" },
  {
    url: "https://api.github.com/repos/awesome-opencode/awesome-opencode/contents/dist/registry.json?ref=main",
    accept: "application/vnd.github.raw+json",
  },
  { url: "https://raw.githubusercontent.com/Gracdjd/awesome-opencode/main/dist/registry.json" },
  {
    url: "https://api.github.com/repos/Gracdjd/awesome-opencode/contents/dist/registry.json?ref=main",
    accept: "application/vnd.github.raw+json",
  },
]

/** Re-fetch the remote list at most this often; otherwise the cache wins. */
const TTL = 12 * 60 * 60 * 1000

const SNAPSHOT = builtin as SnapshotEntry[]

function cacheDir() {
  const xdg = process.env.XDG_CACHE_HOME
  return xdg ? join(xdg, "opencode", "plugin-hub") : join(homedir(), ".cache", "opencode", "plugin-hub")
}

function cacheFile() {
  return join(cacheDir(), "registry.json")
}

interface RawEntry {
  displayName?: string
  type?: string
  tagline?: string
  description?: string
  repoUrl?: string
  tags?: string[]
  /** Free-form install instructions; sometimes the only place the npm name appears. */
  installation?: string
}

const installPattern = /"plugin"\s*:\s*\[\s*"([^"]+)"/
const packagePattern = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

/** Best-effort package name for an entry the built-in snapshot has never seen. */
function guessPackage(entry: RawEntry): string {
  const fromInstall = installPattern.exec(entry.installation ?? "")
  if (fromInstall?.[1]) return fromInstall[1]
  const display = (entry.displayName ?? "").trim()
  if (packagePattern.test(display) && !display.includes(" ")) return display
  const repoUrl = entry.repoUrl ?? ""
  const repo = repoUrl.replace(/\/+$/, "").split("/").pop()?.replace(".git", "") ?? ""
  return packagePattern.test(repo) ? repo : ""
}

/** Lookup table built from the verified snapshot, keyed by repository URL. */
const verified = new Map<string, SnapshotEntry>()
for (const entry of SNAPSHOT) {
  verified.set(entry.repo, entry)
  if (entry.pkg) verified.set(`pkg:${entry.pkg}`, entry)
}

function normalizeRepo(url: string) {
  return url.replace(/\/+$/, "").replace(/\.git$/, "")
}

function toEntries(raw: RawEntry[], installed: Set<string>): CatalogEntryValue[] {
  const out: CatalogEntryValue[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const type = entry.type ?? "plugins"
    if (type !== "plugins" && type !== "mcp" && type !== "themes") continue
    const repo = normalizeRepo(entry.repoUrl ?? "")
    if (!repo || seen.has(repo)) continue
    seen.add(repo)
    // Prefer the version we verified at build time; fall back to a guess for brand-new entries.
    const known = verified.get(repo) ?? verified.get(`pkg:${guessPackage(entry)}`)
    const pkg = known?.pkg ?? guessPackage(entry)
    out.push({
      name: entry.displayName ?? pkg ?? repo,
      pkg,
      version: known?.ver ?? "",
      type,
      desc: (entry.tagline ?? "").trim(),
      long: (entry.description ?? "").trim().slice(0, 300),
      repo,
      tags: (entry.tags ?? []).slice(0, 6),
      installed: pkg ? installed.has(pkg) : false,
    })
  }
  return out
}

async function fetchRemote(): Promise<{ entries: RawEntry[]; url: string }> {
  let lastError = ""
  for (const source of SOURCES) {
    try {
      const headers: Record<string, string> = { accept: source.accept ?? "application/json" }
      const response = await fetch(source.url, { signal: AbortSignal.timeout(12_000), headers })
      if (!response.ok) {
        lastError = `${new URL(source.url).host} 返回 ${response.status}`
        continue
      }
      const body = (await response.json()) as unknown
      if (!Array.isArray(body)) {
        lastError = "registry 格式不是数组"
        continue
      }
      return { entries: body as RawEntry[], url: source.url }
    } catch (error) {
      lastError = describe(error)
    }
  }
  throw new Error(lastError || "无法连接插件目录")
}

interface CacheFile {
  fetchedAt: number
  /** The source URL that produced this cache. Older caches do not have it. */
  url?: string
  entries: RawEntry[]
}

async function readCache(): Promise<CacheFile | undefined> {
  try {
    const text = await readFile(cacheFile(), "utf8")
    const parsed = JSON.parse(text) as CacheFile
    if (!Array.isArray(parsed.entries)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function writeCache(entries: RawEntry[], url: string): Promise<number> {
  const fetchedAt = Date.now()
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(cacheFile(), JSON.stringify({ fetchedAt, url, entries }), "utf8")
  } catch {
    // A failed cache write still leaves the in-memory result usable.
  }
  return fetchedAt
}

/** The first source's URL, used when a cached payload predates the `url` field. */
const PRIMARY_URL = SOURCES[0]!.url

/**
 * The curated community list. Network first (cached for half a day), then the cache, then the
 * snapshot baked into this bundle — so the page is never empty, even offline.
 */
export async function browse(installed: Set<string>, force: boolean): Promise<CatalogResultValue> {
  const cache = await readCache()
  const fresh = cache !== undefined && Date.now() - cache.fetchedAt < TTL
  if (cache && fresh && !force) {
    return {
      entries: toEntries(cache.entries, installed),
      source: "cache",
      registry: cache.url ?? PRIMARY_URL,
      fetchedAt: cache.fetchedAt,
      error: "",
    }
  }
  try {
    const remote = await fetchRemote()
    const fetchedAt = await writeCache(remote.entries, remote.url)
    return {
      entries: toEntries(remote.entries, installed),
      source: "network",
      registry: remote.url,
      fetchedAt,
      error: "",
    }
  } catch (error) {
    if (cache) {
      return {
        entries: toEntries(cache.entries, installed),
        source: "cache",
        registry: cache.url ?? PRIMARY_URL,
        fetchedAt: cache.fetchedAt,
        error: describe(error),
      }
    }
    return {
      entries: toEntries(SNAPSHOT.map(toRaw), installed),
      source: "builtin",
      registry: PRIMARY_URL,
      fetchedAt: 0,
      error: describe(error),
    }
  }
}

function toRaw(entry: SnapshotEntry): RawEntry {
  return {
    displayName: entry.name,
    type: entry.type,
    tagline: entry.desc,
    description: entry.long,
    repoUrl: entry.repo,
    tags: entry.tags,
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // `fetch failed` is undici's wrapper for every socket-level failure; on its own it says nothing
  // about what to do. Name the likely causes so the notice is actionable instead of alarming.
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) {
    return "无法连接插件目录（网络受限或连接被重置），已改用本地缓存"
  }
  if (/aborted|timeout/i.test(message)) {
    return "连接插件目录超时，已改用本地缓存"
  }
  return message
}
