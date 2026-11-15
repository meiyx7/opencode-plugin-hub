/**
 * 重启状态文件与监督进程启动器测试（TASK-1/2/3 的自动化覆盖）：
 *  - 状态目录创建时序（同步创建先于首次写入，失败不得误报 accepted）；
 *  - supervisor spawn 的成功判定（只有真实 spawn 事件才算启动成功；
 *    error 与 settle 超时一律 failed，pid 存在不等于启动成功）；
 *  - 状态文件按实例隔离（user-data-dir 派生路径，两个实例互不覆盖）。
 * 全部使用临时目录与假 spawn，不接触真实进程、不发信号。
 */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  instanceStatusPath,
  launchRestartSupervisor,
  writeRestartStatusFile,
  type SpawnedChild,
} from "../src/gui/restart-launch.ts"

// ---------------------------------------------------------------------------
// 假 spawn：可编排 pid、异步 error、spawn 事件与迟到事件
// ---------------------------------------------------------------------------

type Listener = (...args: never[]) => void

class FakeChild implements SpawnedChild {
  pid: number | undefined
  unrefd = false
  private listeners = new Map<string, Listener[]>()

  constructor(private options: { pid?: number; asyncError?: Error; asyncErrorDelayMs?: number }) {
    this.pid = options.pid
  }

  on(event: string, listener: Listener): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  unref(): void {
    this.unrefd = true
  }

  listenersOf(event: string): Listener[] {
    return this.listeners.get(event) ?? []
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  /** 测试辅助：按编排延迟触发异步 error（模拟真实 spawn 失败的时序）。 */
  fire(): void {
    if (!this.options.asyncError) return
    const raise = () => this.emit("error", this.options.asyncError as never)
    if (this.options.asyncErrorDelayMs) setTimeout(raise, this.options.asyncErrorDelayMs)
    else setTimeout(raise, 0)
  }
}

interface Harness {
  children: FakeChild[]
  spawnCalls: { exe: string; args: readonly string[]; options: Record<string, unknown> }[]
  baseDir: string
  statusPath: string
  launch(options?: Partial<Parameters<typeof launchRestartSupervisor>[0]>): ReturnType<typeof launchRestartSupervisor>
}

let counter = 0

async function harness(
  childSetup: (child: FakeChild) => void = (child) => setTimeout(() => child.emit("spawn"), 5),
): Promise<Harness> {
  const baseDir = join(tmpdir(), `ph-launch-test-${process.pid}-${Date.now()}-${counter++}`)
  const statusPath = join(baseDir, "restart-status-abc.json")
  const children: FakeChild[] = []
  const spawnCalls: Harness["spawnCalls"] = []
  const spawnChild = (exe: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new FakeChild({ pid: 4242 })
    childSetup(child)
    children.push(child)
    spawnCalls.push({ exe, args, options })
    child.fire()
    return child
  }
  const launch = (over: Partial<Parameters<typeof launchRestartSupervisor>[0]> = {}) =>
    launchRestartSupervisor({
      runtimePath: "/usr/local/bin/node",
      source: "// supervisor source",
      payload: { requestId: "req-1" },
      statusPath,
      requestId: "req-1",
      env: { PATH: "/usr/bin:/bin" },
      spawnChild,
      settleMs: 50,
      ...over,
    })
  return { children, spawnCalls, baseDir, statusPath, launch }
}

const readStatus = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>

// ---------------------------------------------------------------------------
// TASK-3：实例隔离的路径规则
// ---------------------------------------------------------------------------

test("instanceStatusPath：无法确定实例身份时返回 null（fail-closed，不得共享路径）", () => {
  assert.equal(instanceStatusPath(null, "/tmp/base"), null)
  assert.equal(instanceStatusPath("", "/tmp/base"), null)
  assert.equal(instanceStatusPath(undefined as unknown as string, "/tmp/base"), null)
})

test("instanceStatusPath：同一实例稳定，不同实例互不相同，路径不含 PID", () => {
  const a1 = instanceStatusPath("/Users/me/Library/Application Support/ai.opencode.desktop", "/tmp/base")
  const a2 = instanceStatusPath("/Users/me/Library/Application Support/ai.opencode.desktop", "/tmp/base")
  const b = instanceStatusPath("/tmp/opencode-test-profile", "/tmp/base")
  assert.ok(a1 && a2 && b)
  assert.equal(a1, a2, "同一 user-data-dir 必须得到同一个状态文件")
  assert.notEqual(a1, b, "不同 user-data-dir 必须得到不同状态文件")
  assert.match(a1, /^\/tmp\/base\/restart-status-[0-9a-f]{16}\.json$/)
  assert.ok(!a1.includes("53062"), "PID 不得出现在状态文件名中")
})

test("instanceStatusPath：路径中的特殊字符不影响结果稳定（哈希派生）", () => {
  const p1 = instanceStatusPath("/tmp/we ird 'dir'/数据", "/tmp/base")
  const p2 = instanceStatusPath("/tmp/we ird 'dir'/数据", "/tmp/base")
  assert.ok(p1 && p2)
  assert.equal(p1, p2)
  assert.match(p1, /^\/tmp\/base\/restart-status-[0-9a-f]{16}\.json$/)
})

test("两个实例同时写状态：各自文件完整，互不覆盖", async () => {
  const baseDir = join(tmpdir(), `ph-iso-${process.pid}-${Date.now()}`)
  const pathA = instanceStatusPath("/tmp/instance-A", baseDir)!
  const pathB = instanceStatusPath("/tmp/instance-B", baseDir)!
  assert.notEqual(pathA, pathB)
  // 交错写入，模拟两个实例几乎同时发起重启
  writeRestartStatusFile(pathA, { requestId: "req-A", phase: "accepted", at: 1, detail: "a-accepted" })
  writeRestartStatusFile(pathB, { requestId: "req-B", phase: "accepted", at: 2, detail: "b-accepted" })
  writeRestartStatusFile(pathA, { requestId: "req-A", phase: "new-started", at: 3, detail: "a-done" })
  writeRestartStatusFile(pathB, { requestId: "req-B", phase: "failed", at: 4, detail: "b-failed" })
  const a = await readStatus(pathA)
  const b = await readStatus(pathB)
  assert.equal(a.requestId, "req-A")
  assert.equal(a.phase, "new-started")
  assert.equal(b.requestId, "req-B")
  assert.equal(b.phase, "failed")
})

// ---------------------------------------------------------------------------
// TASK-1：状态目录创建时序
// ---------------------------------------------------------------------------

test("首次运行且目录不存在：同步创建目录后写入成功", async () => {
  const h = await harness()
  const nested = join(h.baseDir, "deep", "nested", "restart-status.json")
  const result = await h.launch({ statusPath: nested })
  assert.equal(result.phase, "accepted")
  const record = await readStatus(nested)
  assert.equal(record.phase, "accepted")
  assert.equal(record.requestId, "req-1")
})

test("状态目录创建失败：抛错并返回 failed，不得误报 accepted，且不 spawn", async () => {
  const blockDir = join(tmpdir(), `ph-block-${process.pid}-${Date.now()}`)
  await mkdir(blockDir, { recursive: true })
  // 用一个“文件”占住目录位置，使 nested mkdir 必然失败
  await writeFile(join(blockDir, "occupied"), "not a directory")
  const statusPath = join(blockDir, "occupied", "sub", "restart-status.json")
  const h = await harness()
  const result = await h.launch({ statusPath })
  assert.equal(result.phase, "failed")
  assert.equal(result.ok, false)
  assert.match(result.message, /无法写入重启状态文件/)
  assert.equal(h.spawnCalls.length, 0, "状态写不进去就不允许启动监督流程")
})

// ---------------------------------------------------------------------------
// TASK-2：supervisor spawn 的异步错误处理
// ---------------------------------------------------------------------------

test("spawn 异步 error（ENOENT）：phase=failed，状态文件写入准确的 failed 记录", async () => {
  const h = await harness((child) => {
    child.pid = undefined
    child.options.asyncError = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })
  })
  const result = await h.launch()
  assert.equal(result.phase, "failed")
  assert.equal(result.ok, false)
  assert.match(result.message, /ENOENT/)
  const record = await readStatus(h.statusPath)
  assert.equal(record.phase, "failed")
  assert.equal(record.detail, "supervisor-spawn-error:ENOENT")
  assert.equal(record.requestId, "req-1")
  assert.equal(h.children[0]!.unrefd, false, "失败的 spawn 不得 unref")
})

test("延迟触发的异步 error 同样被捕获", async () => {
  const h = await harness((child) => {
    child.options.asyncError = new Error("late failure")
    child.options.asyncErrorDelayMs = 10
  })
  const result = await h.launch({ settleMs: 200 })
  assert.equal(result.phase, "failed")
  assert.match(result.message, /late failure/)
  const record = await readStatus(h.statusPath)
  assert.equal(record.phase, "failed")
})

test("spawn 成功（spawn 事件）：accepted，状态文件为 accepted，并 unref", async () => {
  const h = await harness((child) => {
    setTimeout(() => child.emit("spawn"), 5)
  })
  const result = await h.launch()
  assert.equal(result.phase, "accepted")
  assert.equal(result.ok, true)
  const record = await readStatus(h.statusPath)
  assert.equal(record.phase, "accepted")
  assert.equal(record.detail, "supervisor-launched")
  assert.equal(h.children[0]!.unrefd, true)
})

test("超时且 child.pid 存在：未收到 spawn 事件不得报 accepted，必须 failed", async () => {
  const h = await harness(() => {}) // pid=4242 存在，但 spawn/error 事件都不来
  const result = await h.launch({ settleMs: 30 })
  assert.equal(result.phase, "failed")
  assert.equal(result.ok, false)
  assert.match(result.message, /限定时间内确认启动/)
  const record = await readStatus(h.statusPath)
  assert.equal(record.phase, "failed")
  assert.equal(record.detail, "supervisor-spawn-error:settle-timeout")
  assert.equal(h.children[0]!.unrefd, false, "未确认启动不得 unref")
})

test("超时且没有 child.pid：同样 failed（settle-timeout）", async () => {
  const h = await harness((child) => {
    child.pid = undefined
  })
  const result = await h.launch({ settleMs: 20 })
  assert.equal(result.phase, "failed")
  const record = await readStatus(h.statusPath)
  assert.equal(record.phase, "failed")
  assert.equal(record.detail, "supervisor-spawn-error:settle-timeout")
})

test("超时 failed 之后迟到的 error：不覆盖已有 failed 记录，也不崩溃", async () => {
  const h = await harness((child) => {
    setTimeout(() => child.emit("error", new Error("late after timeout") as never), 60)
  })
  const result = await h.launch({ settleMs: 20 })
  assert.equal(result.phase, "failed")
  await new Promise((resolve) => setTimeout(resolve, 80))
  const record = await readStatus(h.statusPath)
  assert.equal(record.detail, "supervisor-spawn-error:settle-timeout", "迟到事件不得改写最终状态")
})

test("spawn 事件已发生但拿不到 pid（契约被破坏）：仍 fail-closed", async () => {
  const h = await harness((child) => {
    child.pid = undefined
    setTimeout(() => child.emit("spawn"), 5)
  })
  const result = await h.launch()
  assert.equal(result.phase, "failed")
  const record = await readStatus(h.statusPath)
  assert.equal(record.detail, "supervisor-spawn-error:no-pid")
})

test("spawn 同步抛错：failed，状态文件写入 failed，不再有第二次 spawn", async () => {
  const baseDir = join(tmpdir(), `ph-sync-throw-${process.pid}-${Date.now()}`)
  const statusPath = join(baseDir, "restart-status.json")
  const spawnCalls: unknown[] = []
  const spawnChild = () => {
    spawnCalls.push(1)
    throw new Error("boom")
  }
  const result = await launchRestartSupervisor({
    runtimePath: "/usr/local/bin/node",
    source: "// src",
    payload: {},
    statusPath,
    requestId: "req-2",
    env: {},
    spawnChild,
  })
  assert.equal(result.phase, "failed")
  assert.match(result.message, /boom/)
  assert.equal(spawnCalls.length, 1)
  const record = await readStatus(statusPath)
  assert.equal(record.phase, "failed")
  assert.equal(record.detail, "supervisor-spawn-error:boom")
})

test("accepted 记录写入失败：直接 failed，不 spawn、不写 accepted", async () => {
  const h = await harness()
  const result = await h.launch({
    statusPath: h.statusPath,
    writeStatusFile: (path, record) => {
      if (record.phase === "accepted") throw new Error("disk full")
      writeRestartStatusFile(path, record)
    },
  })
  assert.equal(result.phase, "failed")
  assert.match(result.message, /disk full/)
  assert.equal(h.spawnCalls.length, 0)
})

test("accepted 之后迟到的 error 事件：不再覆盖状态文件，也不崩溃", async () => {
  const h = await harness((child) => {
    setTimeout(() => child.emit("spawn"), 5)
    setTimeout(() => child.emit("error", new Error("should be ignored") as never), 30)
  })
  const result = await h.launch({ settleMs: 100 })
  assert.equal(result.phase, "accepted")
  // 等迟到的 error 事件飞一会儿
  await new Promise((resolve) => setTimeout(resolve, 60))
  const record = await readStatus(h.statusPath)
  assert.equal(record.phase, "accepted", "迟到 error 不得覆盖已确立的状态")
})

test("不监听 close/exit：监督进程退出是其正常完成方式，不据此误报", async () => {
  const h = await harness()
  await h.launch()
  const child = h.children[0]!
  assert.deepEqual(Object.keys(child.listenersOf("close")), [])
  assert.deepEqual(Object.keys(child.listenersOf("exit")), [])
  assert.ok(child.listenersOf("error").length > 0, "error 事件必须有监听，否则会崩溃主进程")
  assert.ok(child.listenersOf("spawn").length > 0)
})

test("launch 传给 spawn 的参数形态：detached、stdio ignore、白名单环境", async () => {
  const h = await harness()
  await h.launch({ env: { PATH: "/usr/bin:/bin", HOME: "/Users/x" } })
  const call = h.spawnCalls[0]!
  assert.equal(call.exe, "/usr/local/bin/node")
  assert.deepEqual(call.args.slice(0, 2), ["-e", "// supervisor source"])
  assert.equal(call.args[2], "run")
  assert.deepEqual(call.options, { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: "/Users/x" } })
})
