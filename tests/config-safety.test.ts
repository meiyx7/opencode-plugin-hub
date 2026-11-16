/**
 * 配置文件的两个硬要求：**权限不能被改掉**，**外部改动不能被覆盖**。
 *
 * 这里的并发用例不是「调两次插件中心 API」，而是在读与提交之间用原始 fs 直接改文件，
 * 精确复现那条时序：读 → 算计划 → 写临时文件 → （别人改了）→ rename。
 * 真正的跨进程验证在 docs/real-cli-acceptance.md 里用真实 opencode CLI 做。
 */
import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ConcurrentEditError,
  commitWrite,
  configDir,
  editConfig,
  readConfig,
  stageWrite,
  type ConfigFile,
} from "../src/gui/config.ts"

let temp = ""
let originalUmask = 0o022

function jsonPath(): string {
  return join(configDir(), "opencode.json")
}

async function writeConfig(plugins: unknown[], mode = 0o600): Promise<void> {
  await writeFile(jsonPath(), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8")
  await chmod(jsonPath(), mode)
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

/** A plan that appends one spec, so the write has something real to do. */
const append = (spec: string) => (file: ConfigFile) => [{ path: [file.key, file.raw.length], value: spec }]

async function leftovers(): Promise<string[]> {
  const names = await readdir(configDir())
  return names.filter((name) => name.includes(".plugin-hub-") || name.endsWith(".tmp"))
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-config-"))
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  await mkdir(configDir(), { recursive: true })
  originalUmask = process.umask()
})

afterEach(async () => {
  process.umask(originalUmask)
  await chmod(jsonPath(), 0o600).catch(() => undefined)
  await chmod(configDir(), 0o700).catch(() => undefined)
  await rm(temp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// TASK-01: 权限保持
// ---------------------------------------------------------------------------

test("01. 原文件 0600，写入后仍是 0600", async () => {
  await writeConfig(["keep-me"], 0o600)
  const outcome = await editConfig(append("added"))
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(await modeOf(jsonPath()), 0o600)
})

test("02. 原文件 0640，写入后仍是 0640（umask 0022 也不会被削成 0644 或 0600）", async () => {
  await writeConfig(["keep-me"], 0o640)
  const outcome = await editConfig(append("added"))
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(await modeOf(jsonPath()), 0o640, "组可读的配置被写成了别的权限")
})

test("03. 原文件不存在时，新建文件用 0600（不是全用户可读）", async () => {
  // 目录里没有 opencode.json：readConfig 会返回一个待创建的合成对象。
  assert.equal(await stat(jsonPath()).then(() => true, () => false), false)
  const outcome = await editConfig(append("fresh"))
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(await modeOf(jsonPath()), 0o600)
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["fresh"])
})

test("04. umask 0077 下 0640 仍然保住 0640（writeFile 的 mode 会被 umask 削弱，靠显式 chmod）", async () => {
  await writeConfig(["keep-me"], 0o640)
  process.umask(0o077)
  const outcome = await editConfig(append("added"))
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(await modeOf(jsonPath()), 0o640)
})

test("05. umask 0002 下 0600 仍然是 0600（不会被放宽）", async () => {
  await writeConfig(["keep-me"], 0o600)
  process.umask(0o002)
  const outcome = await editConfig(append("added"))
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(await modeOf(jsonPath()), 0o600, "权限被 umask 放宽了")
})

test("06. 写入失败时，原文件内容与权限都不变，也不留临时文件", async () => {
  await writeConfig(["keep-me"], 0o640)
  const before = await readFile(jsonPath(), "utf8")
  // 目录只读：临时文件写不进去，连 rename 的机会都不该有。
  await chmod(configDir(), 0o500)
  const outcome = await editConfig(append("added"))
  await chmod(configDir(), 0o700)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /原文件未改动|写入配置失败/)
  assert.equal(await readFile(jsonPath(), "utf8"), before, "原文件内容被改动了")
  assert.equal(await modeOf(jsonPath()), 0o640)
  assert.deepEqual(await leftovers(), [], "临时文件残留")
})

test("07. 成功写入后不留下临时文件", async () => {
  await writeConfig(["keep-me"], 0o600)
  await editConfig(append("added"))
  assert.deepEqual(await leftovers(), [])
})

test("08. 配置是符号链接时：链接仍是链接，被指向的文件才是被改的那个", async () => {
  const real = join(temp, "real-config.json")
  await writeFile(real, `${JSON.stringify({ plugins: ["keep-me"] }, null, 2)}\n`, "utf8")
  await chmod(real, 0o640)
  await symlink(real, jsonPath())

  const outcome = await editConfig(append("added"))
  assert.equal(outcome.ok, true, outcome.error)

  assert.equal((await lstat(jsonPath())).isSymbolicLink(), true, "符号链接被替换成了普通文件")
  const parsed = JSON.parse(await readFile(real, "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["keep-me", "added"])
  assert.equal(await modeOf(real), 0o640, "链接目标的权限没有保持")
})

// ---------------------------------------------------------------------------
// TASK-02: 外部并发修改
// ---------------------------------------------------------------------------

/** 读 → 算计划 → 已落临时文件；此时磁盘上是外部进程写的新内容。 */
async function stageThenEditExternally(external: string, mode = 0o600) {
  const file = await readConfig()
  const staged = await stageWrite(file, `${JSON.stringify({ plugins: [...file.raw, "from-hub"] }, null, 2)}\n`)
  await writeFile(jsonPath(), external, "utf8")
  await chmod(jsonPath(), mode)
  return staged
}

test("09. 临时文件已生成后外部改了配置：提交被拒绝，外部内容完整保留", async () => {
  await writeConfig(["keep-me"], 0o600)
  const external = `${JSON.stringify({ plugins: ["keep-me", "written-by-someone-else"] }, null, 2)}\n`
  const staged = await stageThenEditExternally(external)

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError, `期望并发错误，实际 ${String(error)}`)
    assert.match((error as Error).message, /被外部修改/)
    return true
  })
  assert.equal(await readFile(jsonPath(), "utf8"), external, "外部改动被覆盖了")
  assert.equal(await modeOf(jsonPath()), 0o600)
  assert.deepEqual(await leftovers(), [], "临时文件残留")
})

test("10. 外部只改了无关字段（theme）也拒绝：不做猜测性合并", async () => {
  await writeFile(jsonPath(), `${JSON.stringify({ theme: "dark", plugins: ["keep-me"] }, null, 2)}\n`, "utf8")
  await chmod(jsonPath(), 0o600)
  const external = `${JSON.stringify({ theme: "light", plugins: ["keep-me"] }, null, 2)}\n`
  const staged = await stageThenEditExternally(external)

  await assert.rejects(() => commitWrite(staged), ConcurrentEditError)
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { theme: string; plugins: string[] }
  assert.equal(parsed.theme, "light", "外部对 theme 的改动被回退了")
  assert.deepEqual(parsed.plugins, ["keep-me"])
})

test("11. 整个文件被替换成内容不同的一份：拒绝", async () => {
  await writeConfig(["keep-me"], 0o600)
  const external = `${JSON.stringify({ plugins: ["a", "b", "c"] }, null, 2)}\n`
  const staged = await stageThenEditExternally(external)

  await assert.rejects(() => commitWrite(staged), ConcurrentEditError)
  assert.equal(await readFile(jsonPath(), "utf8"), external)
})

test("12. 文件被替换成内容完全相同的一份：靠 inode 识别，仍然拒绝", async () => {
  await writeConfig(["keep-me"], 0o600)
  const file = await readConfig()
  const staged = await stageWrite(file, `${file.text.trimEnd()}${"\n"}`)
  const before = await stat(jsonPath())
  // 让替换用的文件先「活着」写好，再 rename 顶上去：两个同时存在的文件不可能共用一个 inode，
  // 所以这里一定是「另一个文件」。不能写成 unlink 之后再创建——Linux 会立刻复用刚释放的
  // inode 号，那样复现出来的其实是「同一个文件」，在 CI 上必然把这条用例误判成没检测到。
  const replacement = join(configDir(), "replacement.json")
  await writeFile(replacement, await readFile(jsonPath(), "utf8"), "utf8")
  await chmod(replacement, 0o600)
  await rename(replacement, jsonPath())
  assert.notEqual((await stat(jsonPath())).ino, before.ino, "替换用的文件复用了原 inode，用例前提不成立")

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError)
    // 内容相同，所以判定落在 inode 上。
    assert.match((error as Error).message, /被另一个文件替换|被外部修改/)
    return true
  })
})

test("13. 提交前原文件被删除：拒绝，不会凭空创建一份", async () => {
  await writeConfig(["keep-me"], 0o600)
  const file = await readConfig()
  const staged = await stageWrite(file, `${file.text.trimEnd()}\n`)
  await unlink(jsonPath())

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError)
    assert.match((error as Error).message, /被删除/)
    return true
  })
  assert.equal(await stat(jsonPath()).then(() => true, () => false), false, "插件中心把文件又建回来了")
})

test("14. 提交前原文件变成不可读：拒绝，并说明读不到", async () => {
  await writeConfig(["keep-me"], 0o600)
  const file = await readConfig()
  const staged = await stageWrite(file, `${file.text.trimEnd()}\n`)
  await chmod(jsonPath(), 0o000)

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError)
    assert.match((error as Error).message, /不可读|无法再次读取/)
    return true
  })
})

test("15. 没有外部干扰时，连续写入照常成功（并发保护不能误伤自己）", async () => {
  await writeConfig(["keep-me"], 0o600)
  for (const spec of ["one", "two", "three"]) {
    const outcome = await editConfig(append(spec))
    assert.equal(outcome.ok, true, outcome.error)
  }
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["keep-me", "one", "two", "three"])
  assert.equal(await modeOf(jsonPath()), 0o600)
})

test("16. 计划算完、写临时文件之前外部就改了：拒绝，且错误里提示刷新重试", async () => {
  await writeConfig(["keep-me"], 0o600)
  // plan 在队列内被调用：在这里同步改文件，等于「读完 → 算计划」之间被别人插了一刀。
  const outcome = await editConfig((file) => {
    const external = `${JSON.stringify({ plugins: ["external"] }, null, 2)}\n`
    // 用同步 API 模拟另一个写者，不经过插件中心的队列。
    writeFileSync(jsonPath(), external, "utf8")
    return [{ path: [file.key, file.raw.length], value: "from-hub" }]
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /外部修改|被另一个文件替换|请刷新后重新操作/)
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["external"], "外部内容被覆盖了")
})

test("17. 并发拒绝之后，重新读取再操作可以正常完成（不卡死、不复用旧计划）", async () => {
  await writeConfig(["keep-me"], 0o600)
  const external = `${JSON.stringify({ plugins: ["keep-me", "external"] }, null, 2)}\n`
  const staged = await stageThenEditExternally(external)
  await assert.rejects(() => commitWrite(staged), ConcurrentEditError)

  const retry = await editConfig(append("after-refresh"))
  assert.equal(retry.ok, true, retry.error)
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["keep-me", "external", "after-refresh"])
})

test("18. 权限保持和并发检查同时生效：并发拒绝时也不改动权限", async () => {
  await writeConfig(["keep-me"], 0o640)
  const external = `${JSON.stringify({ plugins: ["keep-me", "external"] }, null, 2)}\n`
  const staged = await stageThenEditExternally(external, 0o640)
  await assert.rejects(() => commitWrite(staged), ConcurrentEditError)
  assert.equal(await modeOf(jsonPath()), 0o640)
})

// ---------------------------------------------------------------------------
// TASK-01: 权限变化也是并发改动
//
// 前面几条覆盖「内容变了」。这里覆盖另一种外部改动：内容、inode 一动不动，
// 只有权限被改了。rename 会把临时文件的权限盖到原文件上，所以照样必须拒绝。
// ---------------------------------------------------------------------------

/** 读 → 算计划 → 已落临时文件；此时外部只 chmod，内容与 inode 都没动。 */
async function stageThenChmodExternally(mode: number) {
  const file = await readConfig()
  const staged = await stageWrite(file, `${JSON.stringify({ plugins: [...file.raw, "from-hub"] }, null, 2)}\n`)
  const before = await stat(jsonPath())
  await chmod(jsonPath(), mode)
  const after = await stat(jsonPath())
  assert.equal(after.ino, before.ino, "chmod 不该换 inode")
  assert.equal(after.dev, before.dev, "chmod 不该换设备号")
  return staged
}

test("19. 原文件 0600，临时文件生成后外部改成 0640：提交必须拒绝", async () => {
  await writeConfig(["keep-me"], 0o600)
  const staged = await stageThenChmodExternally(0o640)

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError, `期望并发错误，实际 ${String(error)}`)
    assert.match((error as Error).message, /配置权限在操作期间发生变化/)
    assert.match((error as Error).message, /0600/)
    assert.match((error as Error).message, /0640/)
    return true
  })
  // 外部把权限放宽了，那是外部的意思：内容不动，权限也不帮他改回去。
  assert.equal(await modeOf(jsonPath()), 0o640, "外部设置的权限被改回去了")
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["keep-me"], "外部内容被覆盖了")
  assert.deepEqual(await leftovers(), [], "临时文件残留")
})

test("20. 原文件 0640，临时文件生成后外部改成 0600：提交必须拒绝", async () => {
  await writeConfig(["keep-me"], 0o640)
  const staged = await stageThenChmodExternally(0o600)

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError)
    assert.match((error as Error).message, /配置权限在操作期间发生变化/)
    return true
  })
  // 收窄方向的改动同样不许被覆盖：写回去等于把一个人的安全加固又放宽了。
  assert.equal(await modeOf(jsonPath()), 0o600, "外部收紧的权限被放宽回去了")
  assert.deepEqual(await leftovers(), [], "临时文件残留")
})

test("21. 外部只改权限、内容与 inode 都不变，仍然必须识别", async () => {
  await writeConfig(["keep-me"], 0o600)
  const before = await stat(jsonPath())
  const textBefore = await readFile(jsonPath(), "utf8")
  const staged = await stageThenChmodExternally(0o640)
  const after = await stat(jsonPath())

  // 用例前提：除了 mode，别的什么都没变。所以判定只能落在权限上。
  assert.equal(await readFile(jsonPath(), "utf8"), textBefore, "内容被动过了，用例前提不成立")
  assert.equal(after.ino, before.ino)
  assert.equal(after.size, before.size)
  assert.equal(await modeOf(jsonPath()), 0o640)

  await assert.rejects(() => commitWrite(staged), (error: unknown) => {
    assert.ok(error instanceof ConcurrentEditError)
    assert.match((error as Error).message, /配置权限在操作期间发生变化/)
    assert.doesNotMatch((error as Error).message, /被外部修改|被另一个文件替换/)
    return true
  })
  assert.equal(await modeOf(jsonPath()), 0o640)
  assert.equal(await readFile(jsonPath(), "utf8"), textBefore)
  assert.deepEqual(await leftovers(), [], "临时文件残留")
})

test("22. 权限被外部改动时的用户可见提示：说明权限变了，并要求刷新后重新操作", async () => {
  await writeConfig(["keep-me"], 0o600)
  // plan 在队列内、读之后被调用：这里同步 chmod，等于「读完 → 落临时文件」之间被人改了权限。
  const outcome = await editConfig((file) => {
    chmodSync(jsonPath(), 0o640)
    return [{ path: [file.key, file.raw.length], value: "from-hub" }]
  })

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /权限在操作期间发生变化/)
  assert.match(outcome.error, /请刷新后重新操作/)
  // 不自动合并、不自动重试旧计划：磁盘上还是外部权限 + 原内容。
  assert.equal(await modeOf(jsonPath()), 0o640, "拒绝时把外部权限改掉了")
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["keep-me"], "拒绝时仍然写入了")
  assert.deepEqual(await leftovers(), [], "临时文件残留")
})

test("23. 权限并发拒绝之后，刷新再操作可以正常完成，权限沿用刷新后看到的那一份", async () => {
  await writeConfig(["keep-me"], 0o600)
  const staged = await stageThenChmodExternally(0o640)
  await assert.rejects(() => commitWrite(staged), ConcurrentEditError)

  const retry = await editConfig(append("after-refresh"))
  assert.equal(retry.ok, true, retry.error)
  const parsed = JSON.parse(await readFile(jsonPath(), "utf8")) as { plugins: string[] }
  assert.deepEqual(parsed.plugins, ["keep-me", "after-refresh"])
  assert.equal(await modeOf(jsonPath()), 0o640, "刷新后应沿用外部那一次的权限")
})
