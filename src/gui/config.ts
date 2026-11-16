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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

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
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
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
      }
    }
    const record = doc && typeof doc === "object" ? doc : {}
    const key = Array.isArray(record.plugins) ? "plugins" : Array.isArray(record.plugin) ? "plugin" : "plugins"
    const list = Array.isArray(record[key]) ? (record[key] as unknown[]) : []
    const file: ConfigFile = { path, text, key, raw: list, entries: normalize(list), parseError: "" }
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
  }
}

/** Write via a temp file in the same directory, then rename over the target (atomic on the same volume). */
export async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.plugin-hub-${process.pid}-${Date.now()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, text, "utf8")
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
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
      await atomicWrite(file.path, text)
    } catch (error) {
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
