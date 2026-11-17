/**
 * Small, hub-owned notes that survive a reload:
 *
 * - `ids` — the runtime plugin ID each package or directory has loaded under. The ID is not
 *   derivable from the package name (`opencode-notify` loads as `opencode-notify-callback`,
 *   `opencode-plugin-hub` as `plugin-hub`), and a plugin that is currently paused or failing is
 *   absent from the runtime list, so the last known ID is the only way back.
 * - `rules` — the bare-ID entries this hub appended to re-enable a plugin. They look exactly like
 *   package specs in the config, so this note is what keeps them from being displayed (and
 *   queried on npm) as if they were installed packages.
 * - `registryMode` — the registry source the user picked in the hub UI (auto / official / mirror).
 *   Stored here, in the hub's own state file, rather than in opencode.json: it is hub preference,
 *   not host configuration. Env var `OPENCODE_PLUGIN_HUB_REGISTRY` still overrides it at read time.
 *
 * Everything here is best effort: the file is a cache under the user's cache directory, never the
 * source of truth, and a missing or corrupt file degrades to "unknown" rather than an error.
 */
import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Registry source the user selected in the hub UI. Env var still wins over this preference. */
export type RegistryMode = "auto" | "official" | "mirror"

interface StoreShape {
  version: number
  ids: Record<string, string>
  rules: string[]
  registryMode: RegistryMode
}

const EMPTY: StoreShape = { version: 1, ids: {}, rules: [], registryMode: "auto" }
/** Old package entries are dropped first once the notes grow past this; the cache is disposable. */
const MAX_IDS = 400
const MAX_RULES = 40

function validMode(value: unknown): RegistryMode {
  return value === "official" || value === "mirror" || value === "auto" ? value : "auto"
}

let cached: StoreShape | undefined
let cachedPath = ""
let writeQueue: Promise<unknown> = Promise.resolve()

function storePath(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".cache", "opencode")
  return join(base, "plugin-hub", "state.json")
}

function sanitize(value: unknown): StoreShape {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const ids: Record<string, string> = {}
  const rawIds = record.ids && typeof record.ids === "object" ? (record.ids as Record<string, unknown>) : {}
  for (const [key, id] of Object.entries(rawIds)) {
    if (typeof key === "string" && typeof id === "string" && key.length > 0 && id.length > 0) ids[key] = id
  }
  const rules = Array.isArray(record.rules)
    ? record.rules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
    : []
  return { version: 1, ids, rules, registryMode: validMode(record.registryMode) }
}

/** Synchronous on purpose: entry resolution asks for it once per config row while building a snapshot. */
export function readStore(): StoreShape {
  const path = storePath()
  if (cached && cachedPath === path) return cached
  let value: StoreShape
  try {
    value = sanitize(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    value = { version: 1, ids: {}, rules: [], registryMode: "auto" }
  }
  cached = value
  cachedPath = path
  return value
}

async function writeStore(next: StoreShape): Promise<void> {
  const path = storePath()
  // Trim before writing so a long-lived install cannot grow this file without bound.
  const ids = Object.entries(next.ids).slice(-MAX_IDS)
  const trimmed: StoreShape = {
    version: 1,
    ids: Object.fromEntries(ids),
    rules: next.rules.slice(-MAX_RULES),
    registryMode: next.registryMode,
  }
  cached = trimmed
  cachedPath = path
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined)
    const tmp = `${path}.${process.pid}.tmp`
    try {
      await writeFile(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8")
      await rename(tmp, path)
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
  })
  await writeQueue.catch(() => undefined)
}

/** The last ID this package or directory was seen loading under, or "" when never seen. */
export function lookupId(key: string): string {
  return readStore().ids[key] ?? ""
}

/** Remembers the ID the runtime reported. Called on every successful resolution. */
export function rememberId(key: string, id: string): void {
  const store = readStore()
  if (!key || !id) return
  if (store.ids[key] === id) return
  void writeStore({ ...store, ids: { ...store.ids, [key]: id } })
}

/** Records that this bare-ID entry was appended by the hub and is a rule, not a package. */
export function rememberRule(spec: string): void {
  const store = readStore()
  if (!spec || store.rules.includes(spec)) return
  void writeStore({ ...store, rules: [...store.rules, spec] })
}

/** Drops the note when the entry is gone from the config. */
export function forgetRule(spec: string): void {
  const store = readStore()
  if (!store.rules.includes(spec)) return
  void writeStore({ ...store, rules: store.rules.filter((rule) => rule !== spec) })
}

/** The registry source persisted by the user (never the env override). Default: auto. */
export function registryMode(): RegistryMode {
  return readStore().registryMode
}

/**
 * Persists the user's registry choice. Awaitable so callers can be sure it hit disk before the
 * next request uses it. Invalid values fall back to auto.
 */
export async function setRegistryMode(mode: unknown): Promise<RegistryMode> {
  const next = validMode(mode)
  const store = readStore()
  if (store.registryMode === next) return next
  await writeStore({ ...store, registryMode: next })
  return next
}

/** Test seam: drops the in-memory copy so a new temp directory is read from scratch. */
export function resetStoreCache(): void {
  cached = undefined
  cachedPath = ""
}
