import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { downloadsFor, registryFetch, type Downloads } from "./registry"
import {
  classify,
  cliCommand,
  configureCli,
  hasCli,
  pluginAdd,
  pluginCheck,
  pluginList,
  pluginReload,
  pluginRemove,
  pluginUpdate,
  runCli,
  type CliOutcome,
  type CliResult,
} from "./cli"
import { isPathSource, packageNameOf, parsePluginCheck, parsePluginList, type CheckRow, type PluginListRow } from "./official-parse"
import { disableRule, enableRule, evaluateRules, exactRulesFor, isControlSpec, parseControl } from "./rules"
import { forgetRule, lookupId, readStore, rememberId, rememberRule } from "./store"

export { isControlSpec } from "./rules"

export interface InstalledEntryValue {
  spec: string
  name: string
  kind: string
  version: string
  removable: boolean
  /** One-line summary from the installed package.json, empty when it cannot be read. */
  description?: string
  /** SPDX license from the installed package.json; empty when unknown. */
  license?: string
  homepage?: string
  repo?: string
  /** Runtime plugin ID the host reports for this entry; empty when it is not loaded. */
  id?: string
  /** True when the entry is a bare ID rule this hub appended to re-enable a plugin. */
  rule?: boolean
  /** True when the config entry carries plugin options (`{package, options}`), which are preserved. */
  options?: boolean
}

export interface HubStateValue {
  configPath: string
  configKey: string
  plugins: InstalledEntryValue[]
  error: string
}

export interface SearchHitValue {
  name: string
  version: string
  description: string
  /** Publish date of the latest version, ISO 8601. */
  published: string
  /** Legacy alias of `published`, so an older window bundle can still decode this payload. */
  updated: string
  installed: boolean
  /** Version currently on disk, empty when it cannot be read. */
  current: string
  /** True when the registry has a version newer than the installed one. */
  hasUpdate: boolean
  /** Downloads in the last week. */
  weekly: number
  /** Downloads in the last month. */
  monthly: number
  publisher: string
  license: string
  keywords: string[]
  homepage: string
  repo: string
  npm: string
}

/** The detail dialog's payload: npm metadata plus the README that says what the plugin does. */
export interface PackageDetailValue {
  name: string
  version: string
  description: string
  homepage: string
  repo: string
  /** Monorepo subdirectory, e.g. `packages/trae`. */
  repoDir: string
  npm: string
  bugs: string
  license: string
  keywords: string[]
  maintainers: string[]
  /** Weekly downloads; `-1` when the download API could not be asked (unknown, not zero). */
  weekly: number
  /** Monthly downloads; `-1` when the download API could not be asked (unknown, not zero). */
  monthly: number
  published: string
  created: string
  versions: number
  unpacked: number
  files: number
  dependencies: string[]
  deprecated: string
  readme: string
  readmeTruncated: boolean
  installed: boolean
  current: string
  hasUpdate: boolean
  error: string
}

export interface SearchResultValue {
  hits: SearchHitValue[]
  error: string
}

/**
 * One row of the update view.
 *
 * `official` is what `opencode plugin check` said about this plugin, and it — not the registry —
 * decides whether an update may be offered:
 * - `current`   the CLI reports the installed version as current
 * - `outdated`  the CLI reports a newer version, and `latest` holds it
 * - `failed`    the CLI could not check this plugin (bad manifest, offline, …)
 * - `skipped`   the CLI never reported it: local directories and exact revisions are skipped by design
 * - `unknown`   the CLI answered with something this build does not recognise; nothing is claimed
 */
export interface UpdateInfoValue {
  spec: string
  /** Real package name: for a directory plugin this comes from its package.json, not the folder name. */
  name: string
  /** Runtime plugin ID the CLI used in its own report; empty when it is not loaded. */
  id: string
  kind: string
  current: string
  /** Newer version the CLI named; empty when it did not name one. */
  latest: string
  hasUpdate: boolean
  official: string
  /** Why this row is not updatable, in words; empty when it is current or updatable. */
  reason: string
  /** False for directory plugins, which the official npm flow never touches. */
  managed: boolean
  /** True when the config pins an exact version, which the CLI deliberately leaves alone. */
  pinned: boolean
  description?: string
  license?: string
  homepage?: string
  repo?: string
  publisher?: string
  error: string
}

export interface UpdatesResultValue {
  items: UpdateInfoValue[]
  /** Set when the update check itself could not run; per-row results then carry no meaning. */
  error: string
  /** The CLI's own words when the check failed as a whole. */
  raw?: string
  /** False when the check never ran because no CLI is reachable. */
  checked: boolean
}

export interface MutationValue {
  ok: boolean
  message: string
  state: HubStateValue
  /**
   * When installing or updating replaced this plugin itself, the config now names the new
   * version while this window still renders the previous bundle. The UI says so and leaves
   * loading to OpenCode's own mechanism; the hub never restarts the host. See contract.ts.
   */
  selfUpdated?: boolean
  /** What the config, the CLI and the runtime each said after the operation. */
  verification?: string
}

const SELF_PACKAGE = "opencode-plugin-hub"
const NPM_KEYWORD = "opencode-plugin"
/** A registry lookup is reused for this long, so opening the page twice is not two requests. */
const VERSION_TTL = 5 * 60 * 1000

/** The host's own CLI, handed over once at startup; every package operation goes through it. */
export function useCli(argv: readonly string[] | undefined): void {
  configureCli(argv)
}

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode")
}

function cacheDir() {
  const xdg = process.env.XDG_CACHE_HOME
  return xdg ? join(xdg, "opencode", "npm") : join(homedir(), ".cache", "opencode", "npm")
}

/** One entry of the `plugins` array, keeping its position so edits hit the right element. */
interface ConfigEntry {
  /** Position in the raw array; edits and removals are addressed by this. */
  index: number
  /** The configured spec: the string itself, or an object's `package`. */
  spec: string
  /** True when the entry is `{package, options}` — replacing it must keep the options. */
  options: boolean
  raw: unknown
}

interface ConfigFile {
  path: string
  text: string
  key: string
  /** The array exactly as written, including entries this build does not manage. */
  raw: unknown[]
  entries: ConfigEntry[]
}

/**
 * Reads the entries the hub understands while keeping everything else on disk untouched.
 * Unknown shapes (an object without `package`, a number) are preserved but not managed.
 */
function normalize(raw: unknown[]): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  for (const [index, value] of raw.entries()) {
    if (typeof value === "string") {
      entries.push({ index, spec: value, options: false, raw: value })
      continue
    }
    if (value && typeof value === "object") {
      const pkg = (value as { package?: unknown }).package
      if (typeof pkg === "string" && pkg.trim().length > 0) {
        entries.push({ index, spec: pkg, options: true, raw: value })
      }
    }
  }
  return entries
}

async function readConfig(): Promise<ConfigFile> {
  const dir = configDir()
  // Same order the official CLI uses: opencode.json first, then opencode.jsonc. Reading a
  // different file than the CLI writes would make every "re-read after the command" a lie.
  const candidates = [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]
  let fallback: ConfigFile | undefined
  for (const path of candidates) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    const errors: ParseError[] = []
    const doc = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
      | Record<string, unknown>
      | undefined
    const record = doc && typeof doc === "object" ? doc : {}
    const key = Array.isArray(record.plugins) ? "plugins" : Array.isArray(record.plugin) ? "plugin" : "plugins"
    const list = Array.isArray(record[key]) ? (record[key] as unknown[]) : []
    const file: ConfigFile = { path, text, key, raw: list, entries: normalize(list) }
    if (file.entries.length > 0) return file
    if (!fallback) fallback = file
  }
  if (fallback) return fallback
  // Nothing on disk yet: create the JSON config next to whatever exists.
  return { path: join(dir, "opencode.json"), text: "{}\n", key: "plugins", raw: [], entries: [] }
}

/** A registry package name: optional `@scope/`, then letters, digits, `-`, `_`, `.` — but no path traversal. */
function isPackageName(name: string): boolean {
  if (!/^(@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i.test(name)) return false
  if (name.includes("..")) return false
  const base = name.split("/").pop() ?? name
  return base.length > 0 && !base.startsWith(".")
}

export function splitSpec(spec: string): { name: string; range: string; kind: string } {
  const trimmed = spec.trim()
  if (isPathSource(trimmed)) {
    const base = trimmed.replace(/\/+$/, "").split("/").pop() ?? trimmed
    return { name: base, range: "", kind: "path" }
  }
  const scoped = trimmed.startsWith("@")
  const at = trimmed.indexOf("@", scoped ? 1 : 0)
  if (at > 0) return { name: trimmed.slice(0, at), range: trimmed.slice(at + 1), kind: "package" }
  return { name: trimmed, range: "", kind: "package" }
}

function expandPath(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2))
  // The server resolves relative plugin paths against the opencode config
  // directory (e.g. "./local-plugins/x" -> ~/.config/opencode/local-plugins/x),
  // not the process cwd. Resolve the same way so identity comparisons match.
  return isAbsolute(trimmed) ? trimmed : resolve(configDir(), trimmed)
}

interface Manifest {
  name?: string
  version?: string
  description?: string
  homepage?: string
  repository?: string | { url?: string; directory?: string }
  license?: string | { type?: string }
}

/** The package.json of a directory plugin: the only place its real name and version live. */
async function readManifest(dir: string): Promise<Manifest | undefined> {
  try {
    const raw = await readFile(join(dir, "package.json"), "utf8")
    const json = JSON.parse(raw) as Manifest
    return typeof json === "object" && json !== null ? json : undefined
  } catch {
    return undefined
  }
}

/**
 * The package.json of an installed registry plugin, read from OpenCode's unpacked npm cache.
 *
 * This is the only place an installed plugin's own summary lives. Going to the registry instead
 * makes the installed cards depend on the network: when the registry is unreachable the manifest
 * lookup fails and every card loses its description, even though the package is sitting on disk.
 */
async function readInstalledManifest(name: string, range: string): Promise<Manifest | undefined> {
  const wanted = range && range !== "latest" ? range : "latest"
  const roots = Array.from(new Set([`${name}@${wanted}`, `${name}@latest`]))
  for (const root of roots) {
    const dir = join(cacheDir(), root)
    let stamps: string[]
    try {
      stamps = await readdir(dir)
    } catch {
      continue
    }
    for (const stamp of stamps.reverse()) {
      try {
        const raw = await readFile(join(dir, stamp, "node_modules", name, "package.json"), "utf8")
        const json = JSON.parse(raw) as Manifest
        if (typeof json === "object" && json !== null && json.version) return json
      } catch {
        // try the next cached install
      }
    }
  }
  return undefined
}

/** A version range is not a version: only a bare `x.y.z` can be compared. */
function literalVersion(range: string): string {
  const cleaned = range.trim().replace(/^[\^~=v]+/, "").replace(/^>\=?|^<\=?/, "")
  return /^\d+(\.\d+)*([-+][\w.-]+)?$/.test(cleaned) ? cleaned : ""
}

function parts(version: string): number[] {
  return version
    .split("-")[0]!
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0)
}

function isNewer(candidate: string, current: string): boolean {
  if (!candidate) return false
  if (!current) return true
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

interface VersionLookup {
  /** Newest published version; empty when the package has none. */
  version: string
  /** False when the registry could not be reached, so `version` carries no meaning. */
  ok: boolean
  /** One-line summary from the latest manifest; the installed list shows it instead of blank space. */
  description: string
  license: string
  homepage: string
  repo: string
  publisher: string
}

function emptyLookup(ok: boolean): VersionLookup {
  return { version: "", ok, description: "", license: "", homepage: "", repo: "", publisher: "" }
}

const versionCache = new Map<string, { at: number; value: VersionLookup }>()

/**
 * Newest published version plus the small manifest fields the installed list shows.
 * `ok` separates "the registry says there is nothing newer" from "the registry was never
 * reached" — showing the second as "up to date" would be a lie.
 *
 * This is display data only: whether an update may be applied is decided by `opencode plugin check`.
 *
 * `/latest` is a single small manifest: the full packument can be megabytes and is only
 * needed by the detail dialog. A 404 means no published version (removed or placeholder).
 */
export async function npmLatest(name: string, force = false): Promise<VersionLookup> {
  const cached = versionCache.get(name)
  if (!force && cached && Date.now() - cached.at < VERSION_TTL) return cached.value
  const url = `/${encodeURIComponent(name)}/latest`
  let response: Response
  try {
    response = await registryFetch(url, { timeoutMs: 10_000 })
  } catch {
    return emptyLookup(false)
  }
  // 404 is a definite answer: no published version to update to.
  if (response.status === 404) return emptyLookup(true)
  if (!response.ok) return emptyLookup(false)
  try {
    const manifest = (await response.json()) as RegistryManifest & {
      maintainers?: { name?: string; username?: string }[]
      _npmUser?: { name?: string }
    }
    if (!manifest?.version) return emptyLookup(true)
    const repo = repository(manifest.repository)
    const maintainer = manifest.maintainers?.[0]
    const value: VersionLookup = {
      version: manifest.version,
      ok: true,
      description: manifest.description ?? "",
      license: licenseText(manifest.license),
      homepage: cleanUrl(manifest.homepage) || repo.url,
      repo: repo.url,
      publisher: maintainer?.name || maintainer?.username || manifest._npmUser?.name || "",
    }
    versionCache.set(name, { at: Date.now(), value })
    return value
  } catch {
    return emptyLookup(false)
  }
}

interface ResolvedEntry {
  entry: ConfigEntry
  spec: string
  name: string
  kind: string
  version: string
  description: string
  license: string
  homepage: string
  repo: string
  /** True when this entry is a bare ID rule the hub itself appended to re-enable a plugin. */
  rule: boolean
}

/** Normalizes one config entry, looking inside directory plugins for their real identity. */
async function resolveEntry(entry: ConfigEntry): Promise<ResolvedEntry> {
  const spec = entry.spec
  const hubRule = !entry.options && readStore().rules.includes(spec)
  // Control entries carry no installable identity: `-acme.reviewer` is a disable rule for
  // the plugin ID `acme.reviewer`, and `*` / `.*` are wildcards. Reporting them as
  // installed packages (with a `-` prefix) would misstate what is actually loading.
  if (isControlSpec(spec) || hubRule) {
    const rule = parseControl(spec, entry.index)
    return {
      entry,
      spec,
      name: rule ? rule.target : spec.trim().replace(/^-/, ""),
      kind: hubRule ? "enable-rule" : "control",
      version: "",
      description: "",
      license: "",
      homepage: "",
      repo: "",
      rule: hubRule,
    }
  }
  const parsed = splitSpec(spec)
  if (parsed.kind !== "path") {
    // Read the installed manifest first: it carries the summary that the installed cards show,
    // and it is on disk, so the description does not disappear when the registry is unreachable.
    const manifest = await readInstalledManifest(parsed.name, parsed.range)
    const repo = repository(manifest?.repository)
    const version = literalVersion(parsed.range) || manifest?.version || ""
    return {
      entry,
      spec,
      name: parsed.name,
      kind: parsed.kind,
      version,
      description: manifest?.description ?? "",
      license: licenseText(manifest?.license),
      homepage: cleanUrl(manifest?.homepage) || repo.url,
      repo: repo.url,
      rule: false,
    }
  }
  const manifest = await readManifest(expandPath(spec))
  const repo = repository(manifest?.repository)
  return {
    entry,
    spec,
    name: manifest?.name && isPackageName(manifest.name) ? manifest.name : parsed.name,
    kind: "path",
    version: manifest?.version ?? "",
    description: manifest?.description ?? "",
    license: licenseText(manifest?.license),
    homepage: cleanUrl(manifest?.homepage) || repo.url,
    repo: repo.url,
    rule: false,
  }
}

async function resolveAll(file: ConfigFile): Promise<ResolvedEntry[]> {
  return Promise.all(file.entries.map((entry) => resolveEntry(entry)))
}

export async function snapshot(): Promise<HubStateValue> {
  try {
    const file = await readConfig()
    const resolved = await resolveAll(file)
    const plugins: InstalledEntryValue[] = resolved.map((entry) => ({
      spec: entry.spec,
      name: entry.name,
      kind: entry.kind,
      version: entry.version,
      removable: entry.name !== SELF_PACKAGE,
      // The summary travels with the snapshot so the installed cards have it before (and
      // without) the registry check — reading it costs nothing, it is already on disk.
      description: entry.description,
      license: entry.license,
      homepage: entry.homepage,
      repo: entry.repo,
      rule: entry.rule || undefined,
      options: entry.entry.options || undefined,
    }))
    return { configPath: file.path, configKey: file.key, plugins, error: "" }
  } catch (error) {
    return {
      configPath: join(configDir(), "opencode.json"),
      configKey: "plugins",
      plugins: [],
      error: describe(error),
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime truth: the official `plugin list` plus the sidecar's failure details
// ---------------------------------------------------------------------------

/** One configured plugin's runtime truth, as the running host reports it. */
export interface RuntimeInfoValue {
  spec: string
  name: string
  /** Runtime plugin ID; empty when the host did not load it (or printed `-`). */
  id: string
  /** "loaded", "failed", "unknown" (no runtime answer) or "control" (a config rule, not a plugin). */
  status: "loaded" | "failed" | "unknown" | "control"
  /** Version the runtime loaded, empty when unknown. */
  runtimeVersion: string
  /** The runtime's failure message for a plugin that failed to load. */
  error: string
  /** True when a runtime source answered; false when none could be asked. */
  available: boolean
  /** True when config rules currently disable this plugin. */
  paused: boolean
  /** The rule that decides the disabled/enabled verdict, as written in the config. */
  rule: string
  /** Every rule that mentions this plugin, in config order. */
  rules: string[]
}

/** A plugin the runtime reports that the global config does not list. */
export interface DiscoveredPluginValue {
  id: string
  version: string
  source: string
  section: string
}

export interface RuntimeResultValue {
  items: RuntimeInfoValue[]
  /** Plugins loaded from discovery directories or project config, not from the global list. */
  discovered: DiscoveredPluginValue[]
  error: string
}

interface PluginListInfo {
  source?:
    | { type: "builtin" }
    | { type: "package"; target?: string; version?: string; outdated?: true; updating?: true }
    | { type: "local"; path?: string }
    | { type: "sdk" }
  state?: { status: "active" } | { status: "failed"; error?: string }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The rows `opencode plugin list` reports for the current project.
 *
 * The managed service can answer with an empty table while it is still starting (right after a
 * reload, for instance). One short retry keeps the UI from painting every plugin as "unverified"
 * for a reason that is not about the plugins at all.
 */
async function readRuntimeRows(expectRows: boolean): Promise<{ rows: PluginListRow[]; ok: boolean; message: string }> {
  if (!hasCli()) return { rows: [], ok: false, message: "找不到 opencode CLI" }
  const first = await pluginList()
  const rows = first.ok ? parsePluginList(first.stdout) : []
  if (first.ok && rows.length === 0 && expectRows) {
    await delay(250)
    const second = await pluginList()
    return { rows: second.ok ? parsePluginList(second.stdout) : rows, ok: second.ok, message: second.message }
  }
  return { rows, ok: first.ok, message: first.message }
}

/** Runtime rows keyed by the package name or absolute path a config entry would resolve to. */
function indexRows(rows: readonly PluginListRow[]): Map<string, PluginListRow> {
  const map = new Map<string, PluginListRow>()
  for (const row of rows) {
    const key = row.kind === "path" ? `path:${resolve(expandPath(row.source))}` : `pkg:${packageNameOf(row.source).toLowerCase()}`
    // The first row for a target wins; a duplicate config entry does not get a second identity.
    if (!map.has(key)) map.set(key, row)
  }
  return map
}

function rowKeyFor(entry: ResolvedEntry): string {
  return entry.kind === "path" ? `path:${resolve(expandPath(entry.spec))}` : `pkg:${entry.name.toLowerCase()}`
}

/**
 * Cross-references the config with the running host, so the UI can tell 已配置待生效 from 已加载,
 * 已暂停 from 加载失败. Two sources, on purpose:
 * - `opencode plugin list` answers "what ID did it load under, and at which version";
 * - the sidecar's `/api/plugin` answers "did it fail, and why".
 * When neither answers, every item stays "unknown" instead of pretending to know.
 */
export async function runtime(
  endpoint: { url: string; headers: Readonly<Record<string, string>> } | undefined,
): Promise<RuntimeResultValue> {
  const file = await readConfig()
  const resolved = await resolveAll(file)

  const list = await readRuntimeRows(resolved.length > 0)
  const rows = list.rows
  const byKey = indexRows(rows)

  const sidecar = endpoint ? await readSidecar(endpoint) : { list: [] as PluginListInfo[], error: endpoint ? "" : "无法连接后台服务，运行状态未知" }
  const failures = new Map<string, string>()
  const sidecarLoaded = new Set<string>()
  for (const info of sidecar.list) {
    const source = info.source
    if (!source) continue
    const key =
      source.type === "package" && typeof source.target === "string"
        ? `pkg:${packageNameOf(source.target).toLowerCase()}`
        : source.type === "local" && typeof source.path === "string"
          ? `path:${resolve(source.path)}`
          : ""
    if (!key) continue
    sidecarLoaded.add(key)
    if (info.state?.status === "failed") failures.set(key, info.state.error ?? "加载失败")
  }

  const items: RuntimeInfoValue[] = []
  const claimed = new Set<string>()
  for (const entry of resolved) {
    const base = { spec: entry.spec, name: entry.name }
    if (entry.kind === "control" || entry.kind === "enable-rule") {
      items.push({ ...base, id: "", status: "control", runtimeVersion: "", error: "", available: true, paused: false, rule: entry.spec, rules: [] })
      continue
    }
    const key = rowKeyFor(entry)
    const row = byKey.get(key)
    claimed.add(key)
    const id = row?.id ?? ""
    if (id) rememberId(key, id)

    // Rules are evaluated against the real ID when it is known, and against the configured name
    // otherwise. The verdict says which rule decided it, so the UI can name it.
    const targets = Array.from(new Set([id, entry.name].filter((value) => value.length > 0)))
    const verdict = targets.length > 0 ? evaluateRules(file.raw, targets[0]!) : undefined
    const paused = verdict?.disabled === true
    // Only syntax-level control rules are listed as rules: a package entry that names the plugin
    // is the plugin itself, not a rule the user wrote about it.
    const rules = (verdict?.matches ?? []).filter((rule) => isControlSpec(rule.raw)).map((rule) => rule.raw)

    const failure = failures.get(key)
    const loaded = sidecarLoaded.has(key) || (row !== undefined && row.id.length > 0)
    const status: RuntimeInfoValue["status"] = failure
      ? "failed"
      : loaded
        ? "loaded"
        : "unknown"
    items.push({
      ...base,
      id,
      status,
      runtimeVersion: row?.version && row.version !== "local" ? row.version : entry.version,
      error: failure ?? "",
      available: sidecar.error === "" || list.ok,
      paused,
      rule: paused ? verdict?.rule?.raw ?? "" : "",
      rules,
    })
  }

  const discovered: DiscoveredPluginValue[] = rows
    .filter((row) => !claimed.has(row.kind === "path" ? `path:${resolve(expandPath(row.source))}` : `pkg:${packageNameOf(row.source).toLowerCase()}`))
    .map((row) => ({ id: row.id, version: row.version, source: row.source, section: row.section }))

  const error = sidecar.error && !list.ok ? `${sidecar.error}${list.message ? `；${list.message}` : ""}` : ""
  return { items, discovered, error }
}

async function readSidecar(endpoint: { url: string; headers: Readonly<Record<string, string>> }): Promise<{ list: PluginListInfo[]; error: string }> {
  try {
    // The sidecar serves its web UI at `/`, so `/plugin` is an HTML page. The JSON API lives
    // under `/api`; asking the wrong path yields 200 HTML and a confusing parse error.
    const response = await fetch(`${endpoint.url.replace(/\/+$/, "")}/api/plugin`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json", ...endpoint.headers },
    })
    if (!response.ok) return { list: [], error: `后台服务返回 ${response.status}，运行状态未知` }
    const text = await response.text()
    let body: { data?: PluginListInfo[] } | PluginListInfo[]
    try {
      body = JSON.parse(text) as { data?: PluginListInfo[] } | PluginListInfo[]
    } catch {
      return { list: [], error: "后台返回的不是 JSON，运行状态未知" }
    }
    return { list: Array.isArray(body) ? body : body.data ?? [], error: "" }
  } catch (error) {
    return { list: [], error: `无法读取运行状态：${describe(error)}` }
  }
}

// ---------------------------------------------------------------------------
// Update check: `opencode plugin check` decides, the registry only explains
// ---------------------------------------------------------------------------

/** Compares every configured plugin against the official update check. */
export async function updates(): Promise<UpdatesResultValue> {
  if (!hasCli()) {
    return { items: [], error: "找不到 opencode CLI，无法执行官方更新检查", checked: false }
  }
  let file: ConfigFile
  let resolved: ResolvedEntry[]
  try {
    file = await readConfig()
    resolved = await resolveAll(file)
  } catch (error) {
    return { items: [], error: describe(error), checked: false }
  }

  const list = await readRuntimeRows(resolved.length > 0)
  const byKey = indexRows(list.rows)

  const check = await pluginCheck()
  // Exit code 1 is normal here: `plugin check` also exits non-zero when one plugin could not be
  // checked while the rest succeeded. Only a total failure (no parsable rows, no CLI) is fatal.
  const checkRows = parsePluginCheck(`${check.stdout}\n${check.stderr}`)
  const byId = new Map<string, CheckRow>()
  for (const row of checkRows) byId.set(row.id.toLowerCase(), row)

  const items = await Promise.all(
    resolved.map(async (entry): Promise<UpdateInfoValue> => {
      const base: UpdateInfoValue = {
        spec: entry.spec,
        name: entry.name,
        id: "",
        kind: entry.kind,
        current: entry.version,
        latest: "",
        hasUpdate: false,
        official: "unknown",
        reason: "",
        managed: entry.kind !== "path" && entry.kind !== "control" && entry.kind !== "enable-rule",
        pinned: literalVersion(splitSpec(entry.spec).range) !== "",
        description: entry.description,
        license: entry.license,
        homepage: entry.homepage,
        repo: entry.repo,
        publisher: "",
        error: "",
      }
      if (entry.kind === "control" || entry.kind === "enable-rule") {
        return { ...base, official: "skipped", reason: "配置规则，不是插件包", managed: false }
      }
      const row = byKey.get(rowKeyFor(entry))
      const id = row?.id ?? ""
      const official = id ? byId.get(id.toLowerCase()) : undefined
      // Registry metadata is display-only: it never decides that an update exists.
      const lookup = isPackageName(entry.name) ? await npmLatest(entry.name) : emptyLookup(false)
      const shared = {
        ...base,
        id,
        publisher: lookup.publisher,
        description: base.description || lookup.description,
        license: base.license || lookup.license,
        homepage: base.homepage || lookup.homepage,
        repo: base.repo || lookup.repo,
      }
      if (entry.kind === "path") {
        return {
          ...shared,
          official: "skipped",
          managed: false,
          reason: "本地目录插件由外部维护，官方更新流程会跳过它（目录里的改动不会被覆盖）",
        }
      }
      if (!official) {
        if (base.pinned) {
          return { ...shared, official: "skipped", reason: `配置精确锁定 ${base.current}，官方更新会跳过精确版本` }
        }
        return {
          ...shared,
          official: "unknown",
          reason: id
            ? "官方检查结果里没有这个插件"
            : "宿主尚未加载这个插件，官方检查拿不到它的 ID（安装后需要先加载一次）",
        }
      }
      if (official.status === "outdated") {
        return {
          ...shared,
          official: "outdated",
          latest: official.latest,
          current: official.version || base.current,
          // A pinned version is never offered as a one-click update: `plugin update` skips exact
          // revisions, so the button would only ever produce "nothing to update".
          hasUpdate: official.latest !== "" && !base.pinned,
          reason: base.pinned
            ? `配置精确锁定 ${base.current || official.version}，官方更新会跳过精确版本；要换版本请用「npm 搜索」安装指定版本`
            : "",
        }
      }
      if (official.status === "failed") {
        return { ...shared, official: "failed", reason: official.note || "官方检查这个插件时出错", error: official.note }
      }
      if (official.status === "current") {
        return { ...shared, official: "current", current: official.version || base.current }
      }
      if (official.status === "skipped") {
        return { ...shared, official: "skipped", reason: official.note || "官方更新会跳过这个插件" }
      }
      return { ...shared, official: "unknown", reason: official.note ? `官方输出无法识别：${official.note}` : "官方输出无法识别" }
    }),
  )

  const totalFailure = checkRows.length === 0 && !check.ok
  return {
    items,
    error: totalFailure ? "官方更新检查没有返回可解析的结果" : "",
    raw: totalFailure ? check.message : undefined,
    checked: !totalFailure,
  }
}

// ---------------------------------------------------------------------------
// Config edits: one atomic, queued writer
// ---------------------------------------------------------------------------

/**
 * Edits values in place, so the user's comments, ordering and indentation survive on every other line.
 * Paths are jsonc paths such as `["plugins", 2]`.
 *
 * All config mutations funnel through this function while holding a module-level
 * queue: two overlapping edits (two cards, or the settings page and the dialog)
 * each re-read the file inside their turn, so neither clobbers the other.
 * Writes land via tmp-file + rename so a crash cannot leave a half-written config.
 */
let configQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = configQueue.then(task, task)
  configQueue = next.catch(() => undefined)
  return next
}

interface Edit {
  path: (string | number)[]
  value: unknown
}

/**
 * Applies one or more edits under the queue. Removals must be ordered by descending index by the
 * caller; the edits are applied to the same text, so a lower index would otherwise shift.
 */
async function applyEditsTo(file: ConfigFile, edits: readonly Edit[]): Promise<void> {
  const fresh = await readConfig()
  let text = fresh.text.trim().length > 0 ? fresh.text : "{}\n"
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }
  for (const edit of edits) {
    text = applyEdits(text, modify(text, edit.path, edit.value, options))
  }
  await atomicWrite(fresh.path, text)
}

async function editConfig(edits: readonly Edit[]): Promise<HubStateValue> {
  return enqueue(async () => {
    // Re-read inside the queue: the file may have changed since the caller read it.
    const fresh = await readConfig()
    await applyEditsTo(fresh, edits)
    return snapshot()
  })
}

/** Write via a temp file in the same directory, then rename over the target (atomic on the same volume). */
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.plugin-hub-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(tmp, text, "utf8")
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** The config entry that owns `name`, matching either the raw name or a directory's package.json name. */
async function findEntry(file: ConfigFile, name: string): Promise<ResolvedEntry | undefined> {
  for (const entry of file.entries) {
    if (splitSpec(entry.spec).name === name) return resolveEntry(entry)
  }
  for (const entry of file.entries) {
    if (splitSpec(entry.spec).kind !== "path") continue
    const manifest = await readManifest(expandPath(entry.spec))
    if (manifest?.name === name) return resolveEntry(entry)
  }
  return undefined
}

async function findBySpec(file: ConfigFile, spec: string): Promise<ResolvedEntry | undefined> {
  const wanted = spec.trim()
  const entry = file.entries.find((item) => item.spec.trim() === wanted)
  return entry ? resolveEntry(entry) : undefined
}

// ---------------------------------------------------------------------------
// Mutations that go through the official CLI
// ---------------------------------------------------------------------------

function outputDetail(outcome: CliOutcome): string {
  const text = outcome.result.message
  return text ? `（CLI：${text}）` : ""
}

/** Re-reads config and runtime after a command, and says what each of them now reports. */
async function verify(endpoint?: { url: string; headers: Readonly<Record<string, string>> }): Promise<{ state: HubStateValue; note: string }> {
  const state = await snapshot()
  const live = await runtime(endpoint)
  const loaded = live.items.filter((item) => item.status === "loaded").length
  const paused = live.items.filter((item) => item.paused).length
  const failed = live.items.filter((item) => item.status === "failed").length
  const parts = [`配置 ${state.plugins.length} 项`, `运行时已加载 ${loaded} 个`]
  if (paused > 0) parts.push(`已暂停 ${paused} 个`)
  if (failed > 0) parts.push(`加载失败 ${failed} 个`)
  if (live.error) parts.push(live.error)
  return { state, note: parts.join(" · ") }
}

export interface MutationOptions {
  endpoint?: { url: string; headers: Readonly<Record<string, string>> }
}

/**
 * Installs or re-versions an npm plugin through `opencode plugin add`.
 *
 * The command is the only thing that may touch the package; the hub never copies files or writes
 * an install cache of its own. A directory entry is refused here on purpose: rewriting files in a
 * user's working tree is not something an install button should do (see README).
 */
export async function install(spec: string, version: string, options: MutationOptions = {}): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const parsed = splitSpec(spec)
    if (parsed.kind !== "package" || !isPackageName(parsed.name)) {
      return { ok: false, message: "只能按 npm 包名安装", state: await snapshot() }
    }
    if (!hasCli()) {
      return { ok: false, message: "找不到 opencode CLI，无法执行 opencode plugin add", state: await snapshot() }
    }
    const name = parsed.name
    const target = version.trim() ? `${name}@${version.trim()}` : name
    const existing = await findEntry(file, name)

    if (existing?.kind === "path") {
      return {
        ok: false,
        message: `${existing.spec} 是本地目录插件，由外部维护：插件中心不会下载 npm 包覆盖它。请在配置里改为 npm 包，或自行更新目录内容。`,
        state: await snapshot(),
      }
    }
    if (existing && existing.spec.trim() === target) {
      const verified = await verify(options.endpoint)
      return {
        ok: true,
        message: `${name} 已在配置中（${existing.spec}），没有再次安装`,
        state: verified.state,
        verification: verified.note,
      }
    }

    // A different version of an already configured package: the CLI appends instead of replacing,
    // which would leave two entries for one package. Remove the old entry first, and put it back
    // if the new one cannot be installed.
    if (existing) {
      const removed = await pluginRemove(existing.spec)
      if (!removed.result.ok && removed.status !== "not-configured") {
        return { ok: false, message: `换版本前移除旧条目失败${outputDetail(removed)}`, state: await snapshot() }
      }
      const added = await pluginAdd(target)
      if (!added.result.ok) {
        const restored = await pluginAdd(existing.spec)
        const tail = restored.result.ok ? "已恢复原条目。" : `恢复原条目也失败了${outputDetail(restored)}`
        return {
          ok: false,
          message: `安装 ${target} 失败${outputDetail(added)}。${tail}`,
          state: await snapshot(),
        }
      }
      const verified = await verify(options.endpoint)
      return {
        ok: true,
        message: `已通过 opencode plugin add 把 ${name} 换成 ${target}（旧条目 ${existing.spec} 已移除）。配置与运行状态已重新读取。`,
        selfUpdated: name === SELF_PACKAGE || undefined,
        state: verified.state,
        verification: verified.note,
      }
    }

    const added = await pluginAdd(target)
    if (!added.result.ok) {
      return { ok: false, message: `安装 ${target} 失败${outputDetail(added)}`, state: await snapshot() }
    }
    const verified = await verify(options.endpoint)
    const where = added.path ? `写入 ${added.path}` : "已写入配置"
    const message =
      added.status === "already"
        ? `${target} 已配置，命令没有改动配置`
        : `已通过 opencode plugin add 安装 ${target}，${where}`
    return {
      ok: true,
      message,
      selfUpdated: name === SELF_PACKAGE || undefined,
      state: verified.state,
      verification: verified.note,
    }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

/**
 * Updates one plugin through `opencode plugin update <target>`.
 *
 * The official command skips local plugins and exact revisions, and says so — that reason is
 * reported instead of being replaced with a made-up "up to date".
 */
export async function update(spec: string, options: MutationOptions = {}): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const entry = await findBySpec(file, spec)
    if (!entry) return { ok: false, message: "配置中没有这一项", state: await snapshot() }
    if (entry.kind === "path") {
      return {
        ok: false,
        message: `${entry.spec} 是本地目录插件，官方更新流程会跳过它：目录里可能有你的改动。需要时请自行更新目录内容（插件中心不覆盖本地目录）。`,
        state: await snapshot(),
      }
    }
    if (entry.kind === "control" || entry.kind === "enable-rule") {
      return { ok: false, message: "配置规则不是插件包，没有可更新的版本", state: await snapshot() }
    }
    if (!hasCli()) {
      return { ok: false, message: "找不到 opencode CLI，无法执行 opencode plugin update", state: await snapshot() }
    }
    const before = entry.version
    const outcome = await pluginUpdate(entry.spec)
    const verified = await verify(options.endpoint)
    // The command may rewrite the spec (`pkg` -> `pkg@1.2.0`), so match by name, not by spec.
    const after = verified.state.plugins.find((item) => item.name === entry.name)?.version ?? before
    if (!outcome.result.ok) {
      return {
        ok: false,
        message: `更新 ${entry.name} 失败${outputDetail(outcome)}`,
        state: verified.state,
        verification: verified.note,
      }
    }
    if (outcome.status === "no-updates") {
      return {
        ok: true,
        message: `官方命令报告没有可更新的插件：本地插件与精确锁定版本会被跳过，${entry.name} 未发生变化`,
        state: verified.state,
        verification: verified.note,
      }
    }
    const moved = after && after !== before ? (before ? `v${before} → v${after}` : `v${after}`) : "版本号未变化"
    return {
      ok: true,
      message: `已执行 opencode plugin update ${entry.spec}：${moved}。配置与运行状态已重新读取${after ? "" : "，但读不到新版本号"}`,
      selfUpdated: entry.name === SELF_PACKAGE || undefined,
      state: verified.state,
      verification: verified.note,
    }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

/**
 * Removes a plugin.
 *
 * npm packages go through `opencode plugin remove`; a directory entry is edited out of the config
 * only — the files stay on disk, and the message says so explicitly.
 */
export async function remove(spec: string): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const entry = await findBySpec(file, spec)
    if (!entry) return { ok: false, message: "配置中没有这一项", state: await snapshot() }
    if (entry.name === SELF_PACKAGE) {
      return { ok: false, message: "不能移除正在运行的插件中心自身", state: await snapshot() }
    }

    if (entry.kind === "path" || entry.kind === "enable-rule" || entry.kind === "control") {
      const state = await editConfig([{ path: [file.key, entry.entry.index], value: undefined }])
      if (entry.kind === "enable-rule") forgetRule(entry.spec)
      if (entry.kind === "control" && entry.name) forgetRule(entry.name)
      const gone = state.plugins.every((item) => item.spec !== entry.spec)
      return {
        ok: gone,
        message: gone
          ? entry.kind === "enable-rule"
            ? `已移除插件中心追加的启用规则 ${entry.spec}（配置里其他规则没有改动）`
            : entry.kind === "control"
              ? `已从配置移除规则 ${entry.spec}；其他规则与插件条目没有改动`
              : `已从配置移除目录条目 ${entry.spec}；磁盘上的目录 ${expandPath(entry.spec)} 没有被删除`
          : `移除失败：配置里仍然有 ${entry.spec}`,
        state,
      }
    }

    if (!hasCli()) {
      return { ok: false, message: "找不到 opencode CLI，无法执行 opencode plugin remove", state: await snapshot() }
    }
    const outcome = await pluginRemove(entry.spec)
    const state = await snapshot()
    const gone = state.plugins.every((item) => item.spec !== entry.spec)
    if (outcome.status === "not-configured" && !gone) {
      return { ok: false, message: `官方命令没有找到 ${entry.spec}${outputDetail(outcome)}`, state }
    }
    if (!outcome.result.ok && !gone) {
      return { ok: false, message: `移除 ${entry.spec} 失败${outputDetail(outcome)}`, state }
    }
    return {
      ok: gone,
      message: gone
        ? `已通过 opencode plugin remove 移除 ${entry.spec}（只改配置，不删除 npm 缓存里的包文件）`
        : `命令已执行，但配置里仍有 ${entry.spec}`,
      state,
    }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

// ---------------------------------------------------------------------------
// Pause / resume: config rules, never process management
// ---------------------------------------------------------------------------

interface IdLookup {
  id: string
  /** Where the ID came from, for the message the user reads. */
  from: "runtime" | "cache" | ""
}

/**
 * The real plugin ID, which is *not* always the package name: `opencode-notify` loads as
 * `opencode-notify-callback`, `opencode-plugin-hub` as `plugin-hub`.
 *
 * Order of trust: what the runtime reports right now, then what this hub has seen before for the
 * same package/path. If neither knows, the caller must refuse — guessing an ID would write a rule
 * that silently does nothing.
 */
async function resolveId(entry: ResolvedEntry): Promise<IdLookup> {
  const key = rowKeyFor(entry)
  if (hasCli()) {
    const list = await pluginList()
    if (list.ok) {
      const row = indexRows(parsePluginList(list.stdout)).get(key)
      if (row?.id) {
        rememberId(key, row.id)
        return { id: row.id, from: "runtime" }
      }
    }
  }
  const cached = lookupId(key)
  return cached ? { id: cached, from: "cache" } : { id: "", from: "" }
}

function ruleText(matches: readonly { raw: string }[]): string {
  return matches.map((rule) => rule.raw).join(" → ")
}

/** Asks the host to reload, and reports what the command said without claiming more than that. */
async function reloadAfterEdit(): Promise<string> {
  if (!hasCli()) return "未执行重载：找不到 opencode CLI"
  const result = await pluginReload()
  if (result.ok) return "已执行 opencode reload"
  return `opencode reload 未成功（${result.message || `退出码 ${result.code}`}）`
}

/**
 * Pauses a plugin by appending `-<real id>` to the plugin list.
 *
 * Nothing is uninstalled, no process is signalled: the entry stays in the config, the package stays
 * on disk, and only the rule that disables it is added. Because rules are processed in order, the
 * new rule is appended last so it wins over everything the user already wrote.
 */
export async function pause(spec: string, options: MutationOptions = {}): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const entry = await findBySpec(file, spec)
    if (!entry) return { ok: false, message: "配置中没有这一项", state: await snapshot() }
    if (entry.kind === "control" || entry.kind === "enable-rule") {
      return { ok: false, message: "配置规则不是插件包，无法暂停", state: await snapshot() }
    }
    const lookup = await resolveId(entry)
    if (!lookup.id) {
      return {
        ok: false,
        message: `无法确认 ${entry.name} 的插件 ID：宿主没有报告它加载时使用的 ID。为避免写入无效规则，未修改配置（请先让它成功加载一次，再暂停）。`,
        state: await snapshot(),
      }
    }
    const strings = file.raw.filter((value): value is string => typeof value === "string")
    const verdict = evaluateRules(strings, lookup.id)
    if (verdict.disabled) {
      return {
        ok: true,
        message: `${entry.name} 已经被规则 ${ruleText(verdict.matches)} 禁用，没有再次写入`,
        state: await snapshot(),
      }
    }
    const rule = disableRule(lookup.id)
    const index = file.raw.length
    const state = await editConfig([{ path: [file.key, index], value: rule }])
    const written = state.plugins.some((item) => item.spec === rule)
    if (!written) {
      return { ok: false, message: `写入禁用规则 ${rule} 失败`, state }
    }
    const reloaded = await reloadAfterEdit()
    const live = await runtime(options.endpoint)
    const info = live.items.find((item) => item.spec === entry.spec)
    const stillLoaded = info?.status === "loaded" && info.id === lookup.id
    const verification = stillLoaded
      ? `运行时仍报告 ${lookup.id} 已加载：规则已写入，但宿主尚未重新加载`
      : `运行时不再报告 ${lookup.id}，配置中新增规则 ${rule}`
    return {
      ok: true,
      message: `已暂停 ${entry.name}：在配置末尾追加禁用规则 ${rule}（ID 来自${lookup.from === "runtime" ? "宿主运行状态" : "本机记录的运行历史"}），插件条目与包文件都没有改动。${reloaded}。`,
      state,
      verification,
    }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

/**
 * Resumes a paused plugin.
 *
 * Not a reinstall: it deletes the exact `-<id>` rules the config holds for this plugin, and only
 * when a wildcard rule still disables it does it append the positive ID rule that re-enables it.
 * Wildcards themselves are never removed — they belong to the user and cover other plugins too.
 */
export async function resume(spec: string, options: MutationOptions = {}): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const entry = await findBySpec(file, spec)
    if (!entry) return { ok: false, message: "配置中没有这一项", state: await snapshot() }
    if (entry.kind === "control" || entry.kind === "enable-rule") {
      return { ok: false, message: "配置规则不是插件包，无法恢复", state: await snapshot() }
    }
    const lookup = await resolveId(entry)
    const ids = Array.from(new Set([lookup.id, entry.name, splitSpec(entry.spec).name].filter((value) => value.length > 0)))
    const strings = file.raw.filter((value): value is string => typeof value === "string")
    const exact = exactRulesFor(strings, ids)
    const evalTarget = lookup.id || entry.name
    const verdictBefore = evaluateRules(strings, evalTarget)
    const wildcardBlocked = verdictBefore?.matches.some((rule) => rule.scope !== "exact" && rule.negate) === true

    if (exact.length === 0 && !verdictBefore?.disabled) {
      return {
        ok: true,
        message: `${entry.name} 没有被禁用规则挡住，不需要恢复${lookup.id ? `（运行时 ID ${lookup.id}）` : ""}`,
        state: await snapshot(),
      }
    }
    if (exact.length === 0 && !lookup.id) {
      return {
        ok: false,
        message: `无法确认 ${entry.name} 的插件 ID：规则 ${verdictBefore ? ruleText(verdictBefore.matches) : ""} 覆盖了它，而宿主没有报告过它的 ID。为避免写入无效规则，未修改配置。`,
        state: await snapshot(),
      }
    }

    // Removals are applied from the highest index down so earlier positions stay valid.
    const removals: Edit[] = exact
      .slice()
      .sort((a, b) => b.index - a.index)
      .map((rule) => ({ path: [file.key, rule.index], value: undefined }))
    if (removals.length > 0) await editConfig(removals)

    const after = await readConfig()
    const remainingStrings = after.raw.filter((value): value is string => typeof value === "string")
    const verdictAfter = evaluateRules(remainingStrings, evalTarget)

    if (verdictAfter?.disabled) {
      if (!lookup.id) {
        return {
          ok: false,
          message: `已删除精确禁用规则，但仍有通配规则 ${ruleText(verdictAfter.matches)} 覆盖它，且无法确认插件 ID，未写入启用规则。`,
          state: await snapshot(),
        }
      }
      const rule = enableRule(lookup.id)
      rememberRule(rule)
      const state = await editConfig([{ path: [after.key, after.raw.length], value: rule }])
      const reloaded = await reloadAfterEdit()
      const live = await runtime(options.endpoint)
      const info = live.items.find((item) => item.spec === entry.spec)
      return {
        ok: true,
        message: `已恢复 ${entry.name}：删除精确禁用规则后仍被 ${ruleText(verdictAfter.matches)} 挡住，因此在配置末尾追加启用规则 ${rule}。通配规则保持原样。${reloaded}。`,
        state,
        verification: info?.status === "loaded" ? `运行时已报告 ${lookup.id} 加载成功` : "运行时尚未报告加载：等待宿主重新加载",
      }
    }

    const reloaded = removals.length > 0 ? await reloadAfterEdit() : "配置没有禁用规则，未改动"
    const live = await runtime(options.endpoint)
    const info = live.items.find((item) => item.spec === entry.spec)
    const removedText = exact.map((rule) => rule.raw).join("、")
    return {
      ok: true,
      message:
        removals.length > 0
          ? `已恢复 ${entry.name}：删除禁用规则 ${removedText}，插件的版本与配置参数没有改动。${reloaded}。`
          : `已恢复 ${entry.name}：没有需要删除的禁用规则。${reloaded}。`,
      state: await snapshot(),
      verification: info?.status === "loaded" ? `运行时已报告 ${lookup.id || entry.name} 加载成功` : "运行时尚未报告加载：等待宿主重新加载",
    }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

// ---------------------------------------------------------------------------
// Search / detail / open actions
// ---------------------------------------------------------------------------

interface RegistrySearchPackage {
  name?: string
  version?: string
  description?: string
  date?: string
  keywords?: string[]
  publisher?: { username?: string }
  maintainers?: { username?: string }[]
  license?: string | { type?: string }
  links?: { npm?: string; homepage?: string; repository?: string; bugs?: string }
}

interface RegistrySearchItem {
  package?: RegistrySearchPackage
}

interface RegistrySearch {
  objects?: RegistrySearchItem[]
}

/** What one search hit needs beyond the search index: official downloads and the manifest behind `links`. */
interface SearchExtra {
  counts: Downloads
  manifest: VersionLookup | undefined
}

/** Tags every plugin carries; they say nothing about what a particular one does. */
const GENERIC_KEYWORDS = new Set(["opencode", "opencode-plugin", "opencode-plugins", "plugin", "plugins", "ai"])

function keywordList(input: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input ?? []) {
    const value = item.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (GENERIC_KEYWORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= 8) break
  }
  return out
}

function cleanUrl(value: string | undefined): string {
  const url = (value ?? "").trim()
  if (!url) return ""
  if (url.startsWith("//")) return `https:${url}`
  return /^https?:\/\//i.test(url) ? url : ""
}

interface RepositoryValue {
  url: string
  directory: string
}

/** Normalizes the many shapes a `repository` field takes into one browsable HTTPS URL. */
function repository(field: string | { url?: string; directory?: string } | undefined): RepositoryValue {
  const raw = typeof field === "string" ? field : field?.url ?? ""
  const directory = typeof field === "object" && field ? field.directory ?? "" : ""
  const url = raw
    .trim()
    .replace(/^git\+/i, "")
    .replace(/^github:/i, "https://github.com/")
    .replace(/^git:\/\//i, "https://")
    .replace(/^ssh:\/\/git@/i, "https://")
    .replace(/^git@([^:]+):/i, "https://$1/")
    .replace(/#.*$/, "")
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
  return /^https?:\/\//i.test(url) ? { url, directory } : { url: "", directory: "" }
}

function licenseText(field: string | { type?: string } | undefined): string {
  if (typeof field === "string") return field
  return field?.type ?? ""
}

function bugsUrl(field: string | { url?: string } | undefined): string {
  const raw = typeof field === "string" ? field : field?.url ?? ""
  return cleanUrl(raw)
}

interface RegistryManifest {
  name?: string
  version?: string
  description?: string
  homepage?: string
  repository?: string | { url?: string; directory?: string }
  license?: string | { type?: string }
  keywords?: string[]
  dependencies?: Record<string, string>
  deprecated?: string
  bugs?: string | { url?: string }
  dist?: { unpackedSize?: number; fileCount?: number }
}

interface NpmPackument extends RegistryManifest {
  readme?: string
  maintainers?: { name?: string; username?: string }[]
  time?: Record<string, string>
  "dist-tags"?: Record<string, string>
  versions?: Record<string, RegistryManifest>
}

/**
 * Metadata and README only. Download counts are deliberately excluded: this is cached for ten
 * minutes while statistics are cached for five, so caching the counts here would let the detail
 * dialog show a stale number long after the list moved on.
 */
type RemoteDetail = Omit<
  PackageDetailValue,
  "npm" | "installed" | "current" | "hasUpdate" | "error" | "weekly" | "monthly"
>

const DETAIL_TTL = 10 * 60 * 1000
const README_LIMIT = 30_000

const detailCache = new Map<string, { at: number; value: RemoteDetail }>()

function trimReadme(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= README_LIMIT) return { text: raw, truncated: false }
  const head = raw.slice(0, README_LIMIT)
  const cut = head.lastIndexOf("\n")
  const text = cut > README_LIMIT * 0.75 ? head.slice(0, cut) : head
  return { text: `${text}\n\n…`, truncated: true }
}

/**
 * The full packument carries the README, which is the only place many plugins explain what they do.
 * Huge packages (types bundles and the like) are read through their small `/latest` manifest instead.
 */
async function loadPackument(name: string): Promise<{ body?: NpmPackument; error: string }> {
  try {
    const response = await registryFetch(`/${encodeURIComponent(name)}`, { timeoutMs: 20_000 })
    if (response.status === 404) return { error: "npm 上找不到这个包" }
    if (!response.ok) return { error: `npm registry 返回 ${response.status}` }
    // `content-length` describes the compressed body, so a huge packument can still advertise a
    // small number. Measure what actually arrived instead of trusting the header.
    const text = await response.text()
    if (text.length > 12 * 1024 * 1024) return loadLatestManifest(name, "包元数据过大，只读取了最新版本")
    let body: NpmPackument
    try {
      body = JSON.parse(text) as NpmPackument
    } catch {
      return loadLatestManifest(name, "npm 返回的数据无法解析")
    }
    if (!body || typeof body !== "object") return { error: "npm 返回的数据不完整" }
    // Unpublished placeholders have no `versions` at all; buildRemoteDetail turns that into a clear message.
    return { body, error: "" }
  } catch (error) {
    return { error: describeNetwork(error) }
  }
}

async function loadLatestManifest(name: string, reason: string): Promise<{ body?: NpmPackument; error: string }> {
  try {
    const response = await registryFetch(`/${encodeURIComponent(name)}/latest`, { timeoutMs: 10_000 })
    if (!response.ok) return { error: reason || `npm registry 返回 ${response.status}` }
    const manifest = (await response.json()) as RegistryManifest & { readme?: string; time?: Record<string, string> }
    if (!manifest?.version) return { error: reason || "npm 返回的数据不完整" }
    return {
      body: {
        ...manifest,
        readme: typeof manifest.readme === "string" ? manifest.readme : "",
        "dist-tags": { latest: manifest.version },
        versions: { [manifest.version]: manifest },
        time: manifest.time,
      },
      error: "",
    }
  } catch (error) {
    return { error: reason || describeNetwork(error) }
  }
}

async function buildRemoteDetail(name: string): Promise<RemoteDetail | { error: string }> {
  const loaded = await loadPackument(name)
  if (!loaded.body) return { error: loaded.error }
  const doc = loaded.body
  const versions = doc.versions ?? {}
  const keys = Object.keys(versions)
  if (keys.length === 0) return { error: "npm 上只有占位条目，还没有发布过版本" }
  const tagged = doc["dist-tags"]?.latest ?? ""
  const version = tagged && versions[tagged] ? tagged : keys[keys.length - 1] ?? doc.version ?? ""
  const manifest = version ? versions[version] ?? {} : (doc as RegistryManifest)
  const repo = repository(manifest.repository ?? doc.repository)
  const readme = trimReadme(typeof doc.readme === "string" ? doc.readme : "")
  const maintainers = (doc.maintainers ?? [])
    .map((person) => person.name ?? person.username ?? "")
    .filter((value) => value !== "")
  const dependencies = Object.entries(manifest.dependencies ?? {}).map(([dep, range]) =>
    range ? `${dep}@${range}` : dep,
  )
  return {
    name,
    version,
    description: manifest.description ?? doc.description ?? "",
    homepage: cleanUrl(manifest.homepage ?? doc.homepage) || repo.url,
    repo: repo.url,
    repoDir: repo.directory,
    bugs: bugsUrl(manifest.bugs ?? doc.bugs),
    license: licenseText(manifest.license ?? doc.license),
    keywords: keywordList(manifest.keywords ?? doc.keywords),
    maintainers,
    published: doc.time?.[version] ?? "",
    created: doc.time?.created ?? "",
    versions: Object.keys(versions).length,
    unpacked: manifest.dist?.unpackedSize ?? 0,
    files: manifest.dist?.fileCount ?? 0,
    dependencies,
    deprecated: typeof manifest.deprecated === "string" ? manifest.deprecated : "",
    readme: readme.text,
    readmeTruncated: readme.truncated,
  }
}

async function loadRemoteDetail(name: string): Promise<RemoteDetail | { error: string }> {
  const cached = detailCache.get(name)
  if (cached && Date.now() - cached.at < DETAIL_TTL) return cached.value
  const value = await buildRemoteDetail(name)
  if (!("error" in value)) detailCache.set(name, { at: Date.now(), value })
  return value
}

/** npm metadata, README and the installed state merged into one payload for the detail dialog. */
export async function detail(name: string): Promise<PackageDetailValue> {
  const base = (): PackageDetailValue => ({
    name,
    version: "",
    description: "",
    homepage: "",
    repo: "",
    repoDir: "",
    npm: `https://www.npmjs.com/package/${name}`,
    bugs: "",
    license: "",
    keywords: [],
    maintainers: [],
    // A failed detail still carries unknown counts, never a fabricated zero.
    weekly: -1,
    monthly: -1,
    published: "",
    created: "",
    versions: 0,
    unpacked: 0,
    files: 0,
    dependencies: [],
    deprecated: "",
    readme: "",
    readmeTruncated: false,
    installed: false,
    current: "",
    hasUpdate: false,
    error: "",
  })
  if (!isPackageName(name)) return { ...base(), error: "不是 npm 包名，无法查询详情" }

  let installed = false
  let current = ""
  try {
    const file = await readConfig()
    const resolved = await resolveAll(file)
    const entry = resolved.find((item) => item.name === name)
    installed = entry !== undefined
    current = entry?.version ?? ""
  } catch {
    // The detail still loads when the config cannot be read; only the installed badge is missing.
  }

  // Counts are attached on every return, never read back from the ten-minute metadata cache.
  // downloadsFor() is the same cache the search list uses, so both views always agree.
  const [remote, counts] = await Promise.all([loadRemoteDetail(name), downloadsFor(name)])
  const downloads = { weekly: counts.weekly ?? -1, monthly: counts.monthly ?? -1 }
  if ("error" in remote) {
    return { ...base(), ...downloads, installed, current, error: remote.error }
  }
  return {
    ...remote,
    ...downloads,
    npm: base().npm,
    installed,
    current,
    // Only a registry comparison here: the *installable* update decision belongs to the official check.
    hasUpdate: installed && isNewer(remote.version, current),
    error: "",
  }
}

/** Keywords that mark a package as an OpenCode plugin rather than something that merely mentions it. */
const OPENCODE_KEYWORDS = new Set(["opencode", "opencode-plugin", "opencode-plugins", "opencode-ai"])

/**
 * Plugins for other agent harnesses sometimes name-drop OpenCode in their description (a
 * compatibility note, a shared notification format). Their own scope is the reliable signal.
 */
const OTHER_HARNESS = /^(dsh|deepseek-harness|deepseek)$/i

/**
 * Mirrors index plain text and ignore the `keywords:` qualifier (it returns zero hits), so the
 * registry is asked for free text and the results are filtered here instead. A package counts as
 * an OpenCode plugin when its name, one of its keywords, or its description says so — the
 * description is what catches plugins published under an unrelated name. Naming another harness
 * disqualifies it, because those descriptions only mention OpenCode in passing.
 */
function isOpencodePlugin(pkg: { name?: string; keywords?: string[]; description?: string }): boolean {
  const name = pkg.name ?? ""
  const keywords = pkg.keywords ?? []
  // Another harness wins over everything else: `dsh-opencode-palette` is a DeepSeek Harness
  // theme whose name happens to mention OpenCode, and it would not load here.
  if (keywords.some((keyword) => OTHER_HARNESS.test(keyword))) return false
  if (/^dsh-/i.test(name)) return false
  if (/opencode/i.test(name)) return true
  if (keywords.some((keyword) => OPENCODE_KEYWORDS.has(keyword.toLowerCase()))) return true
  return /\bopencode\b/i.test(pkg.description ?? "")
}

/** Enough parallel lookups to fill a page quickly without hammering the mirror. */
const LOOKUP_CONCURRENCY = 16

async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        out[index] = await work(items[index]!)
      }
    }),
  )
  return out
}

/** The page shows at most this many hits; extra candidates only widen the pool before filtering. */
const SEARCH_LIMIT = 50

export async function search(query: string): Promise<SearchResultValue> {
  const trimmed = query.trim()
  // A bare keyword query is how the mirror finds the whole plugin family; the term is also
  // appended to a user query so "memory" does not return unrelated memory libraries.
  const text = trimmed ? `${trimmed} ${NPM_KEYWORD}` : NPM_KEYWORD
  try {
    // Ask for more than a page: filtering drops non-plugin packages, and a narrow query returns
    // fewer than the requested size anyway, so this costs nothing extra.
    const response = await registryFetch(`/-/v1/search?size=100&text=${encodeURIComponent(text)}`, {
      timeoutMs: 12_000,
    })
    if (!response.ok) return { hits: [], error: `npm registry 返回 ${response.status}` }
    const body = (await response.json()) as RegistrySearch
    const file = await readConfig()
    const resolved = await resolveAll(file)
    const installed = new Map(resolved.map((entry) => [entry.name, entry.version]))
    const packages = (body.objects ?? [])
      .filter((item) => item.package?.name && isOpencodePlugin(item.package))
      .slice(0, SEARCH_LIMIT)
    // The mirror's search index omits `links` and reports its own traffic as `downloads`, so
    // it is never a source of counts. One official lookup per package fills them in, alongside
    // the `/latest` manifest for homepage/repo. Unknown stays -1 so the card says 暂不可用.
    const extra = await mapLimited<RegistrySearchItem, SearchExtra>(packages, LOOKUP_CONCURRENCY, async (item) => {
      const name = item.package!.name!
      const [counts, manifest] = await Promise.all([
        downloadsFor(name),
        item.package!.links?.homepage || item.package!.links?.repository ? undefined : npmLatest(name),
      ])
      return { counts, manifest }
    })
    const hits: SearchHitValue[] = []
    for (const [index, item] of packages.entries()) {
      const pkg = item.package!
      const name = pkg.name!
      const isInstalled = installed.has(name)
      const current = isInstalled ? installed.get(name) ?? "" : ""
      const looked = extra[index]
      const manifest = looked?.manifest
      const repo = repository(pkg.links?.repository ?? manifest?.repo)
      hits.push({
        name,
        version: pkg.version ?? "",
        description: pkg.description ?? manifest?.description ?? "",
        published: pkg.date ?? "",
        updated: pkg.date ?? "",
        installed: isInstalled,
        current,
        // A hint from the registry, not an install decision: the button used here pins the version.
        hasUpdate: isInstalled && isNewer(pkg.version ?? "", current),
        weekly: looked?.counts.weekly ?? -1,
        monthly: looked?.counts.monthly ?? -1,
        // Prefer a human maintainer: CI-published packages list "GitHub Actions" as the publisher.
        publisher: pkg.maintainers?.[0]?.username ?? pkg.publisher?.username ?? manifest?.publisher ?? "",
        license: licenseText(pkg.license) || manifest?.license || "",
        keywords: keywordList(pkg.keywords),
        homepage: cleanUrl(pkg.links?.homepage) || manifest?.homepage || "",
        repo: repo.url,
        npm: pkg.links?.npm || `https://www.npmjs.com/package/${name}`,
      })
    }
    return { hits, error: "" }
  } catch (error) {
    return { hits: [], error: describeNetwork(error) }
  }
}

function opener(): string {
  if (process.platform === "darwin") return "open"
  if (process.platform === "win32") return "explorer"
  return "xdg-open"
}

/** Opens a link in the user's browser; the window itself cannot navigate. */
export function openUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const child = spawn(opener(), [url], { detached: true, stdio: "ignore" })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Opens opencode.json in the user's default editor. */
export async function openConfig(): Promise<boolean> {
  try {
    const file = await readConfig()
    const child = spawn(opener(), [file.path], { detached: true, stdio: "ignore" })
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Runs `opencode reload` and waits for it: the hub reports what the command actually did,
 * never "success" just because a child process object exists. Reloading config is all this
 * does — provider snapshots and unmonitored local dependencies still need the host's own
 * restart, which is OpenCode's call, not the hub's.
 */
export async function reload(): Promise<MutationValue> {
  if (!hasCli()) return { ok: false, message: "找不到 opencode CLI", state: await snapshot() }
  const result: CliResult = await runCli(["reload"], { timeoutMs: 60_000 })
  const state = await snapshot()
  if (!result.ok) {
    const reason = result.started ? `opencode reload 退出码 ${result.code}` : "无法启动 opencode CLI"
    const detail = result.message
    return {
      ok: false,
      message: detail ? `配置重载失败：${reason} — ${detail}` : `配置重载失败：${reason}`,
      state,
    }
  }
  return {
    ok: true,
    message:
      "已执行 opencode reload：受监控的配置项会随之重新加载；未被监听的本地依赖变化，可能仍需重启 OpenCode 服务",
    state,
  }
}

/** The CLI argv the hub is using, so the UI can show which binary it drives. */
export function cliInfo(): { available: boolean; command: string } {
  const command = cliCommand()
  return { available: command.length > 0, command: command.join(" ") }
}

/** Exposed for the UI: the same classifier the mutations use, so a test can assert on it. */
export { classify as classifyCliResult }

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Makes socket-level failures actionable: `fetch failed` alone says nothing about what to do. */
function describeNetwork(error: unknown): string {
  const message = describe(error)
  if (/RegistryTimeout|TimeoutError|aborted due to timeout|The operation was aborted/i.test(message)) {
    return "npm registry 没有及时响应：这个包可能不存在，或镜像正在回源。稍后重试。"
  }
  if (/RegistryUnavailable/.test(message)) return message
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/i.test(message)) {
    // Mirrors answer an uncached 404 by resetting the socket once their upstream fetch gives up,
    // so a reset means either "no such package" or "no route to the registry".
    return "npm registry 未能应答（连接被重置）：这个包可能不存在，或当前网络无法访问 registry。可设置 OPENCODE_PLUGIN_HUB_REGISTRY 指向可用镜像。"
  }
  return message
}
