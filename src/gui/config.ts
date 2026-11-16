/**
 * opencode.json / opencode.jsonc 的读写层。
 *
 * 三条规矩，全部来自踩过的坑：
 *
 * 1. **解析失败就是失败，不是空配置。** 一个写坏了的大括号如果被当成 `plugins: []`，
 *    界面会显示「一个插件都没装」，而下一次写入就会把用户整个文件覆盖成 `{"plugins":[…]}`。
 *    所以解析出错时返回 `parseError`，所有写入直接拒绝。
 * 2. **只改一个节点。** 用 jsonc-parser 的 `modify` + `applyEdits`，注释、缩进、行序和其他
 *    配置项都留在原地；不做 `JSON.parse` → `JSON.stringify` 的整文件重写。
 * 3. **编辑计划在队列内、基于最新文件计算。** 调用方算好下标再排队，中间被用户或别的进程
 *    改一行，下标就指错了条目 —— 那会删掉别人的插件。因此这里只接受「计划函数」，
 *    计划函数拿到的是队列内刚刚重读的文件。
 */
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

/**
 * 新建配置文件的权限：只有属主可读写。
 *
 * 这里不能用 `0644`：配置文件里可能写着带 token 的 options 或私有 registry 地址，
 * 顺手建成全用户可读等于把用户的凭据摊开。
 */
const DEFAULT_MODE = 0o600

/**
 * 一份「编辑计划成立的前提」快照。
 *
 * `text` 是计划所依据的原文，提交前逐字节比对；`dev`/`ino` 是文件身份，用来发现
 * 「被换成另一个文件但内容恰好一样」；`mode` 是原权限，写入后要原样保持。
 */
export interface FileBaseline {
  text: string
  dev: number
  ino: number
  mode: number
}

/**
 * 外部改了配置，所以这次写入被放弃。
 *
 * 单独成类型是因为调用方要把它和「磁盘写不进去」区分开：一个是有人同时在改，
 * 一个是权限/磁盘问题，用户该做的事完全不同。
 */
export class ConcurrentEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConcurrentEditError"
  }
}

function oct(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`
}

/** One entry of the `plugins` array, keeping its position so edits hit the right element. */
export interface ConfigEntry {
  /** Position in the raw array; only valid for the read it came from. */
  index: number
  /** The configured spec: the string itself, or an object's `package`. */
  spec: string
  /** True when the entry is `{package, options}` — replacing it must keep the options. */
  options: boolean
  raw: unknown
}

export interface ConfigFile {
  path: string
  text: string
  key: string
  /** The array exactly as written, including entries this build does not manage. */
  raw: unknown[]
  entries: ConfigEntry[]
  /**
   * Non-empty when the file exists but cannot be parsed. Callers must treat this as an error:
   * the file is *not* an empty config, and writing to it would destroy whatever the user meant.
   */
  parseError: string
  /**
   * What this read saw on disk; `null` when the file did not exist yet.
   * A write built on this file is refused if the disk no longer matches it.
   */
  baseline: FileBaseline | null
}

export interface Edit {
  path: (string | number)[]
  value: unknown
}

/** A plan returns edits, or refuses with a reason when the file is no longer what the caller saw. */
export type EditPlanResult = Edit[] | { refuse: string }

export type EditPlan = (file: ConfigFile) => EditPlanResult

export interface EditOutcome {
  ok: boolean
  /** Why the write did not happen; empty on success. */
  error: string
  /** The file as it stands after the attempt (re-read), so callers can verify. */
  file: ConfigFile
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode")
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }

/**
 * Reads the entries the hub understands while keeping everything else on disk untouched.
 * Unknown shapes (an object without `package`, a number) are preserved but not managed.
 */
export function normalize(raw: unknown[]): ConfigEntry[] {
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

function parseMessage(errors: readonly ParseError[], text: string): string {
  const first = errors[0]
  if (!first) return "配置内容无法解析"
  const offset = Math.min(Math.max(first.offset, 0), Math.max(text.length - 1, 0))
  const line = text.slice(0, offset).split(/\r?\n/).length
  return `${first.error === 1 ? "语法错误" : `解析错误 ${first.error}`}（第 ${line} 个字符附近）`
}

/**
 * The config file the official CLI would use: opencode.json first, then opencode.jsonc.
 *
 * A file that exists but does not parse stops the search and is returned with `parseError` set.
 * Silently falling through to the next candidate (or to a fresh `{}`) is exactly how a broken
 * config gets "repaired" into an empty one on the next write.
 */
export async function readConfig(): Promise<ConfigFile> {
  const dir = configDir()
  const candidates = [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]
  let fallback: ConfigFile | undefined
  for (const path of candidates) {
    let text: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
      // A directory or a fifo here is not a config; skipping keeps `readFile` from throwing EISDIR
      // and keeps the next candidate in play.
      if (!info.isFile()) continue
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    const baseline: FileBaseline = { text, dev: info.dev, ino: info.ino, mode: info.mode & 0o777 }
    const errors: ParseError[] = []
    const doc = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
      | Record<string, unknown>
      | undefined
    if (errors.length > 0) {
      return {
        path,
        text,
        key: "plugins",
        raw: [],
        entries: [],
        parseError: parseMessage(errors, text),
        baseline,
      }
    }
    const record = doc && typeof doc === "object" ? doc : {}
    const key = Array.isArray(record.plugins) ? "plugins" : Array.isArray(record.plugin) ? "plugin" : "plugins"
    const list = Array.isArray(record[key]) ? (record[key] as unknown[]) : []
    const file: ConfigFile = { path, text, key, raw: list, entries: normalize(list), parseError: "", baseline }
    if (file.entries.length > 0) return file
    if (!fallback) fallback = file
  }
  if (fallback) return fallback
  // Nothing on disk yet: create the JSON config next to whatever exists.
  return {
    path: join(dir, "opencode.json"),
    text: "{}\n",
    key: "plugins",
    raw: [],
    entries: [],
    parseError: "",
    baseline: null,
  }
}

/**
 * The path a rename has to hit.
 *
 * If the config is a symlink (dotfiles managers do this), replacing the link itself would turn it
 * into a regular file and silently detach it from the user's repo. So the write goes to whatever
 * the link points at, and the link stays a link.
 */
async function resolveTarget(path: string): Promise<string> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path
    throw error
  }
  if (info.isSymbolicLink()) {
    try {
      return await realpath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${path} 是指向不存在目标的符号链接，未写入`)
      }
      throw error
    }
  }
  if (!info.isFile()) throw new Error(`${path} 不是普通文件，未写入`)
  return path
}

/** A temp file that already holds the new content and can still be abandoned. */
export interface StagedWrite {
  /** The path the rename will overwrite (symlinks resolved). */
  target: string
  /** The temp file; removed on commit, and on failure. */
  tmp: string
  /** The permission the temp file must still have at commit time. */
  mode: number
  /** What the plan was computed from; `null` when the target did not exist. */
  expected: FileBaseline | null
}

/**
 * Writes the new content to a temp file next to the target, with the target's own permission.
 *
 * `writeFile`'s `mode` is filtered through the process umask, so a 0640 file would land at 0600
 * under a 0077 umask. The explicit `chmod` afterwards, plus the `stat` check, is what actually
 * keeps the permission — and a file that existed as 0600 stays 0600 no matter who runs the hub.
 */
export async function stageWrite(file: ConfigFile, text: string): Promise<StagedWrite> {
  const target = await resolveTarget(file.path)
  const expected = file.baseline
  const mode = expected ? expected.mode : DEFAULT_MODE
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.plugin-hub-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode })
    await chmod(tmp, mode)
    const got = (await stat(tmp)).mode & 0o777
    if (got !== mode) {
      throw new Error(`无法把临时文件权限设为 ${oct(mode)}（实际 ${oct(got)}），未替换原文件`)
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  return { target, tmp, mode, expected }
}

/** Reads the file as it is right now, for the pre-commit comparison. */
async function observe(path: string): Promise<FileBaseline | null> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new ConcurrentEditError(`无法再次读取配置以确认未被外部修改：${describe(error)}`)
  }
  if (!info.isFile()) throw new ConcurrentEditError("配置路径已经不是普通文件，未覆盖")
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    throw new ConcurrentEditError(`配置在操作期间变得不可读：${describe(error)}`)
  }
  return { text, dev: info.dev, ino: info.ino, mode: info.mode & 0o777 }
}

/** Empty string means the disk is still the file the plan was computed from. */
function compareBaseline(expected: FileBaseline | null, now: FileBaseline | null): string {
  if (!expected) return now ? "配置在操作期间被创建，未覆盖" : ""
  if (!now) return "配置在操作期间被删除，未重新创建"
  if (now.text !== expected.text) return "配置在操作期间被外部修改，未覆盖"
  // Same text but different inode: something replaced the file wholesale. The content the user
  // has right now is what a plan must be rebuilt from, so this is still a refusal.
  if (now.dev !== expected.dev || now.ino !== expected.ino) {
    return "配置在操作期间被另一个文件替换，未覆盖"
  }
  return ""
}

/**
 * Renames the staged file over the target — but only if the target still looks like the file the
 * plan was built from.
 *
 * What this does and does not buy:
 * - It catches every external change made between the read and this moment, including a wholesale
 *   file replacement (inode check) and a deletion.
 * - It does *not* close the race completely: there is still a window of a few syscalls between the
 *   comparison and the `rename`. Node exposes no compare-and-swap for files (`renameat2` with
 *   `RENAME_EXCHANGE` is not in libuv, and adding a native helper for this would be worse than the
 *   window). So: the window is narrowed from "the whole operation" to "microseconds", and the
 *   limited guarantee is documented rather than claimed as atomic.
 */
export async function commitWrite(staged: StagedWrite): Promise<void> {
  try {
    const drift = compareBaseline(staged.expected, await observe(staged.target))
    if (drift) throw new ConcurrentEditError(drift)
    const got = (await stat(staged.tmp)).mode & 0o777
    if (got !== staged.mode) {
      throw new Error(`临时文件权限在写入后被改变（期望 ${oct(staged.mode)}，实际 ${oct(got)}），未替换原文件`)
    }
    await rename(staged.tmp, staged.target)
  } finally {
    await rm(staged.tmp, { force: true }).catch(() => undefined)
  }
}

/** Abandons a staged write without touching the target. */
export async function discardWrite(staged: StagedWrite): Promise<void> {
  await rm(staged.tmp, { force: true }).catch(() => undefined)
}

/** Stage + commit: keeps the two steps separate so tests (and the concurrency check) can split them. */
export async function atomicWrite(file: ConfigFile, text: string): Promise<void> {
  const staged = await stageWrite(file, text)
  await commitWrite(staged)
}

/**
 * Serial queue for every config mutation in this process.
 *
 * It is not a cross-process lock — OpenCode itself and the user's editor are outside it. What it
 * guarantees is that two cards (or the settings page and the dialog) cannot interleave a read and
 * a write; the read-then-decide happens inside the same turn, against the newest file.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Runs one edit plan against the freshest config, then verifies the write landed.
 *
 * The plan is called *inside* the queue: it sees the file as it is right now, so an external
 * change made between the caller's read and this turn is either absorbed (the plan re-finds the
 * entry by identity) or refused — never applied to a stale index.
 */
export async function editConfig(plan: EditPlan): Promise<EditOutcome> {
  return enqueue(async () => {
    const file = await readConfig()
    if (file.parseError) {
      return { ok: false, error: `配置文件无法解析，未做任何修改：${file.parseError}`, file }
    }
    let planned: EditPlanResult
    try {
      planned = plan(file)
    } catch (error) {
      return { ok: false, error: describe(error), file }
    }
    if (!Array.isArray(planned)) return { ok: false, error: planned.refuse, file }
    if (planned.length === 0) return { ok: true, error: "", file }

    let text = file.text.trim().length > 0 ? file.text : "{}\n"
    for (const edit of planned) {
      const next = applyEdits(text, modify(text, edit.path, edit.value, FORMAT))
      // jsonc-parser returns the input unchanged when it could not address the path; treating that
      // as success would let a failed removal report "removed".
      if (next === text) {
        return { ok: false, error: `无法在配置中定位要修改的位置（${edit.path.join(".")}）`, file }
      }
      text = next
    }
    if (text === file.text) {
      // Nothing to do is not an error, but it must not be reported as a write either.
      return { ok: true, error: "", file }
    }
    try {
      await atomicWrite(file, text)
    } catch (error) {
      if (error instanceof ConcurrentEditError) {
        // Someone else owns the newest content now. Report their version, not ours: the caller
        // must re-read before deciding what to do, and must never retry the old plan.
        return {
          ok: false,
          error: `${error.message}；为避免丢掉外部改动，本次没有写入，请刷新后重新操作`,
          file: await readConfig(),
        }
      }
      // atomicWrite only renames over the target on success, so the old file is still intact.
      return { ok: false, error: `写入配置失败（原文件未改动）：${describe(error)}`, file }
    }
    const after = await readConfig()
    if (after.parseError) {
      return { ok: false, error: `写入后配置无法解析：${after.parseError}`, file: after }
    }
    return { ok: true, error: "", file: after }
  })
}

/** Finds an entry by exact spec text in a freshly read file; undefined when it moved or vanished. */
export function entryBySpec(file: ConfigFile, spec: string): ConfigEntry | undefined {
  const wanted = spec.trim()
  return file.entries.find((entry) => entry.spec.trim() === wanted)
}

/** The index a new entry appends to, computed from the file in hand. */
export function appendIndex(file: ConfigFile): number {
  return file.raw.length
}
