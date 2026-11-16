import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { downloadsFor, registryFetch, type Downloads } from "./registry"
import {
  classify,
  cliCommand,
  configureCli,
  hasCli,
  pluginAdd,
  pluginAddIsolated,
  pluginCheck,
  pluginList,
  pluginReload,
  pluginRemove,
  pluginUpdate,
  runCli,
  type CliOutcome,
  type CliResult,
} from "./cli"
import {
  configDir,
  describe,
  editConfig,
  entryBySpec,
  readConfig,
  type ConfigEntry,
  type ConfigFile,
  type Edit,
} from "./config"
import { isPathSource, packageNameOf, parsePluginCheck, parsePluginList, type CheckRow, type PluginListRow } from "./official-parse"
import { disableRule, enableRule, evaluateRules, exactRulesFor, isControlSpec, parseControl } from "./rules"
import { forgetRule, lookupId, readStore, rememberId, rememberRule } from "./store"

export { isControlSpec } from "./rules"
export { configDir } from "./config"

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
  /** True for the plugin-center row: its update target comes from the registry, not `plugin check`. */
  selfUpdate?: boolean
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
  /** 每个阶段各自的结论，前端据此判断"命令成功但还没加载"这类情况。 */
  stages?: MutationStages
}

const SELF_PACKAGE = "opencode-plugin-hub"
const NPM_KEYWORD = "opencode-plugin"
/** A registry lookup is reused for this long, so opening the page twice is not two requests. */
const VERSION_TTL = 5 * 60 * 1000

/** The host's own CLI, handed over once at startup; every package operation goes through it. */
export function useCli(argv: readonly string[] | undefined): void {
  configureCli(argv)
}

function cacheDir() {
  const xdg = process.env.XDG_CACHE_HOME
  return xdg ? join(xdg, "opencode", "npm") : join(homedir(), ".cache", "opencode", "npm")
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
  /** Entry declarations, used to check that the prepared package can actually be loaded. */
  main?: string
  module?: string
  exports?: unknown
  type?: string
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
 *
 * The same lookup doubles as the "did the package actually materialise?" check after an install:
 * `plugin add` exiting 0 is not proof that the tarball landed, but a readable manifest is.
 */
async function locatePackage(name: string, range: string): Promise<{ dir: string; manifest: Manifest } | undefined> {
  const wanted = range && range !== "latest" ? range : "latest"
  const roots = Array.from(new Set([`${name}@${wanted}`, `${name}@latest`]))
  for (const root of roots) {
    const rootDir = join(cacheDir(), root)
    let stamps: string[]
    try {
      stamps = await readdir(rootDir)
    } catch {
      continue
    }
    // Newest unpack first: a reinstalled version leaves the previous stamp behind.
    for (const stamp of stamps.reverse()) {
      const dir = join(rootDir, stamp, "node_modules", name)
      try {
        const raw = await readFile(join(dir, "package.json"), "utf8")
        const json = JSON.parse(raw) as Manifest
        if (typeof json === "object" && json !== null && json.version) return { dir, manifest: json }
      } catch {
        // try the next cached install
      }
    }
  }
  return undefined
}

async function readInstalledManifest(name: string, range: string): Promise<Manifest | undefined> {
  return (await locatePackage(name, range))?.manifest
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

/**
 * A stable, comparable version: `x.y.z` (optionally with a 4th numeric segment), no prerelease
 * (`-beta.1`) and no build metadata (`+sha`). The registry's `dist-tag latest` normally points at
 * a stable release, but a publisher can move it to a prerelease; treating that as the supported
 * upgrade target would push users onto an unstable build. Callers use this to decide whether a
 * registry version is a valid *stable* update target.
 */
function stableVersion(raw: string): string {
  const version = literalVersion(raw)
  if (!version) return ""
  return /^\d+(\.\d+){1,3}$/.test(version) ? version : ""
}

/** True when the candidate is a usable stable upgrade over the current version. */
function isStableUpgrade(candidate: string, current: string): boolean {
  const stable = stableVersion(candidate)
  return stable !== "" && isNewer(stable, current)
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
    // A file that does not parse is reported as an error, never as "no plugins installed":
    // the UI has to be able to tell "empty" from "broken", and so does the user.
    if (file.parseError) {
      return { configPath: file.path, configKey: file.key, plugins: [], error: file.parseError }
    }
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
  /**
   * Which kind of rule decided it: `exact` is a `-<id>` line naming this plugin, `wildcard` is a
   * `-*` / `-prefix.*` rule that happens to cover it. The UI has to say which, because removing a
   * wildcard is a different (and much bigger) promise than removing one exact line.
   */
  pausedBy: "exact" | "wildcard" | ""
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
  if (file.parseError) {
    return { items: [], discovered: [], error: `配置文件无法解析：${file.parseError}` }
  }
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
      items.push({
        ...base,
        id: "",
        status: "control",
        runtimeVersion: "",
        error: "",
        available: true,
        paused: false,
        rule: entry.spec,
        pausedBy: "",
        rules: [],
      })
      continue
    }
    const key = rowKeyFor(entry)
    const row = byKey.get(key)
    claimed.add(key)
    const id = row?.id ?? ""
    if (id) rememberId(key, id)

    // Rules are evaluated against the real ID when it is known, and against the configured name
    // otherwise — and against every candidate, because a plugin can be disabled by a rule written
    // with its ID while a `*` rule covers the name. Whichever decides it is reported.
    const state = ruleState(file.raw, entry, id)
    const paused = state.verdict.disabled
    // Only syntax-level control rules are listed as rules: a package entry that names the plugin
    // is the plugin itself, not a rule the user wrote about it.
    const rules = state.verdict.matches.filter((rule) => isControlSpec(rule.raw)).map((rule) => rule.raw)
    const pausedBy: RuntimeInfoValue["pausedBy"] = !paused
      ? ""
      : state.verdict.rule?.scope === "exact"
        ? "exact"
        : "wildcard"

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
      rule: paused ? state.verdict.rule?.raw ?? "" : "",
      pausedBy,
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
    if (file.parseError) {
      // A broken file is an error to report, not an empty plugin list to check.
      return { items: [], error: `配置文件无法解析：${file.parseError}`, checked: false }
    }
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
      // Registry metadata is display-only for other plugins: it never decides that an update
      // exists. The hub itself is the exception — its update decision comes from the registry,
      // so force a fresh lookup rather than serving a cached "latest" for its own release.
      const lookup = isPackageName(entry.name)
        ? await npmLatest(entry.name, entry.name === SELF_PACKAGE)
        : emptyLookup(false)
      const shared = {
        ...base,
        id,
        publisher: lookup.publisher,
        description: base.description || lookup.description,
        license: base.license || lookup.license,
        homepage: base.homepage || lookup.homepage,
        repo: base.repo || lookup.repo,
      }
      // Plugin center itself is special: `opencode plugin check` deliberately skips exact
      // versions, so a pinned hub would never see its own new release. Its update decision comes
      // from the npm registry instead — the same source the safe self-upgrade reads. Other
      // plugins keep the official-check semantics below, untouched.
      if (entry.name === SELF_PACKAGE) {
        const current = base.current || official?.version || ""
        const registryVersion = stableVersion(lookup.version)
        if (!lookup.ok) {
          return {
            ...shared,
            selfUpdate: true,
            official: "failed",
            current,
            reason: "无法连接 npm registry，未能确认插件中心是否有新版本（不把「查不到」当作「已是最新」）",
            error: "registry lookup failed",
          }
        }
        if (!registryVersion) {
          return {
            ...shared,
            selfUpdate: true,
            official: "failed",
            current,
            reason: `npm registry 返回的插件中心版本「${lookup.version}」不是有效稳定版本，不允许升级`,
            error: "invalid registry version",
          }
        }
        if (isStableUpgrade(registryVersion, current)) {
          return {
            ...shared,
            selfUpdate: true,
            official: "outdated",
            latest: registryVersion,
            current,
            // Registry decides, so an exact pin does not hide the hub's own update.
            hasUpdate: true,
            reason: base.pinned
              ? "插件中心以精确版本运行；升级会进入安全自升级流程，把这个精确版本切换到上面的目标版本"
              : "",
          }
        }
        return { ...shared, selfUpdate: true, official: "current", current }
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
// Config edits: everything goes through config.ts's queued, planned writer
// ---------------------------------------------------------------------------

/**
 * Applies one plan and reports it as a `HubStateValue` for the UI.
 *
 * The plan is evaluated inside the queue against the freshest file (see config.ts), so an
 * external edit between the caller's read and this write cannot make us touch the wrong entry.
 */
async function commit(
  plan: (file: ConfigFile) => Edit[] | { refuse: string },
): Promise<{ ok: boolean; error: string; state: HubStateValue }> {
  const outcome = await editConfig(plan)
  return { ok: outcome.ok, error: outcome.error, state: await snapshot() }
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
  const entry = entryBySpec(file, spec)
  return entry ? resolveEntry(entry) : undefined
}

// ---------------------------------------------------------------------------
// Mutations: one stage at a time, each stage reported separately
// ---------------------------------------------------------------------------

/**
 * Every mutation reports four independent answers instead of one `ok`:
 *
 * | 阶段 | 取值 | 含义 |
 * |---|---|---|
 * | `command` | succeeded / failed / skipped | 官方 CLI 那条命令本身 |
 * | `config`  | updated / unchanged / failed   | 配置有没有被改成预期样子 |
 * | `runtime` | loaded / failed / unknown / unchanged / skipped | 宿主是否确认加载 |
 * | `rollback`| none / succeeded / failed      | 失败后有没有回到旧状态 |
 *
 * 「命令成功」和「插件已经在跑」是两件事，压缩成一个布尔值会让界面只能猜。
 */
export type CommandStage = "succeeded" | "failed" | "skipped"
export type ConfigStage = "updated" | "unchanged" | "failed"
export type RuntimeStage = "loaded" | "failed" | "unknown" | "unchanged" | "skipped"
export type RollbackStage = "none" | "succeeded" | "failed"

export interface MutationStages {
  command: CommandStage
  config: ConfigStage
  runtime: RuntimeStage
  rollback?: RollbackStage
  /** The version the config ended up naming, empty when it does not name one. */
  version?: string
}

function outputDetail(outcome: CliOutcome): string {
  const text = outcome.result.message
  return text ? `（CLI：${text}）` : ""
}

type Endpoint = { url: string; headers: Readonly<Record<string, string>> } | undefined

interface Verification {
  state: HubStateValue
  note: string
  /** Runtime rows, so a caller can check one plugin instead of re-asking. */
  live: RuntimeResultValue
}

/** Re-reads config and runtime after a command, and says what each of them now reports. */
async function verify(endpoint?: Endpoint): Promise<Verification> {
  const state = await snapshot()
  const live = await runtime(endpoint)
  const loaded = live.items.filter((item) => item.status === "loaded").length
  const paused = live.items.filter((item) => item.paused).length
  const failed = live.items.filter((item) => item.status === "failed").length
  const parts = [`配置 ${state.plugins.length} 项`, `运行时已加载 ${loaded} 个`]
  if (paused > 0) parts.push(`已暂停 ${paused} 个`)
  if (failed > 0) parts.push(`加载失败 ${failed} 个`)
  if (live.error) parts.push(live.error)
  return { state, note: parts.join(" · "), live }
}

/** The runtime row for one config entry, if the host reports it. */
function runtimeRow(verified: Verification, spec: string): RuntimeInfoValue | undefined {
  return verified.live.items.find((item) => item.spec === spec)
}

export interface MutationOptions {
  endpoint?: Endpoint
}

// ---------------------------------------------------------------------------
// One lifecycle operation per plugin at a time
// ---------------------------------------------------------------------------

/**
 * Lifecycle operations for the same plugin must not interleave: two clicks on 暂停 would append
 * two identical rules, and a 更新 racing a 移除 could re-add what the user just removed.
 *
 * The queue in config.ts already serialises the *writes*; this serialises the whole operation,
 * which also spans CLI calls and runtime polling.
 */
const inflight = new Set<string>()

class BusyError extends Error {
  constructor(readonly key: string) {
    super(`${key} 上还有一个操作没有结束`)
  }
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (inflight.has(key)) throw new BusyError(key)
  inflight.add(key)
  try {
    return await task()
  } finally {
    inflight.delete(key)
  }
}

function busyResult(state: HubStateValue, key: string): MutationValue {
  return {
    ok: false,
    message: `${key} 上还有一个操作没有结束，本次请求已忽略（等它结束后再点一次）`,
    state,
    stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
  }
}

// ---------------------------------------------------------------------------
// Prepare a package without touching the real configuration
// ---------------------------------------------------------------------------

/**
 * What `plugin add` did in the throwaway config directory.
 *
 * Verified against opencode 2.0.27: the tarball is unpacked into the shared cache while the
 * `plugins` entry lands in whatever `XDG_CONFIG_HOME` points at. Running the command that way
 * therefore answers "can this version be installed and does its entry file exist?" without
 * being able to break the user's current configuration — which is the whole point of the
 * prepare step.
 */
interface Prepared {
  ok: boolean
  /** The spec that is now materialised in the shared cache, e.g. `pkg@1.2.0`. */
  target: string
  version: string
  command: CommandStage
  /** Why it failed, or extra detail worth telling the user. */
  message: string
}

function entryFiles(manifest: Manifest): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) out.push(value.trim())
  }
  push(manifest.main)
  push(manifest.module)
  const exported = manifest.exports
  if (typeof exported === "string") push(exported)
  else if (exported && typeof exported === "object") {
    const record = exported as Record<string, unknown>
    const entry = record["."] ?? record
    if (typeof entry === "string") push(entry)
    else if (entry && typeof entry === "object") {
      const conditions = entry as Record<string, unknown>
      for (const key of ["import", "node", "require", "default", "browser"]) push(conditions[key])
    }
  }
  return Array.from(new Set(out))
}

/**
 * Does the prepared package point at a file that actually exists?
 *
 * `plugin add` does **not** validate this (verified: adding `left-pad` succeeds and writes the
 * config), so a missing entry file is only ever found at load time — too late for a self-update.
 * `undeclared` is not treated as a failure: plenty of plugins resolve through `exports` shapes
 * this check does not model, and refusing those would be worse than letting the runtime decide.
 */
async function checkEntrypoint(
  dir: string,
  manifest: Manifest,
): Promise<{ status: "ok" | "missing" | "undeclared"; file: string }> {
  const candidates = entryFiles(manifest)
  if (candidates.length === 0) return { status: "undeclared", file: "" }
  for (const candidate of candidates) {
    const base = join(dir, candidate)
    for (const attempt of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js")]) {
      try {
        await access(attempt)
        return { status: "ok", file: attempt }
      } catch {
        // keep trying the declared shapes
      }
    }
  }
  return { status: "missing", file: candidates[0] ?? "" }
}

/** Environment a throwaway install runs in: its own config dir, its own cwd, shared package cache. */
async function scratchEnv(): Promise<{ root: string; configHome: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "opencode-plugin-hub-prepare-"))
  const configHome = join(root, "config")
  const cwd = join(root, "work")
  await mkdir(join(configHome, "opencode"), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(join(configHome, "opencode", "opencode.json"), '{"plugins":[]}\n', { encoding: "utf8", mode: 0o600 })
  return { root, configHome, cwd }
}

async function scratchListed(configHome: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(configHome, "opencode", "opencode.json"), "utf8")) as {
      plugins?: unknown
    }
    return Array.isArray(raw.plugins) ? raw.plugins.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

/**
 * Installs one package@version into the shared cache, with the config write going to a temp dir.
 *
 * The seven things checked before the real config is allowed to change:
 * 1. a CLI exists; 2. the command exited 0 without a failure signature; 3. it did not time out;
 * 4. the throwaway config really lists the target; 5. the package is readable in the shared cache;
 * 6. its manifest version is the one we asked for; 7. its declared entry file exists.
 */
async function preparePackage(name: string, version: string): Promise<Prepared> {
  const target = version.trim() ? `${name}@${version.trim()}` : name
  if (!hasCli()) {
    return { ok: false, target, version, command: "failed", message: "找不到 opencode CLI，无法准备包" }
  }
  let scratch: { root: string; configHome: string; cwd: string } | undefined
  try {
    scratch = await scratchEnv()
    const outcome = await pluginAddIsolated(target, scratch.configHome, scratch.cwd)
    if (outcome.result.timedOut) {
      return {
        ok: false,
        target,
        version,
        command: "failed",
        message: `准备 ${target} 超时后被终止，配置没有任何改动`,
      }
    }
    if (!outcome.result.ok) {
      return {
        ok: false,
        target,
        version,
        command: "failed",
        message: `准备 ${target} 失败${outputDetail(outcome)}`,
      }
    }
    const listed = await scratchListed(scratch.configHome)
    const wroteConfig = listed.some((item) => item === target || item === name)
    if (!wroteConfig) {
      return {
        ok: false,
        target,
        version,
        command: "failed",
        message: `命令报告成功，但临时配置里没有出现 ${target}，不认为包已准备好`,
      }
    }
    const located = await locatePackage(name, version.trim())
    if (!located) {
      return {
        ok: false,
        target,
        version,
        command: "succeeded",
        message: `命令报告成功，但缓存里找不到 ${target} 的包文件，不认为安装完成`,
      }
    }
    const wanted = literalVersion(version.trim())
    if (wanted && located.manifest.version !== wanted) {
      return {
        ok: false,
        target,
        version,
        command: "succeeded",
        message: `缓存里的版本是 ${located.manifest.version ?? "未知"}，不是要安装的 ${wanted}`,
      }
    }
    const entry = await checkEntrypoint(located.dir, located.manifest)
    if (entry.status === "missing") {
      return {
        ok: false,
        target,
        version,
        command: "succeeded",
        message: `包已下载，但 package.json 声明的入口 ${entry.file} 不存在，切换后很可能加载失败`,
      }
    }
    return {
      ok: true,
      target,
      version: located.manifest.version ?? wanted,
      command: "succeeded",
      message: entry.status === "undeclared" ? "包已就绪（package.json 没有声明入口，加载由宿主决定）" : "包已就绪",
    }
  } finally {
    if (scratch) await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Config switch helpers
// ---------------------------------------------------------------------------

/**
 * Switches one configured entry to a new spec, keeping everything about the entry that is not
 * the spec (`options`, unknown fields) intact, and refusing when the entry moved or vanished.
 *
 * The plan runs against a freshly read file, so the index it edits is always the current one.
 */
async function switchEntry(
  spec: string,
  target: string,
): Promise<{ ok: boolean; error: string; state: HubStateValue }> {
  return commit((file) => {
    const entry = entryBySpec(file, spec)
    if (!entry) {
      return {
        refuse: `配置里的 ${spec} 在操作期间被改动了（可能被其他窗口或编辑器修改），未做任何替换`,
      }
    }
    const value = entry.options
      ? { ...(entry.raw as Record<string, unknown>), package: target }
      : target
    return [{ path: [file.key, entry.index], value }]
  })
}

/** Registers a config switch as a reload request, without claiming the host acted on it. */
async function reloadAfterEdit(): Promise<string> {
  if (!hasCli()) return "未执行重载：找不到 opencode CLI"
  const result = await pluginReload()
  if (result.ok) return "已执行 opencode reload"
  return `opencode reload 未成功（${result.message || `退出码 ${result.code}`}）`
}

// ---------------------------------------------------------------------------
// Install / re-version
// ---------------------------------------------------------------------------

/**
 * Installs a new plugin, or switches an already configured one to a different version.
 *
 * A new plugin: `opencode plugin add` is the whole job — nothing old can be lost.
 *
 * A version switch: **prepare first, switch second.** `plugin add pkg@new` only ever appends
 * (verified), so the old flow of "remove the old entry, then add, then put it back on failure"
 * could lose the entry *and* the entry's `options`. Instead the new version is installed and
 * validated in a throwaway config directory, and only then does the real config change — by one
 * atomic jsonc edit that rewrites the spec and leaves everything else alone.
 */
export async function install(spec: string, version: string, options: MutationOptions = {}): Promise<MutationValue> {
  const parsed = splitSpec(spec)
  if (parsed.kind !== "package" || !isPackageName(parsed.name)) {
    return {
      ok: false,
      message: "只能按 npm 包名安装",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  const name = parsed.name
  try {
    return await withLock(`pkg:${name}`, () => installLocked(name, version, options))
  } catch (error) {
    if (error instanceof BusyError) return busyResult(await snapshot(), name)
    return {
      ok: false,
      message: describe(error),
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
}

async function installLocked(name: string, version: string, options: MutationOptions): Promise<MutationValue> {
  const file = await readConfig()
  if (file.parseError) {
    return {
      ok: false,
      message: `配置文件无法解析（${file.parseError}），为避免覆盖你的配置，没有做任何修改`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (!hasCli()) {
    return {
      ok: false,
      message: "找不到 opencode CLI，无法执行 opencode plugin add",
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
  const target = version.trim() ? `${name}@${version.trim()}` : name
  const existing = await findEntry(file, name)

  if (existing?.kind === "path") {
    return {
      ok: false,
      message: `${existing.spec} 是本地目录插件，由外部维护：插件中心不会下载 npm 包覆盖它。请在配置里改为 npm 包，或自行更新目录内容。`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }

  if (existing && existing.spec.trim() === target) {
    const verified = await verify(options.endpoint)
    const row = runtimeRow(verified, existing.spec)
    return {
      ok: true,
      message: `${name} 已在配置中（${existing.spec}），没有再次安装`,
      state: verified.state,
      verification: verified.note,
      stages: {
        command: "skipped",
        config: "unchanged",
        runtime: row?.status === "loaded" ? "loaded" : row?.status === "failed" ? "failed" : "unknown",
        version: existing.version,
      },
    }
  }

  if (existing) {
    if (name === SELF_PACKAGE) {
      // The hub replacing itself has its own flow: it must survive a bad switch.
      return selfUpdate(existing, version.trim(), options)
    }
    const prepared = await preparePackage(name, version.trim())
    if (!prepared.ok) {
      return {
        ok: false,
        message: `${prepared.message}。旧条目 ${existing.spec} 仍在配置里，可以照常使用。`,
        state: await snapshot(),
        stages: { command: prepared.command, config: "unchanged", runtime: "skipped" },
      }
    }
    const switched = await switchEntry(existing.spec, prepared.target)
    if (!switched.ok) {
      return {
        ok: false,
        message: `${prepared.message}，但切换配置失败：${switched.error}。旧条目 ${existing.spec} 没有被改动。`,
        state: switched.state,
        stages: { command: "succeeded", config: "failed", runtime: "skipped" },
      }
    }
    const reloaded = await reloadAfterEdit()
    const verified = await verify(options.endpoint)
    const row = runtimeRow(verified, prepared.target)
    const runtimeStage: RuntimeStage =
      row?.status === "loaded" ? "loaded" : row?.status === "failed" ? "failed" : "unknown"
    return {
      ok: true,
      message: `已把 ${name} 换到 ${prepared.target}：新版本先在隔离目录里装好并校验，然后一次性改写配置（旧条目 ${existing.spec} 从未被提前删除）。${reloaded}。`,
      state: verified.state,
      verification: verified.note,
      stages: {
        command: "succeeded",
        config: "updated",
        runtime: runtimeStage,
        version: prepared.version,
      },
    }
  }

  const added = await pluginAdd(target)
  if (!added.result.ok) {
    return {
      ok: false,
      message: `安装 ${target} 失败${outputDetail(added)}`,
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
  const verified = await verify(options.endpoint)
  const listed = verified.state.plugins.some((item) => item.spec.trim() === target || item.name === name)
  const row = runtimeRow(verified, target)
  const where = added.path ? `写入 ${added.path}` : "已写入配置"
  const base =
    added.status === "already"
      ? `${target} 已配置，命令没有改动配置`
      : `已通过 opencode plugin add 安装 ${target}，${where}`
  // A first-time install of the hub itself is still a self-update from this window's point of
  // view: the config now names a version, and the build serving this page is whatever was loaded
  // before. Nothing old could have been lost (there was no entry), so the plain path is enough,
  // but the warning must still be shown.
  const self = name === SELF_PACKAGE
  return {
    ok: listed,
    message: listed
      ? self
        ? `${base}。当前窗口仍运行旧构建，OpenCode 重新加载后才会用上新版本。`
        : base
      : `命令报告成功，但配置里没有出现 ${target}`,
    state: verified.state,
    verification: verified.note,
    selfUpdated: self || undefined,
    stages: {
      command: "succeeded",
      config: listed ? "updated" : "failed",
      runtime: row?.status === "loaded" ? "loaded" : row?.status === "failed" ? "failed" : "unknown",
      version: literalVersion(version.trim()),
    },
  }
}

// ---------------------------------------------------------------------------
// Self-update: the hub replacing the package that is serving this window
// ---------------------------------------------------------------------------

/**
 * How long a self-update waits for the host to report the new build before calling it unknown.
 * Read per call so a test (or a user) can shorten it without reloading the plugin.
 */
function selfLoadTimeout(): number {
  const raw = Number(process.env.OPENCODE_PLUGIN_HUB_SELF_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000
}

const SELF_POLL_INTERVAL = 1_500

interface SelfLoad {
  status: RuntimeStage
  /** The version the host says it has loaded, when it says anything. */
  loaded: string
  note: string
}

/** Polls the runtime until it names the target version, reports a failure, or the deadline passes. */
async function waitForSelf(targetVersion: string, spec: string, endpoint?: Endpoint): Promise<SelfLoad> {
  const deadline = Date.now() + selfLoadTimeout()
  let last: SelfLoad = { status: "unknown", loaded: "", note: "宿主还没有报告任何版本" }
  while (Date.now() <= deadline) {
    const live = await runtime(endpoint)
    const row = live.items.find((item) => item.name === SELF_PACKAGE) ?? live.items.find((item) => item.spec === spec)
    if (row?.status === "failed") {
      return { status: "failed", loaded: row.runtimeVersion, note: row.error || "宿主报告插件中心加载失败" }
    }
    if (row?.status === "loaded" && row.runtimeVersion === targetVersion) {
      return { status: "loaded", loaded: row.runtimeVersion, note: `宿主报告已加载 ${targetVersion}` }
    }
    // `runtimeVersion` falls back to the config when the host says nothing, so it is only used as
    // "what the host runs" when the status is actually loaded. Anything else is an honest unknown.
    last = {
      status: "unknown",
      loaded: row?.status === "loaded" ? row.runtimeVersion : "",
      note: live.error
        ? `读取运行状态失败：${live.error}`
        : row?.status === "loaded"
          ? `宿主报告加载的是 ${row.runtimeVersion}，不是 ${targetVersion}`
          : "宿主没有报告插件中心处于加载状态",
    }
    if (Date.now() + SELF_POLL_INTERVAL > deadline) break
    await delay(SELF_POLL_INTERVAL)
  }
  return { status: "unknown", loaded: last.loaded, note: last.note }
}

/**
 * Upgrades the hub itself.
 *
 * The failure mode this is built around: the window that shows the button is the old build, and
 * if the new version does not load, the user loses the *manager* — not just one plugin. So:
 *
 * 1. prepare + validate the target version in a throwaway config (the old one keeps working);
 * 2. switch the config with one atomic edit (a failed write leaves the old entry in place);
 * 3. reload and poll the runtime for the new version;
 * 4. only claim success when the host actually says it loaded the new version;
 * 5. roll back only when the old package is still verifiably on disk.
 *
 * The window never restarts the host and never touches the npm cache: if the host does not
 * pick the new build up on its own, the honest answer is "配置已切换，运行状态未确认".
 */
async function selfUpdate(existing: ResolvedEntry, version: string, options: MutationOptions): Promise<MutationValue> {
  const wanted = literalVersion(version)
  if (!wanted) {
    return {
      ok: false,
      message:
        "插件中心自升级必须给出具体版本号（例如 0.5.1）。不做「装最新」的猜测：目标版本不明确时，切换配置等于拿管理器冒险。",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (existing.version === wanted) {
    const verified = await verify(options.endpoint)
    return {
      ok: true,
      message: `插件中心已经是 ${wanted}，不需要升级`,
      state: verified.state,
      verification: verified.note,
      stages: { command: "skipped", config: "unchanged", runtime: "unknown", version: wanted },
    }
  }

  const target = `${SELF_PACKAGE}@${wanted}`
  const prepared = await preparePackage(SELF_PACKAGE, wanted)
  if (!prepared.ok) {
    return {
      ok: false,
      message: `${prepared.message}。插件中心仍以 ${existing.spec} 运行，配置没有被改动。`,
      state: await snapshot(),
      stages: { command: prepared.command, config: "unchanged", runtime: "skipped" },
    }
  }

  const switched = await switchEntry(existing.spec, prepared.target)
  if (!switched.ok) {
    return {
      ok: false,
      message: `${prepared.message}，但切换配置失败：${switched.error}。插件中心仍是 ${existing.spec}。`,
      state: switched.state,
      stages: { command: "succeeded", config: "failed", runtime: "skipped" },
    }
  }

  const reloaded = await reloadAfterEdit()
  const load = await waitForSelf(wanted, target, options.endpoint)

  if (load.status === "loaded") {
    return {
      ok: true,
      message: `插件中心已升级到 ${wanted}：新版本先在隔离目录校验，再一次性改写配置，宿主已报告加载 ${wanted}。${reloaded}。当前窗口仍是旧构建，重新打开插件中心（或重开窗口）即可用新界面。`,
      state: await snapshot(),
      selfUpdated: true,
      verification: load.note,
      stages: { command: "succeeded", config: "updated", runtime: "loaded", version: wanted },
    }
  }

  if (load.status === "unknown") {
    // Config is on the new version but the host never confirmed it. Not a success, not a rollback:
    // the old build may still be serving this window, and the next reload decides.
    return {
      ok: false,
      message: `插件中心配置已切到 ${wanted}，但宿主没有确认加载（${load.note}）。这不等于升级成功：${reloaded}，宿主重新加载后才会生效；若一直不生效，把配置改回 ${existing.spec} 即可退回。`,
      state: await snapshot(),
      selfUpdated: true,
      verification: load.note,
      stages: { command: "succeeded", config: "updated", runtime: "unknown", rollback: "none", version: wanted },
    }
  }

  // The host says the hub itself failed to load. Try to put the old version back, but only when
  // that old version is still verifiably present — a blind switch to a package that is not on
  // disk would leave the user with no manager at all.
  const oldRange = splitSpec(existing.spec).range
  const oldPkg = await locatePackage(SELF_PACKAGE, oldRange)
  if (!oldPkg) {
    return {
      ok: false,
      message: `插件中心加载失败（${load.note}）。旧版本 ${existing.spec} 的包文件已不在缓存里，自动回滚不安全，因此配置保持为 ${wanted}；请手动把配置改回 ${existing.spec} 并重新安装。`,
      state: await snapshot(),
      selfUpdated: true,
      stages: { command: "succeeded", config: "updated", runtime: "failed", rollback: "failed", version: wanted },
    }
  }

  const back = await switchEntry(prepared.target, existing.spec)
  if (!back.ok) {
    return {
      ok: false,
      message: `插件中心加载失败（${load.note}），回滚也没写成功：${back.error}。配置现在是 ${wanted}，旧包仍在缓存（${oldPkg.manifest.version ?? "版本未知"}）。`,
      state: back.state,
      selfUpdated: true,
      stages: { command: "succeeded", config: "failed", runtime: "failed", rollback: "failed", version: wanted },
    }
  }
  const reloadedBack = await reloadAfterEdit()
  const restored = await waitForSelf(oldPkg.manifest.version ?? "", existing.spec, options.endpoint)
  const rollbackOk = restored.status === "loaded"
  return {
    ok: false,
    message: rollbackOk
      ? `插件中心加载 ${wanted} 失败（${load.note}），已回滚到 ${existing.spec}，宿主确认 ${oldPkg.manifest.version} 已加载。${reloadedBack}。`
      : `插件中心加载 ${wanted} 失败（${load.note}），配置已回滚到 ${existing.spec}，但宿主还没确认旧版本加载（${restored.note}）。${reloadedBack}。`,
    state: await snapshot(),
    selfUpdated: !rollbackOk,
    verification: restored.note,
    stages: {
      command: "succeeded",
      config: "updated",
      runtime: "failed",
      rollback: rollbackOk ? "succeeded" : "failed",
      version: existing.version,
    },
  }
}

// ---------------------------------------------------------------------------
// Update: the official command, for plugins that are not this one
// ---------------------------------------------------------------------------

/**
 * Updates one plugin through `opencode plugin update <target>`.
 *
 * The official command skips local plugins and exact revisions, and says so — that reason is
 * reported instead of being replaced with a made-up "up to date".
 */
export async function update(spec: string, options: MutationOptions = {}): Promise<MutationValue> {
  const parsed = splitSpec(spec)
  const key = parsed.name || spec
  try {
    return await withLock(`pkg:${key}`, () => updateLocked(spec, options))
  } catch (error) {
    if (error instanceof BusyError) return busyResult(await snapshot(), key)
    return {
      ok: false,
      message: describe(error),
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
}

async function updateLocked(spec: string, options: MutationOptions): Promise<MutationValue> {
  const file = await readConfig()
  if (file.parseError) {
    return {
      ok: false,
      message: `配置文件无法解析（${file.parseError}），为避免覆盖你的配置，没有执行更新`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  const entry = await findBySpec(file, spec)
  if (!entry) {
    return {
      ok: false,
      message: "配置中没有这一项",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (entry.kind === "path") {
    return {
      ok: false,
      message: `${entry.spec} 是本地目录插件，官方更新流程会跳过它：目录里可能有你的改动。需要时请自行更新目录内容（插件中心不覆盖本地目录）。`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (entry.kind === "control" || entry.kind === "enable-rule") {
    return {
      ok: false,
      message: "配置规则不是插件包，没有可更新的版本",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (!hasCli()) {
    return {
      ok: false,
      message: "找不到 opencode CLI，无法执行 opencode plugin update",
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }

  if (entry.name === SELF_PACKAGE) {
    // The hub does not let `plugin update` touch its own config: that path rewrites the entry
    // without the prepare/validate/verify steps a self-update needs.
    const target = await latestForSelf(entry)
    if (!target.version) {
      return {
        ok: false,
        message: `无法从 npm registry 确定插件中心的目标版本${target.note ? `（${target.note}）` : ""}。自升级需要明确版本，未做任何改动。`,
        state: await snapshot(),
        stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
      }
    }
    return selfUpdate(entry, target.version, options)
  }

  const before = entry.version
  const outcome = await pluginUpdate(entry.spec)
  const verified = await verify(options.endpoint)
  if (!outcome.result.ok) {
    // The command failed; confirm the config was not left in a worse state.
    const stillThere = verified.state.plugins.some((item) => item.name === entry.name)
    return {
      ok: false,
      message: stillThere
        ? `更新 ${entry.name} 失败${outputDetail(outcome)}；配置里的 ${entry.spec} 仍在`
        : `更新 ${entry.name} 失败${outputDetail(outcome)}，并且配置里的条目已经不见了，请检查 ${verified.state.configPath}`,
      state: verified.state,
      verification: verified.note,
      stages: { command: "failed", config: stillThere ? "unchanged" : "failed", runtime: "unknown" },
    }
  }
  // The command may rewrite the spec (`pkg` -> `pkg@1.2.0`), so match by name, not by spec.
  const after = verified.state.plugins.find((item) => item.name === entry.name)
  const moved = after && after.version && after.version !== before
  if (outcome.status === "no-updates") {
    return {
      ok: true,
      message: `官方命令报告没有可更新的插件：本地插件与精确锁定版本会被跳过，${entry.name} 未发生变化`,
      state: verified.state,
      verification: verified.note,
      stages: {
        command: "succeeded",
        config: "unchanged",
        runtime: runtimeRow(verified, entry.spec)?.status === "loaded" ? "loaded" : "unknown",
        version: before,
      },
    }
  }
  const target = verified.state.plugins.find((item) => item.name === entry.name)?.spec ?? entry.spec
  return {
    ok: Boolean(after),
    message: after
      ? `已执行 opencode plugin update ${entry.spec}：${moved ? `v${before} → v${after.version}` : "版本号未变化"}。配置与运行状态已重新读取。`
      : `官方命令报告成功，但配置里已经没有 ${entry.name}`,
    state: verified.state,
    verification: verified.note,
    stages: {
      command: "succeeded",
      config: after ? "updated" : "failed",
      runtime: runtimeRow(verified, target)?.status === "loaded" ? "loaded" : "unknown",
      version: after?.version ?? before,
    },
  }
}

/**
 * The concrete version the safe self-upgrade should move to.
 *
 * This deliberately does not use `opencode plugin check`: the official check skips exact-version
 * pins, so a pinned plugin center would get no target and the upgrade could never start. The npm
 * registry is the authority for the hub's own release, so the target is read from there with
 * `force = true` — a self-upgrade must not act on a stale, cached "latest".
 *
 * Returns an empty version plus the reason on any failure: registry unreachable, malformed or
 * prerelease version, or a registry version not newer than what is installed. The caller refuses
 * to touch the config when the version is empty.
 */
async function latestForSelf(entry: ResolvedEntry): Promise<{ version: string; note: string }> {
  const lookup = await npmLatest(SELF_PACKAGE, true)
  if (!lookup.ok) return { version: "", note: "无法连接 npm registry，未能确认插件中心的目标版本" }
  const target = stableVersion(lookup.version)
  if (!target) {
    return { version: "", note: `npm registry 返回的版本「${lookup.version}」不是有效稳定版本` }
  }
  if (!isStableUpgrade(target, entry.version)) {
    return { version: "", note: `npm registry 的最新稳定版 ${target} 不高于当前版本 ${entry.version || "未知"}` }
  }
  return { version: target, note: "" }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Removes a plugin.
 *
 * npm packages go through `opencode plugin remove`; a directory entry is edited out of the config
 * only — the files stay on disk, and the message says so explicitly.
 */
export async function remove(spec: string): Promise<MutationValue> {
  const parsed = splitSpec(spec)
  const key = parsed.name || spec
  try {
    return await withLock(`pkg:${key}`, () => removeLocked(spec))
  } catch (error) {
    if (error instanceof BusyError) return busyResult(await snapshot(), key)
    return {
      ok: false,
      message: describe(error),
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
}

async function removeLocked(spec: string): Promise<MutationValue> {
  const file = await readConfig()
  if (file.parseError) {
    return {
      ok: false,
      message: `配置文件无法解析（${file.parseError}），为避免覆盖你的配置，没有做任何修改`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  const entry = await findBySpec(file, spec)
  if (!entry) {
    return {
      ok: false,
      message: "配置中没有这一项",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (entry.name === SELF_PACKAGE) {
    return {
      ok: false,
      message: "不能移除正在运行的插件中心自身",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }

  if (entry.kind === "path" || entry.kind === "enable-rule" || entry.kind === "control") {
    const written = await commit((fresh) => {
      const target = entryBySpec(fresh, entry.spec)
      if (!target) return { refuse: `配置里已经没有 ${entry.spec}，无需移除` }
      return [{ path: [fresh.key, target.index], value: undefined }]
    })
    if (!written.ok) {
      return {
        ok: false,
        message: written.error,
        state: written.state,
        stages: { command: "skipped", config: "failed", runtime: "skipped" },
      }
    }
    if (entry.kind === "enable-rule") forgetRule(entry.spec)
    if (entry.kind === "control" && entry.name) forgetRule(entry.name)
    const gone = written.state.plugins.every((item) => item.spec !== entry.spec)
    return {
      ok: gone,
      message: gone
        ? entry.kind === "enable-rule"
          ? `已移除插件中心追加的启用规则 ${entry.spec}（配置里其他规则没有改动）`
          : entry.kind === "control"
            ? `已从配置移除规则 ${entry.spec}；其他规则与插件条目没有改动`
            : `已从配置移除目录条目 ${entry.spec}；磁盘上的目录 ${expandPath(entry.spec)} 没有被删除`
        : `移除失败：配置里仍然有 ${entry.spec}`,
      state: written.state,
      stages: { command: "skipped", config: gone ? "updated" : "failed", runtime: "skipped" },
    }
  }

  if (!hasCli()) {
    return {
      ok: false,
      message: "找不到 opencode CLI，无法执行 opencode plugin remove",
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
  const outcome = await pluginRemove(entry.spec)
  const state = await snapshot()
  const gone = state.plugins.every((item) => item.spec !== entry.spec)
  if (outcome.status === "not-configured" && !gone) {
    return {
      ok: false,
      message: `官方命令没有找到 ${entry.spec}${outputDetail(outcome)}`,
      state,
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
  if (!outcome.result.ok && !gone) {
    return {
      ok: false,
      message: `移除 ${entry.spec} 失败${outputDetail(outcome)}`,
      state,
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
  return {
    ok: gone,
    message: gone
      ? `已通过 opencode plugin remove 移除 ${entry.spec}（只改配置，不删除 npm 缓存里的包文件和本地目录）`
      : `命令已执行，但配置里仍有 ${entry.spec}`,
    state,
    stages: {
      command: outcome.result.ok ? "succeeded" : "failed",
      config: gone ? "updated" : "failed",
      runtime: "skipped",
    },
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

/** Every ID this entry could be known under, runtime ID first. */
function idCandidates(entry: ResolvedEntry, id: string): string[] {
  return Array.from(new Set([id, entry.name, splitSpec(entry.spec).name].filter((value) => value.length > 0)))
}

/** The rule chain that has the most to say about this plugin, so the verdict is not read off a name. */
function ruleState(
  raw: readonly unknown[],
  entry: ResolvedEntry,
  id: string,
): { target: string; verdict: ReturnType<typeof evaluateRules> } {
  let best: { target: string; verdict: ReturnType<typeof evaluateRules> } | undefined
  for (const target of idCandidates(entry, id)) {
    const verdict = evaluateRules(raw, target)
    if (!best || verdict.matches.length > best.verdict.matches.length) best = { target, verdict }
    if (verdict.disabled) return { target, verdict }
  }
  return best ?? { target: id || entry.name, verdict: evaluateRules(raw, id || entry.name) }
}

/**
 * Pauses a plugin by appending `-<real id>` to the plugin list.
 *
 * Nothing is uninstalled, no process is signalled: the entry stays in the config, the package stays
 * on disk, and only the rule that disables it is added. Because rules are processed in order, the
 * new rule is appended last so it wins over everything the user already wrote.
 */
export async function pause(spec: string, options: MutationOptions = {}): Promise<MutationValue> {
  const parsed = splitSpec(spec)
  const key = parsed.name || spec
  try {
    return await withLock(`pkg:${key}`, () => pauseLocked(spec, options))
  } catch (error) {
    if (error instanceof BusyError) return busyResult(await snapshot(), key)
    return {
      ok: false,
      message: describe(error),
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
}

async function pauseLocked(spec: string, options: MutationOptions): Promise<MutationValue> {
  const file = await readConfig()
  if (file.parseError) {
    return {
      ok: false,
      message: `配置文件无法解析（${file.parseError}），为避免覆盖你的配置，没有做任何修改`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  const entry = await findBySpec(file, spec)
  if (!entry) {
    return {
      ok: false,
      message: "配置中没有这一项",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (entry.kind === "control" || entry.kind === "enable-rule") {
    return {
      ok: false,
      message: "配置规则不是插件包，无法暂停",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  const lookup = await resolveId(entry)
  if (!lookup.id) {
    return {
      ok: false,
      message: `无法确认 ${entry.name} 的插件 ID：宿主没有报告它加载时使用的 ID。为避免写入无效规则，未修改配置（请先让它成功加载一次，再暂停）。`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "unknown" },
    }
  }
  const state0 = ruleState(file.raw, entry, lookup.id)
  if (state0.verdict.disabled) {
    return {
      ok: true,
      message: `${entry.name} 已经被规则 ${ruleText(state0.verdict.matches)} 禁用，没有再次写入`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "unknown" },
    }
  }
  const rule = disableRule(lookup.id)
  const written = await commit((fresh) => {
    if (!entryBySpec(fresh, entry.spec)) return { refuse: `配置里的 ${entry.spec} 在操作期间被改动了，未写入规则` }
    // Re-check inside the queue: another window may have just paused it.
    if (ruleState(fresh.raw, entry, lookup.id).verdict.disabled) return []
    return [{ path: [fresh.key, fresh.raw.length], value: rule }]
  })
  if (!written.ok) {
    return {
      ok: false,
      message: written.error,
      state: written.state,
      stages: { command: "skipped", config: "failed", runtime: "skipped" },
    }
  }
  const applied = written.state.plugins.some((item) => item.spec === rule)
  if (!applied) {
    return {
      ok: false,
      message: `写入禁用规则 ${rule} 失败：配置里没有出现这条规则`,
      state: written.state,
      stages: { command: "skipped", config: "failed", runtime: "skipped" },
    }
  }
  const reloaded = await reloadAfterEdit()
  const live = await runtime(options.endpoint)
  const info = live.items.find((item) => item.spec === entry.spec)
  const stillLoaded = info?.status === "loaded" && info.id === lookup.id
  const verification = stillLoaded
    ? `运行时仍报告 ${lookup.id} 已加载：规则已写入，但宿主尚未重新加载`
    : `配置已写入 ${rule}；宿主尚未报告新的加载结果（暂停成功不等于包已卸载，磁盘文件都还在）`
  return {
    ok: true,
    message: `已暂停 ${entry.name}：在配置末尾追加禁用规则 ${rule}（ID 来自${lookup.from === "runtime" ? "宿主运行状态" : "本机记录的运行历史"}），插件条目与包文件都没有改动。${reloaded}。`,
    state: written.state,
    verification,
    stages: {
      command: "skipped",
      config: "updated",
      runtime: stillLoaded ? "unchanged" : "unknown",
    },
  }
}

/**
 * Resumes a paused plugin.
 *
 * Not a reinstall, and not two writes: every rule is evaluated **before** anything changes, then
 * the deletions and the optional positive rule are applied as one edit. The old two-step version
 * could delete the exact rule and then discover it could not name the plugin, leaving the config
 * changed while the operation reported failure.
 *
 * Wildcards are never removed — they belong to the user and cover other plugins too.
 */
export async function resume(spec: string, options: MutationOptions = {}): Promise<MutationValue> {
  const parsed = splitSpec(spec)
  const key = parsed.name || spec
  try {
    return await withLock(`pkg:${key}`, () => resumeLocked(spec, options))
  } catch (error) {
    if (error instanceof BusyError) return busyResult(await snapshot(), key)
    return {
      ok: false,
      message: describe(error),
      state: await snapshot(),
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
}

async function resumeLocked(spec: string, options: MutationOptions): Promise<MutationValue> {
  const file = await readConfig()
  if (file.parseError) {
    return {
      ok: false,
      message: `配置文件无法解析（${file.parseError}），为避免覆盖你的配置，没有做任何修改`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  const entry = await findBySpec(file, spec)
  if (!entry) {
    return {
      ok: false,
      message: "配置中没有这一项",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }
  if (entry.kind === "control" || entry.kind === "enable-rule") {
    return {
      ok: false,
      message: "配置规则不是插件包，无法恢复",
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }
  }

  const lookup = await resolveId(entry)
  const ids = idCandidates(entry, lookup.id)
  const exact = exactRulesFor(file.raw, ids)
  const before = ruleState(file.raw, entry, lookup.id)

  if (exact.length === 0 && !before.verdict.disabled) {
    return {
      ok: true,
      message: `${entry.name} 没有被禁用规则挡住，不需要恢复${lookup.id ? `（运行时 ID ${lookup.id}）` : ""}`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "unknown" },
    }
  }

  // Every rule is settled here, before anything is written:
  //   - exact `-id` rules to delete;
  //   - whether a wildcard still disables it once those are gone (then a positive rule is needed).
  // The old code deleted first and discovered the second part afterwards, which is how an
  // operation could report failure *and* leave the config changed.
  const stillBlocked = countWildcardBlocks(file.raw, entry, ids, exact)
  if (stillBlocked && !lookup.id) {
    return {
      ok: false,
      message: `无法确认 ${entry.name} 的插件 ID：规则 ${ruleText(before.verdict.matches)} 覆盖了它，而宿主没有报告过它的 ID。为避免写入无效规则，未修改配置。`,
      state: await snapshot(),
      stages: { command: "skipped", config: "unchanged", runtime: "unknown" },
    }
  }

  const enable = stillBlocked ? enableRule(lookup.id) : ""
  const expectsNoExact = exact.length === 0
  const written = await commit((fresh) => {
    if (!entryBySpec(fresh, entry.spec)) return { refuse: `配置里的 ${entry.spec} 在操作期间被改动了，未做任何修改` }
    const current = exactRulesFor(fresh.raw, ids)
    // The deletion and the re-enable are one write: either both land, or neither does.
    if (expectsNoExact && current.length > 0) {
      return { refuse: `配置在操作期间出现了新的禁用规则（${ruleText(current)}），请重新执行恢复` }
    }
    if (current.length === 0 && !enable) return []
    // No dedupe on `enable`: a package entry may carry the same text as the ID (the plugin
    // `acme.alpha` and the rule `acme.alpha` look identical), but only a rule *after* the last
    // disabler re-enables anything. Appending is what makes the order work.
    // Removals from the highest index down, then the append at the end: applied to the same text,
    // so the descending order keeps every earlier index valid.
    const planned: Edit[] = current
      .slice()
      .sort((a, b) => b.index - a.index)
      .map((rule) => ({ path: [fresh.key, rule.index], value: undefined }))
    if (enable) planned.push({ path: [fresh.key, fresh.raw.length], value: enable })
    return planned
  })
  if (!written.ok) {
    return {
      ok: false,
      message: written.error,
      state: written.state,
      stages: { command: "skipped", config: "failed", runtime: "skipped" },
    }
  }

  // Verify the end state from the file, not from what we intended to write.
  const after = await readConfig()
  if (after.parseError) {
    return {
      ok: false,
      message: `写入后配置无法解析：${after.parseError}`,
      state: written.state,
      stages: { command: "skipped", config: "failed", runtime: "skipped" },
    }
  }
  const remaining = exactRulesFor(after.raw, ids)
  const verdictAfter = ruleState(after.raw, entry, lookup.id)
  if (remaining.length > 0 || verdictAfter.verdict.disabled) {
    return {
      ok: false,
      message: `恢复 ${entry.name} 没有完成：配置里仍有规则 ${ruleText(verdictAfter.verdict.matches)} 在禁用它`,
      state: written.state,
      stages: { command: "skipped", config: "failed", runtime: "unknown" },
    }
  }

  const reloaded = await reloadAfterEdit()
  const live = await runtime(options.endpoint)
  const info = live.items.find((item) => item.spec === entry.spec)
  const loaded = info?.status === "loaded"
  const removedText = exact.map((rule) => rule.raw).join("、")
  const verification = loaded
    ? `运行时已报告 ${lookup.id || entry.name} 加载成功`
    : "运行时尚未报告加载：等待宿主重新加载（恢复成功不等于插件已加载）"
  if (enable) {
    return {
      ok: true,
      message: `已恢复 ${entry.name}：${removedText ? `删除禁用规则 ${removedText}，` : ""}这些规则去掉后仍被通配规则挡住，因此在同一次写入里追加启用规则 ${enable}。通配规则保持原样。${reloaded}。`,
      state: written.state,
      verification,
      stages: { command: "skipped", config: "updated", runtime: loaded ? "loaded" : "unknown" },
    }
  }
  return {
    ok: true,
    message:
      exact.length > 0
        ? `已恢复 ${entry.name}：删除禁用规则 ${removedText}，插件的版本与配置参数没有改动。${reloaded}。`
        : `已恢复 ${entry.name}：没有需要删除的禁用规则。${reloaded}。`,
    state: written.state,
    verification,
    stages: { command: "skipped", config: "updated", runtime: loaded ? "loaded" : "unknown" },
  }
}

/** Would a rule still disable this plugin once the exact rules are gone? */
function countWildcardBlocks(
  raw: readonly unknown[],
  entry: ResolvedEntry,
  ids: readonly string[],
  exact: readonly { index: number }[],
): boolean {
  const drop = new Set(exact.map((rule) => rule.index))
  const kept = raw.filter((_, index) => !drop.has(index))
  return idCandidates(entry, ids[0] ?? "").some((target) => evaluateRules(kept, target).disabled)
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
      stages: { command: "failed", config: "unchanged", runtime: "skipped" },
    }
  }
  return {
    ok: true,
    message:
      "已执行 opencode reload：受监控的配置项会随之重新加载；未被监听的本地依赖变化，可能仍需重启 OpenCode 服务",
    state,
    // The command ran; whether the host picked anything up is a separate question this never claims.
    stages: { command: "succeeded", config: "unchanged", runtime: "unknown" },
  }
}

/** The CLI argv the hub is using, so the UI can show which binary it drives. */
export function cliInfo(): { available: boolean; command: string } {
  const command = cliCommand()
  return { available: command.length > 0, command: command.join(" ") }
}

/** Exposed for the UI: the same classifier the mutations use, so a test can assert on it. */
export { classify as classifyCliResult }

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
