/**
 * 重启快照采集器测试：注入假 ps / 假子进程枚举 / 假锁读取，验证 fail-closed
 * 的每条拒绝路径、启动上下文白名单与状态文件回读。不接触真实进程。
 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import * as admin from "../src/gui/admin.ts"
import {
  collectRestartSnapshot,
  parseProcLine,
  whitelistEnv,
  type CollectDeps,
  type ParsedProc,
} from "../src/gui/restart-collect.ts"

const APP_EXE = "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const SIDECAR_EXE =
  "/Users/meiyx/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli"
const APP_LSTART = "Sat Nov 15 18:24:15 2026"
const SC_LSTART = "Sat Nov 15 18:24:16 2026"

function proc(partial: Partial<ParsedProc> & { pid: number }): ParsedProc {
  return {
    ppid: partial.pid === 53046 ? 1 : 53046,
    uid: 501,
    lstart: partial.pid === 53046 ? APP_LSTART : SC_LSTART,
    comm: partial.pid === 53046 ? APP_EXE : SIDECAR_EXE,
    ...partial,
  }
}

function baseDeps(over: Partial<CollectDeps> = {}): CollectDeps {
  const table = new Map<number, ParsedProc>([
    [53046, proc({ pid: 53046 })],
    [53062, proc({ pid: 53062 })],
  ])
  return {
    platform: "darwin",
    procInfo: (pid) => table.get(pid) ?? null,
    childPids: () => [53062],
    self: {
      pid: 53046,
      ppid: 1,
      uid: 501,
      execPath: APP_EXE,
      argv: [APP_EXE],
      cwd: "/Users/meiyx",
    },
    env: { HOME: "/Users/meiyx", PATH: "/usr/bin" },
    lockPath: "/Users/meiyx/Library/Application Support/ai.opencode.desktop/SingletonLock",
    readLink: (path) => (path.endsWith("SingletonLock") ? "meiyxMac.local-53046" : null),
    runtimePath: "/usr/local/bin/node",
    statusPath: "/tmp/ph-test/status.json",
    requestId: "req-1",
    development: false,
    ...over,
  }
}

let temp = ""

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-restart-collect-"))
})
afterEach(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined)
})

test("证据齐全时产出监督载荷", () => {
  const result = collectRestartSnapshot(baseDeps())
  assert.ok(result.payload, result.message)
  assert.equal(result.message, "")
  const payload = result.payload!
  assert.equal(payload.requestId, "req-1")
  assert.equal(payload.app.pid, 53046)
  assert.equal(payload.app.lstart, APP_LSTART)
  assert.deepEqual(payload.app.argv, [APP_EXE])
  assert.equal(payload.app.cwd, "/Users/meiyx")
  assert.equal(payload.sidecar!.pid, 53062)
  assert.equal(payload.sidecar!.lstart, SC_LSTART)
  assert.equal(payload.lockPath!.endsWith("SingletonLock"), true)
  assert.ok(payload.timeouts.overallMs > 0)
})

test("ps 不可用（读不到自身身份凭据）：拒绝", () => {
  const result = collectRestartSnapshot(baseDeps({ procInfo: () => null }))
  assert.equal(result.payload, null)
  assert.match(result.message, /拒绝自动重启/)
})

test("ps 返回的 exe 与 process.execPath 矛盾：拒绝", () => {
  const deps = baseDeps()
  const result = collectRestartSnapshot({
    ...deps,
    procInfo: (pid) => (pid === 53046 ? proc({ pid, comm: "/usr/bin/something-else" }) : deps.procInfo(pid)),
  })
  assert.equal(result.payload, null)
  assert.match(result.message, /矛盾/)
})

test("ps 返回的 UID 与 process 不一致：拒绝", () => {
  const deps = baseDeps()
  const result = collectRestartSnapshot({
    ...deps,
    procInfo: (pid) => (pid === 53046 ? proc({ pid, uid: 0 }) : deps.procInfo(pid)),
  })
  assert.equal(result.payload, null)
  assert.match(result.message, /UID 不一致/)
})

test("缺少启动时间（进程实例凭据）：拒绝", () => {
  const deps = baseDeps()
  const result = collectRestartSnapshot({
    ...deps,
    procInfo: (pid) => (pid === 53046 ? proc({ pid, lstart: "" }) : deps.procInfo(pid)),
  })
  assert.equal(result.payload, null)
  assert.match(result.message, /实例凭据/)
})

test("当前进程不是 macOS .app 主进程：拒绝", () => {
  const deps = baseDeps()
  const result = collectRestartSnapshot({
    ...deps,
    procInfo: (pid) => (pid === 53046 ? proc({ pid, comm: "/usr/local/bin/node" }) : deps.procInfo(pid)),
    self: { ...deps.self, execPath: "/usr/local/bin/node" },
  })
  assert.equal(result.payload, null)
  assert.match(result.message, /桌面应用主进程/)
})

test("开发模式一律拒绝", () => {
  const result = collectRestartSnapshot(baseDeps({ development: true }))
  assert.equal(result.payload, null)
  assert.match(result.message, /开发模式/)
})

test("非 darwin 平台拒绝", () => {
  const result = collectRestartSnapshot(baseDeps({ platform: "linux" }))
  assert.equal(result.payload, null)
  assert.match(result.message, /macOS/)
})

test("无法枚举子进程：服务归属不明，拒绝", () => {
  const result = collectRestartSnapshot(baseDeps({ childPids: () => null }))
  assert.equal(result.payload, null)
  assert.match(result.message, /归属不明/)
})

test("没有 sidecar 候选：拒绝完整重启", () => {
  const result = collectRestartSnapshot(baseDeps({ childPids: () => [] }))
  assert.equal(result.payload, null)
  assert.match(result.message, /服务进程/)
})

test("多个 opencode-cli 子进程候选：归属不明，拒绝", () => {
  const deps = baseDeps()
  const result = collectRestartSnapshot({
    ...deps,
    childPids: () => [53062, 53063],
    procInfo: (pid) => (pid === 53063 ? proc({ pid: 53063 }) : deps.procInfo(pid)),
  })
  assert.equal(result.payload, null)
  assert.match(result.message, /归属不明/)
})

test("锁佐证 PID 与主进程不一致：规划器拒绝（锁不一致不作目标）", () => {
  const result = collectRestartSnapshot(baseDeps({ readLink: () => "meiyxMac.local-99999" }))
  assert.equal(result.payload, null)
  assert.match(result.message, /SingletonLock/)
})

test("锁路径未知时不阻断判定，载荷如实记录 null", () => {
  const result = collectRestartSnapshot(baseDeps({ lockPath: null }))
  assert.ok(result.payload)
  assert.equal(result.payload!.lockPath, null)
})

test("环境变量白名单：XDG_/OPENCODE_ 前缀与基础键保留，凭据不进入载荷", () => {
  const result = collectRestartSnapshot(
    baseDeps({
      env: {
        HOME: "/Users/meiyx",
        PATH: "/usr/bin",
        XDG_CACHE_HOME: "/tmp/cache",
        OPENCODE_PLUGIN_HUB_REGISTRY: "http://plugin-hub.test",
        GITHUB_TOKEN: "gh_secret",
        AWS_SECRET_ACCESS_KEY: "nope",
      },
    }),
  )
  const env = result.payload!.env
  assert.equal(env.HOME, "/Users/meiyx")
  assert.equal(env.XDG_CACHE_HOME, "/tmp/cache")
  assert.equal(env.OPENCODE_PLUGIN_HUB_REGISTRY, "http://plugin-hub.test")
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
})

test("ps 行解析：完整字段与脏数据", () => {
  const parsed = parseProcLine(
    "  53062 53046  501 Sat Nov 15 18:24:16 2026 /Users/meiyx/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli",
  )
  assert.ok(parsed)
  assert.equal(parsed!.pid, 53062)
  assert.equal(parsed!.ppid, 53046)
  assert.equal(parsed!.uid, 501)
  assert.equal(parsed!.lstart, "Sat Nov 15 18:24:16 2026")
  assert.ok(parsed!.comm.endsWith("/opencode-cli"))
  assert.equal(parseProcLine("nope"), null)
  assert.equal(parseProcLine("abc def ghi jkl"), null)
})

test("环境变量白名单函数：基础键与前缀族保留", () => {
  const picked = whitelistEnv({
    HOME: "/h",
    TMPDIR: "/t",
    SHELL: "/bin/zsh",
    XDG_CONFIG_HOME: "/c",
    OPENCODE_FOO: "1",
    RANDOM_TOKEN: "x",
  })
  assert.deepEqual(picked, { HOME: "/h", TMPDIR: "/t", SHELL: "/bin/zsh", XDG_CONFIG_HOME: "/c", OPENCODE_FOO: "1" })
})

// ---------------------------------------------------------------------------
// admin.restartStatus()：监督流程结果的状态文件回读
// ---------------------------------------------------------------------------

test("restartStatus：读到记录 / 无记录 / 坏记录都如实报告", async () => {
  const cacheHome = join(temp, "cache")
  await mkdir(join(cacheHome, "opencode", "plugin-hub"), { recursive: true })
  process.env.XDG_CACHE_HOME = cacheHome
  try {
    const missing = await admin.restartStatus()
    assert.equal(missing.found, false)

    const statusPath = join(cacheHome, "opencode", "plugin-hub", "restart-status.json")
    await writeFile(
      statusPath,
      JSON.stringify({ requestId: "req-9", phase: "new-started", at: 1234, detail: "pid:123" }),
    )
    const found = await admin.restartStatus()
    assert.equal(found.found, true)
    assert.deepEqual(found.status, { requestId: "req-9", phase: "new-started", at: 1234, detail: "pid:123" })

    await writeFile(statusPath, "not json at all {{{")
    assert.equal((await admin.restartStatus()).found, false)
  } finally {
    if (process.env.XDG_CACHE_HOME === cacheHome) delete process.env.XDG_CACHE_HOME
  }
})

test("restartStatus 记录过旧时由页面负责判龄（文件本身完整保留）", async () => {
  const cacheHome = join(temp, "cache2")
  await mkdir(join(cacheHome, "opencode", "plugin-hub"), { recursive: true })
  process.env.XDG_CACHE_HOME = cacheHome
  try {
    const statusPath = join(cacheHome, "opencode", "plugin-hub", "restart-status.json")
    await writeFile(statusPath, JSON.stringify({ requestId: "old", phase: "failed", at: 1, detail: "x" }))
    const found = await admin.restartStatus()
    assert.equal(found.found, true)
    assert.equal(found.status!.at, 1)
    const raw = JSON.parse(await readFile(statusPath, "utf8")) as { phase: string }
    assert.equal(raw.phase, "failed")
  } finally {
    if (process.env.XDG_CACHE_HOME === cacheHome) delete process.env.XDG_CACHE_HOME
  }
})

// ---------------------------------------------------------------------------
// admin.restart()：在本环境（无 ps、非 .app 主进程）必须 fail-closed
// ---------------------------------------------------------------------------

test("restart 在开发模式下拒绝且不发送任何信号", async () => {
  const result = await admin.restart(true)
  assert.equal(result.ok, false)
  assert.equal(result.phase, "refused")
  assert.match(result.message, /开发模式/)
})

test("restart 在无法读取进程身份的环境（如受限沙箱）fail-closed", async () => {
  // 本测试环境的 ps 被沙箱拒绝或 execPath 不是 .app 主进程：无论哪条路径，
  // 结果都必须是拒绝且不带 payload。
  const result = await admin.restart(false)
  assert.equal(result.ok, false)
  assert.equal(result.phase, "refused")
  assert.ok(result.message.length > 0)
})
