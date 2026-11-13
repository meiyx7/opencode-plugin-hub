import { spawn } from "node:child_process"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { downloadsFor, registryFetch, type Downloads } from "./registry"

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

export interface UpdateInfoValue {
  spec: string
  /** Real package name: for a directory plugin this comes from its package.json, not the folder name. */
  name: string
  kind: string
  current: string
  latest: string
  hasUpdate: boolean
  /** False for directory plugins, whose files are copied rather than resolved from the registry. */
  managed: boolean
  /** One-line summary from the package manifest; empty when it cannot be read. */
  description?: string
  license?: string
  homepage?: string
  repo?: string
  /** Publisher or first maintainer from the registry; empty for local directories. */
  publisher?: string
  error: string
}

export interface UpdatesResultValue {
  items: UpdateInfoValue[]
  error: string
}

export interface MutationValue {
  ok: boolean
  message: string
  state: HubStateValue
}

const SELF_PACKAGE = "opencode-plugin-hub"
const NPM_KEYWORD = "opencode-plugin"
/** A registry lookup is reused for this long, so opening the page twice is not two requests. */
const VERSION_TTL = 5 * 60 * 1000

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode")
}

function cacheDir() {
  const xdg = process.env.XDG_CACHE_HOME
  return xdg ? join(xdg, "opencode", "npm") : join(homedir(), ".cache", "opencode", "npm")
}

interface ConfigFile {
  path: string
  text: string
  key: string
  plugins: string[]
}

async function readConfig(): Promise<ConfigFile> {
  const dir = configDir()
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
    const list = Array.isArray(record[key]) ? (record[key] as unknown[]).filter((v) => typeof v === "string") : []
    const file: ConfigFile = { path, text, key, plugins: list as string[] }
    if (file.plugins.length > 0) return file
    if (!fallback) fallback = file
  }
  if (fallback) return fallback
  // Nothing on disk yet: create the JSON config next to whatever exists.
  return { path: join(dir, "opencode.json"), text: "{}\n", key: "plugins", plugins: [] }
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
  if (trimmed.startsWith("/") || trimmed.startsWith(".") || trimmed.startsWith("~/")) {
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

/** Best-effort installed version of a registry plugin, read from OpenCode's unpacked npm cache. */
async function installedVersion(name: string, range: string): Promise<string> {
  return (await readInstalledManifest(name, range))?.version ?? ""
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
  spec: string
  name: string
  kind: string
  version: string
  description: string
  license: string
  homepage: string
  repo: string
}

/** Normalizes one config entry, looking inside directory plugins for their real identity. */
async function resolveEntry(spec: string): Promise<ResolvedEntry> {
  const parsed = splitSpec(spec)
  if (parsed.kind !== "path") {
    // Read the installed manifest first: it carries the summary that the installed cards show,
    // and it is on disk, so the description does not disappear when the registry is unreachable.
    const manifest = await readInstalledManifest(parsed.name, parsed.range)
    const repo = repository(manifest?.repository)
    const version = literalVersion(parsed.range) || manifest?.version || ""
    return {
      spec,
      name: parsed.name,
      kind: parsed.kind,
      version,
      description: manifest?.description ?? "",
      license: licenseText(manifest?.license),
      homepage: cleanUrl(manifest?.homepage) || repo.url,
      repo: repo.url,
    }
  }
  const manifest = await readManifest(expandPath(spec))
  const repo = repository(manifest?.repository)
  return {
    spec,
    name: manifest?.name && isPackageName(manifest.name) ? manifest.name : parsed.name,
    kind: "path",
    version: manifest?.version ?? "",
    description: manifest?.description ?? "",
    license: licenseText(manifest?.license),
    homepage: cleanUrl(manifest?.homepage) || repo.url,
    repo: repo.url,
  }
}

async function resolveAll(file: ConfigFile): Promise<ResolvedEntry[]> {
  return Promise.all(file.plugins.map((spec) => resolveEntry(spec)))
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

/** Compares every configured plugin against the registry. One request per package, in parallel. */
export async function updates(): Promise<UpdatesResultValue> {
  try {
    const file = await readConfig()
    const resolved = await resolveAll(file)
    const items = await Promise.all(
      resolved.map(async (entry): Promise<UpdateInfoValue> => {
        const lookupable = isPackageName(entry.name)
        const lookup: VersionLookup = lookupable ? await npmLatest(entry.name) : emptyLookup(false)
        return {
          spec: entry.spec,
          name: entry.name,
          kind: entry.kind,
          current: entry.version,
          latest: lookup.version,
          hasUpdate: lookup.ok && isNewer(lookup.version, entry.version),
          managed: entry.kind !== "path",
          // Directory plugins already carry their package.json summary; registry
          // plugins get it from the `/latest` manifest in the same request.
          description: entry.description || lookup.description,
          license: entry.license || lookup.license,
          homepage: entry.homepage || lookup.homepage,
          repo: entry.repo || lookup.repo,
          publisher: lookup.publisher,
          error: !lookupable
            ? "不是 npm 包名，无法查询版本"
            : !lookup.ok
              ? "无法连接 npm registry，本次未检查（可设置 OPENCODE_PLUGIN_HUB_REGISTRY 指向可用镜像）"
              : "",
        }
      }),
    )
    return { items, error: "" }
  } catch (error) {
    return { items: [], error: describe(error) }
  }
}

/**
 * Edits one value in place, so the user's comments, ordering and indentation survive on every other line.
 * `path` is a jsonc path such as `["plugins", 2]`.
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

async function applyEdit(file: ConfigFile, path: (string | number)[], value: unknown): Promise<HubStateValue> {
  return enqueue(async () => {
    // Re-read inside the queue: the file may have changed since the caller read it.
    const fresh = await readConfig()
    const text = fresh.text.trim().length > 0 ? fresh.text : "{}\n"
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }
    const edits = modify(text, path, value, options)
    await atomicWrite(fresh.path, applyEdits(text, edits))
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

/** Index of the entry that owns `name`, matching either the raw name or a directory's package.json name. */
async function findEntry(file: ConfigFile, name: string): Promise<number> {
  for (const [index, spec] of file.plugins.entries()) {
    if (splitSpec(spec).name === name) return index
  }
  for (const [index, spec] of file.plugins.entries()) {
    const parsed = splitSpec(spec)
    if (parsed.kind !== "path") continue
    const manifest = await readManifest(expandPath(spec))
    if (manifest?.name === name) return index
  }
  return -1
}

interface Packument {
  "dist-tags"?: Record<string, string>
  versions?: Record<string, { dist?: { tarball?: string } }>
}

async function packument(name: string, version: string): Promise<{ tarball: string; version: string } | undefined> {
  const url = `/${encodeURIComponent(name)}`
  try {
    const response = await registryFetch(url, {
      timeoutMs: 15_000,
      accept: "application/vnd.npm.install-v1+json",
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as Packument
    const resolved = version || body["dist-tags"]?.latest || ""
    const entry = resolved ? body.versions?.[resolved] : undefined
    const tarball = entry?.dist?.tarball
    return tarball ? { tarball, version: resolved } : undefined
  } catch {
    return undefined
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true })
  await mkdir(to, { recursive: true })
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, target)
    else if (entry.isFile()) await copyFile(source, target)
  }
}

/** Puts a directory back exactly as it was: drop files the update added, then copy the backup over. */
async function restoreTree(from: string, to: string): Promise<void> {
  const keep = new Set(await readdir(from))
  for (const entry of await readdir(to, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue
    await rm(join(to, entry.name), { recursive: true, force: true })
  }
  await copyTree(from, to)
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout?.on("data", (chunk) => (output += String(chunk)))
    child.stderr?.on("data", (chunk) => (output += String(chunk)))
    child.on("error", (error) => resolve({ code: -1, output: describe(error) }))
    child.on("close", (code) => resolve({ code: code ?? -1, output }))
  })
}

/**
 * Refreshes a directory plugin from the registry: unpack the new tarball over the folder, then
 * rerun `scripts/repatch.mjs` when present so a local patch is reapplied rather than silently lost.
 * The previous contents are kept next to the folder; on any failure they are copied back.
 */
async function refreshDirectory(dir: string, name: string, version: string): Promise<{ ok: boolean; message: string }> {
  const target = await packument(name, version)
  if (!target) return { ok: false, message: "在 npm 上找不到这个版本" }

  let work = ""
  try {
    work = await mkdtemp(join(tmpdir(), "plugin-hub-"))
    const archive = join(work, "package.tgz")
    const download = await fetch(target.tarball, { signal: AbortSignal.timeout(60_000) })
    if (!download.ok) return { ok: false, message: `下载失败：${download.status}` }
    await writeFile(archive, Buffer.from(await download.arrayBuffer()))

    const unpacked = join(work, "unpacked")
    await mkdir(unpacked, { recursive: true })
    const tar = await run("tar", ["-xzf", archive, "-C", unpacked], work)
    if (tar.code !== 0) return { ok: false, message: `解包失败：${tar.output.slice(0, 160)}` }

    const staged = join(unpacked, "package")
    const stagedManifest = await readManifest(staged)
    if (!stagedManifest) return { ok: false, message: "下载的包里没有 package.json" }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const backup = `${dir}.backup-${stamp}`
    await cp(dir, backup, { recursive: true })
    try {
      await copyTree(staged, dir)
      const repatch = join(dir, "scripts", "repatch.mjs")
      const hasRepatch = await stat(repatch).then(
        () => true,
        () => false,
      )
      let patched = ""
      if (hasRepatch) {
        // Patch from the freshly unpacked copy: the npm cache still holds the old version.
        const result = await run(process.execPath, [repatch, "--from", staged], dir)
        if (result.code !== 0) throw new Error(`重打补丁失败：${result.output.slice(0, 160)}`)
        patched = "，已自动重打补丁"
      }
      const after = await readManifest(dir)
      return {
        ok: true,
        message: `已更新到 ${after?.version ?? target.version}${patched}；旧版本备份在 ${basename(backup)}`,
      }
    } catch (error) {
      await restoreTree(backup, dir).catch(() => undefined)
      return { ok: false, message: `更新中断，已从备份还原：${describe(error)}` }
    }
  } catch (error) {
    return { ok: false, message: describe(error) }
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function install(spec: string, version: string): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const parsed = splitSpec(spec)
    if (parsed.kind !== "package" || !isPackageName(parsed.name)) {
      return { ok: false, message: "只能按 npm 包名安装", state: await snapshot() }
    }
    const name = parsed.name
    const wanted = version.trim() ? `${name}@${version.trim()}` : name
    const index = await findEntry(file, name)

    // A directory plugin cannot be updated by editing the config: its files have to be replaced.
    if (index >= 0 && splitSpec(file.plugins[index]!).kind === "path") {
      const dir = expandPath(file.plugins[index]!)
      // The directory refresh rewrites files, not the config — still run it
      // through the queue so it cannot interleave with a config edit.
      const result = await enqueue(() => refreshDirectory(dir, name, version.trim()))
      return { ok: result.ok, message: result.message, state: await snapshot() }
    }

    const state =
      index >= 0
        ? await applyEdit(file, [file.key, index], wanted)
        : await applyEdit(file, [file.key, file.plugins.length], wanted)
    return { ok: true, message: index >= 0 ? `已更新 ${wanted}` : `已添加 ${wanted}`, state }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

export async function remove(spec: string): Promise<MutationValue> {
  try {
    const file = await readConfig()
    const { name } = splitSpec(spec)
    const index = file.plugins.findIndex((entry) => entry.trim() === spec.trim())
    if (index < 0) return { ok: false, message: "配置中没有这一项", state: await snapshot() }
    const resolved = await resolveEntry(file.plugins[index]!)
    if (resolved.name === SELF_PACKAGE) {
      return { ok: false, message: "不能移除正在运行的插件中心自身", state: await snapshot() }
    }
    const state = await applyEdit(file, [file.key, index], undefined)
    return { ok: true, message: `已移除 ${resolved.name || name}`, state }
  } catch (error) {
    return { ok: false, message: describe(error), state: await snapshot() }
  }
}

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
  downloads?: { weekly?: number; monthly?: number; all?: number }
  package?: RegistrySearchPackage
}

interface RegistrySearch {
  objects?: RegistrySearchItem[]
}

/** What one search hit needs beyond the search index: downloads and the manifest behind `links`. */
interface SearchExtra {
  counts: Downloads | undefined
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

type RemoteDetail = Omit<PackageDetailValue, "npm" | "installed" | "current" | "hasUpdate" | "error">

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

/** `-1` means the download API could not be asked: the UI must show 暂不可用, not 0. */
async function loadDownloads(name: string, period: "last-week" | "last-month"): Promise<number> {
  const counts = await downloadsFor(name)
  if (!counts) return -1
  return period === "last-week" ? counts.weekly : counts.monthly
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
  const [weekly, monthly] = await Promise.all([
    loadDownloads(name, "last-week"),
    loadDownloads(name, "last-month"),
  ])
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
    weekly,
    monthly,
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
    weekly: 0,
    monthly: 0,
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

  const remote = await loadRemoteDetail(name)
  if ("error" in remote) return { ...base(), installed, current, error: remote.error }
  return {
    ...remote,
    npm: base().npm,
    installed,
    current,
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
    // The mirror's search index omits `links` and only reports all-time downloads. One extra
    // request per package fills both in: the downloads series, and the `/latest` manifest for
    // homepage/repo. Unknown stays -1 so the card says 暂不可用 instead of a fake 0.
    const extra = await mapLimited<RegistrySearchItem, SearchExtra>(packages, LOOKUP_CONCURRENCY, async (item) => {
      const name = item.package!.name!
      const [counts, manifest] = await Promise.all([
        item.downloads?.weekly !== undefined ? undefined : downloadsFor(name),
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
        hasUpdate: isInstalled && isNewer(pkg.version ?? "", current),
        weekly: item.downloads?.weekly ?? looked?.counts?.weekly ?? -1,
        monthly: item.downloads?.monthly ?? looked?.counts?.monthly ?? -1,
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
 * Fully restarts the desktop app: quit it, make sure no stale `serve --service` keeps the old
 * plugin bundle alive, then open it again.
 *
 * The shell has to be detached because this process is one of the things being killed. `ps` is
 * used instead of `pgrep -f` for the app PID: on macOS the packaged Electron main process is not
 * visible to `pgrep -f`, while `ps -axo args` lists it. The bracket in each pattern (`[/]…`,
 * `[s]erve`) keeps this script's own command line from matching the kill target.
 */
export function restart(): boolean {
  if (process.platform !== "darwin") return false
  const script = `
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
log="$HOME/.cache/opencode/plugin-hub/restart.log"
mkdir -p "$HOME/.cache/opencode/plugin-hub" 2>/dev/null
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$log" 2>/dev/null; }

sleep 1
say "restart requested"

app_pids=$(ps -axo pid=,args= | grep -E '[/]OpenCode\\.app/Contents/MacOS/OpenCode($| )' | grep -v 'Helper' | awk '{print $1}')
say "app pids: \${app_pids:-none}"
[ -n "$app_pids" ] && kill -TERM $app_pids 2>/dev/null

sleep 2

# The service survives window closes, so it has to be stopped explicitly.
service_pids=$(ps -axo pid=,args= | grep '[s]erve --service' | awk '{print $1}')
say "service pids: \${service_pids:-none}"
[ -n "$service_pids" ] && kill -TERM $service_pids 2>/dev/null

sleep 1

i=0
while [ "$i" -lt 6 ]; do
  app_pids=$(ps -axo pid=,args= | grep -E '[/]OpenCode\\.app/Contents/MacOS/OpenCode($| )' | grep -v 'Helper' | awk '{print $1}')
  [ -z "$app_pids" ] && break
  sleep 1
  i=$((i + 1))
done
[ -n "$app_pids" ] && kill -KILL $app_pids 2>/dev/null

sleep 1
say "opening app"
open -b ai.opencode.desktop 2>/dev/null || open -a OpenCode
`
  try {
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Asks the CLI to reload its configuration. A full restart is still needed for provider snapshots. */
export async function reload(argv: readonly string[]): Promise<MutationValue> {
  const state = await snapshot()
  try {
    if (argv.length === 0) return { ok: false, message: "找不到 opencode CLI", state }
    const child = spawn(argv[0]!, [...argv.slice(1), "reload"], { detached: true, stdio: "ignore" })
    child.unref()
    return { ok: true, message: "已请求重载配置；插件列表变化建议完全退出应用再打开", state }
  } catch (error) {
    return { ok: false, message: describe(error), state }
  }
}

/** One configured plugin's runtime truth, as the running server reports it. */
export interface RuntimeInfoValue {
  spec: string
  name: string
  status: "loaded" | "failed" | "unknown"
  runtimeVersion: string
  error: string
  available: boolean
}

export interface RuntimeResultValue {
  items: RuntimeInfoValue[]
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

/**
 * Cross-references the config with the server's running plugin list, so the UI
 * can tell 已配置待生效 from 已加载. Best effort: when the server cannot be
 * asked, every item stays "unknown" instead of pretending to know.
 */
export async function runtime(endpoint: { url: string; headers: Readonly<Record<string, string>> } | undefined): Promise<RuntimeResultValue> {
  const state = await snapshot()
  if (!endpoint) return { items: state.plugins.map(toUnknown), error: "无法连接后台服务，运行状态未知" }
  try {
    // The sidecar serves its web UI at `/`, so `/plugin` is an HTML page. The
    // JSON API lives under `/api`; asking the wrong path yields 200 HTML and a
    // confusing parse error.
    const response = await fetch(`${endpoint.url.replace(/\/+$/, "")}/api/plugin`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json", ...endpoint.headers },
    })
    if (!response.ok) {
      return { items: state.plugins.map(toUnknown), error: `后台服务返回 ${response.status}，运行状态未知` }
    }
    // Do not assume JSON: a misrouted request can return an HTML page with 200.
    const text = await response.text()
    let body: { data?: PluginListInfo[] } | PluginListInfo[]
    try {
      body = JSON.parse(text) as { data?: PluginListInfo[] } | PluginListInfo[]
    } catch {
      return { items: state.plugins.map(toUnknown), error: "后台返回的不是 JSON，运行状态未知" }
    }
    const list = Array.isArray(body) ? body : body.data ?? []
    const items = state.plugins.map((entry) => {
      // The server reports the source target; the config holds the spec (name, name@range or a path).
      const name = splitSpec(entry.spec).name
      const loaded = list.find((info) => {
        const source = info.source
        if (!source) return false
        if (source.type === "package" && typeof source.target === "string") {
          return splitSpec(source.target).name === name
        }
        if (source.type === "local" && entry.kind === "path" && typeof source.path === "string") {
          return resolve(source.path) === resolve(expandPath(entry.spec))
        }
        return false
      })
      // Only the fields in RuntimeInfo cross the IPC boundary; config details stay on this side.
      const base = { spec: entry.spec, name: entry.name }
      if (!loaded) return { ...base, status: "unknown" as const, runtimeVersion: "", error: "", available: true }
      if (loaded.state?.status === "failed") {
        return {
          ...base,
          status: "failed" as const,
          runtimeVersion: "",
          error: loaded.state.error ?? "加载失败",
          available: true,
        }
      }
      return {
        ...base,
        status: "loaded" as const,
        runtimeVersion: loaded.source?.type === "package" ? (loaded.source.version ?? "") : entry.version,
        error: "",
        available: true,
      }
    })
    return { items, error: "" }
  } catch (error) {
    return { items: state.plugins.map(toUnknown), error: `无法读取运行状态：${describe(error)}` }
  }
}

function toUnknown(entry: InstalledEntryValue): RuntimeInfoValue {
  return { spec: entry.spec, name: entry.name, status: "unknown", runtimeVersion: "", error: "", available: false }
}

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
