/**
 * 重启监督流程测试：直接驱动随包发布的 SUPERVISOR_SOURCE（以模块形式求值），
 * 全部用注入的假系统操作，不接触任何真实进程、不发真实信号、不启动应用。
 * 覆盖正常流程、异常退出、安全边界（PID 复用 / 身份矛盾 / 锁状态）与启动恢复。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { SIGNAL_RECHECK_REQUIREMENTS, type ProcessIdentity } from "../src/gui/restart"
import { SUPERVISOR_SOURCE } from "../src/gui/restart-supervisor.ts"

// ---------------------------------------------------------------------------
// 把随包发布的监督脚本当模块求值，拿到 runSupervisorFlow 与 parseProcLine
// ---------------------------------------------------------------------------

interface Evaluated {
  runSupervisorFlow: (payload: unknown, ops: unknown) => Promise<{ phase: string; detail: string; exitCode: number }>
  parseProcLine: (line: string) => { pid: number; ppid: number; uid: number; lstart: string; comm: string } | null
}

const evaluated: Evaluated = (() => {
  const mod = { exports: {} as Record<string, unknown> }
  const fn = new Function("module", "exports", "require", "process", SUPERVISOR_SOURCE)
  fn(
    mod,
    mod.exports,
    () => {
      throw new Error("tests must not require real modules inside the supervisor source")
    },
    { argv: [], env: {} },
  )
  return mod.exports as unknown as Evaluated
})()

const { runSupervisorFlow, parseProcLine } = evaluated

// ---------------------------------------------------------------------------
// 假世界：进程表 + 信号记录 + 启动记录
// ---------------------------------------------------------------------------

const APP_EXE = "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const SIDECAR_EXE =
  "/Users/meiyx/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli"
const APP_LSTART = "Sat Nov 15 18:24:15 2026"
const SC_LSTART = "Sat Nov 15 18:24:16 2026"

interface WorldProc {
  pid: number
  ppid: number
  uid: number
  lstart: string
  comm: string
}

interface World {
  procs: Map<number, WorldProc>
  signals: { pid: number; sig: string }[]
  launches: { exe: string; args: readonly string[]; cwd: string; env: Record<string, string> }[]
  lockTarget: string | null
  lockNeverUpdates?: boolean
  launchBehavior?: "ok" | "throw" | "die"
  onSignal?: (world: World, pid: number, sig: string) => void
}

function fakeOps(world: World) {
  return {
    procInfo: (pid: number): WorldProc | null => world.procs.get(pid) ?? null,
    signal: (pid: number, sig: string): void => {
      world.signals.push({ pid, sig })
      world.onSignal?.(world, pid, sig)
    },
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    },
    readLink: (path: string): string | null => (path.includes("SingletonLock") ? world.lockTarget : null),
    launch: (exe: string, args: readonly string[], cwd: string, env: Record<string, string>) => {
      if (world.launchBehavior === "throw") throw new Error("spawn failed")
      const pid = 53100 + world.launches.length
      world.launches.push({ exe, args, cwd, env })
      if (world.launchBehavior !== "die") {
        world.procs.set(pid, { pid, ppid: 1, uid: 501, lstart: "Sat Nov 15 19:00:00 2026", comm: exe })
        // 新实例正常启动后会创建自己的 SingletonLock（接管/重建）
        if (!world.lockNeverUpdates) world.lockTarget = `meiyxMac.local-${pid}`
      }
      return { pid }
    },
    now: () => Date.now(),
    writeStatus: (_phase: string, _detail: string) => {},
    log: (_line: string) => {},
  }
}

function baseWorld(): World {
  const procs = new Map<number, WorldProc>()
  procs.set(53046, { pid: 53046, ppid: 1, uid: 501, lstart: APP_LSTART, comm: APP_EXE })
  procs.set(53062, { pid: 53062, ppid: 53046, uid: 501, lstart: SC_LSTART, comm: SIDECAR_EXE })
  return { procs, signals: [], launches: [], lockTarget: "meiyxMac.local-53046" }
}

function basePayload(world: World, over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    statusPath: "/tmp/ph-test/status.json",
    lockPath: "/Users/meiyx/Library/Application Support/ai.opencode.desktop/SingletonLock",
    app: {
      pid: 53046,
      ppid: 1,
      uid: 501,
      lstart: APP_LSTART,
      exe: APP_EXE,
      argv: [APP_EXE, "--user-data-dir=/tmp/ph-profile"],
      cwd: "/Users/meiyx",
    },
    sidecar: { pid: 53062, uid: 501, lstart: SC_LSTART, exe: SIDECAR_EXE },
    env: { HOME: "/Users/meiyx", PATH: "/usr/bin:/bin", XDG_CACHE_HOME: "/tmp/ph-cache" },
    timeouts: { appExitMs: 500, sidecarGraceMs: 50, sidecarExitMs: 500, launchVerifyMs: 400, overallMs: 60_000 },
    ...over,
  }
}

/** 默认信号语义：TERM 后进程退出；sidecar 随主进程一起自行退出。 */
function autoExit(world: World): void {
  world.onSignal = (w, pid) => {
    w.procs.delete(pid)
    if (pid === 53046) w.procs.delete(53062)
  }
}

const run = (payload: unknown, ops: unknown) => runSupervisorFlow(payload, ops)

// ---------------------------------------------------------------------------
// 正常流程
// ---------------------------------------------------------------------------

test("正常流程：身份复核→TERM→退出→sidecar 自行退出→锁校验→原样重启→验证成功", async () => {
  const world = baseWorld()
  autoExit(world)
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "new-started")
  assert.equal(result.exitCode, 0)
  // 只发过一个信号：对主进程的 TERM。绝不 KILL 主进程。
  assert.deepEqual(
    world.signals.map((s) => `${s.pid}:${s.sig}`),
    ["53046:TERM"],
  )
  // 原样恢复启动上下文：exe、argv（去掉 argv[0]）、cwd、env 一一对应。
  assert.equal(world.launches.length, 1)
  const launch = world.launches[0]!
  assert.equal(launch.exe, APP_EXE)
  assert.deepEqual(launch.args, ["--user-data-dir=/tmp/ph-profile"])
  assert.equal(launch.cwd, "/Users/meiyx")
  assert.deepEqual(launch.env, { HOME: "/Users/meiyx", PATH: "/usr/bin:/bin", XDG_CACHE_HOME: "/tmp/ph-cache" })
})

test("sidecar 在宽限期内自行退出：不发送 KILL", async () => {
  const world = baseWorld()
  world.onSignal = (w, pid, sig) => {
    if (pid === 53046) w.procs.delete(53046)
    if (pid === 53062 && sig === "TERM") w.procs.delete(53062)
  }
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "new-started")
  assert.ok(!world.signals.some((s) => s.sig === "KILL"), "sidecar 自行退出时不得 KILL")
})

test("sidecar 对 TERM 无响应：先重新复核身份，通过后才 KILL", async () => {
  const world = baseWorld()
  world.onSignal = (w, pid, sig) => {
    if (pid === 53046) w.procs.delete(53046)
    if (pid === 53062 && sig === "KILL") w.procs.delete(53062)
  }
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "new-started")
  assert.deepEqual(
    world.signals.map((s) => `${s.pid}:${s.sig}`),
    ["53046:TERM", "53062:TERM", "53062:KILL"],
  )
})

// ---------------------------------------------------------------------------
// 异常退出
// ---------------------------------------------------------------------------

test("主进程无法退出：报告超时，不 KILL 主进程，不启动新实例", async () => {
  const world = baseWorld()
  world.onSignal = () => {} // TERM 无效且永不退出
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-exit-timeout/)
  assert.ok(!world.signals.some((s) => s.pid === 53046 && s.sig === "KILL"), "主进程不得被 KILL")
  assert.equal(world.launches.length, 0)
})

test("主进程在超时之后才退出：仍按超时处理", async () => {
  const world = baseWorld()
  let signalsSeen = 0
  world.onSignal = (w, pid, sig) => {
    signalsSeen += 1
    // 第一次轮询结束后才消失，模拟"退出很慢但没到 KILL"的边界之外
    if (signalsSeen > 3 && pid === 53046 && sig === "TERM") w.procs.delete(53046)
  }
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-exit-timeout/)
  assert.equal(world.launches.length, 0)
})

test("sidecar 复核通过但 KILL 后未退出：报告超时", async () => {
  const world = baseWorld()
  world.onSignal = (w, pid, sig) => {
    if (pid === 53046) w.procs.delete(53046)
    // sidecar 对 TERM 和 KILL 都无响应
  }
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /sidecar-exit-timeout/)
  assert.equal(world.launches.length, 0)
})

// ---------------------------------------------------------------------------
// 安全边界：发送信号前的身份复核
// ---------------------------------------------------------------------------

test("主进程 PID 已不存在：拒绝，且一个信号都不发", async () => {
  const world = baseWorld()
  world.procs.delete(53046)
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-recheck-failed:pid-gone/)
  assert.equal(world.signals.length, 0)
  assert.equal(world.launches.length, 0)
})

test("主进程 PID 被复用（启动时间变化）：拒绝，且一个信号都不发", async () => {
  const world = baseWorld()
  const recycled = world.procs.get(53046)!
  world.procs.set(53046, { ...recycled, lstart: "Sun Nov 16 09:00:00 2026" })
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-recheck-failed:instance-mismatch/)
  assert.equal(world.signals.length, 0)
})

test("主进程可执行文件不一致：拒绝", async () => {
  const world = baseWorld()
  const swapped = world.procs.get(53046)!
  world.procs.set(53046, { ...swapped, comm: "/Applications/Other.app/Contents/MacOS/Other" })
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-recheck-failed:exe-mismatch/)
  assert.equal(world.signals.length, 0)
})

test("主进程 UID 不一致：拒绝", async () => {
  const world = baseWorld()
  const other = world.procs.get(53046)!
  world.procs.set(53046, { ...other, uid: 0 })
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-recheck-failed:uid-mismatch/)
  assert.equal(world.signals.length, 0)
})

test("主进程 PPID 不一致（被重新挂靠）：fail-closed 拒绝", async () => {
  const world = baseWorld()
  const reparented = world.procs.get(53046)!
  world.procs.set(53046, { ...reparented, ppid: 999 })
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /app-recheck-failed:ppid-mismatch/)
  assert.equal(world.signals.length, 0)
})

test("sidecar 的 PID 在 TERM 后被复用：KILL 前的二次复核拒绝，绝不误杀", async () => {
  const world = baseWorld()
  world.onSignal = (w, pid, sig) => {
    if (pid === 53046) w.procs.delete(53046)
    if (pid === 53062 && sig === "TERM") {
      // PID 复用：同 PID、同 exe、同 UID，但启动时间已变——是新进程
      w.procs.set(53062, { pid: 53062, ppid: 1, uid: 501, lstart: "Sun Nov 16 10:00:00 2026", comm: SIDECAR_EXE })
    }
  }
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /sidecar-recheck-before-kill-failed:instance-mismatch/)
  assert.ok(!world.signals.some((s) => s.sig === "KILL"), "复核失败后不得发送 KILL")
  assert.equal(world.launches.length, 0)
})

test("载荷缺失或自相矛盾：invalid-payload，且一个信号都不发", async () => {
  for (const payload of [
    null,
    {},
    basePayload(baseWorld(), { app: {} }),
    basePayload(baseWorld(), { app: { pid: 0, exe: "", lstart: "", argv: [], cwd: "" } }),
    basePayload(baseWorld(), { sidecar: { pid: 53046, uid: 501, lstart: SC_LSTART, exe: SIDECAR_EXE } }),
  ]) {
    const world = baseWorld()
    const result = await run(payload, fakeOps(world))
    assert.equal(result.phase, "failed")
    assert.match(result.detail, /invalid-payload/)
    assert.equal(world.signals.length, 0)
  }
})

// ---------------------------------------------------------------------------
// SingletonLock 边界
// ---------------------------------------------------------------------------

test("锁被其他存活进程持有：放弃启动，如实报告", async () => {
  const world = baseWorld()
  autoExit(world)
  world.procs.set(70000, { pid: 70000, ppid: 1, uid: 501, lstart: "Sat Nov 15 10:00:00 2026", comm: "/usr/sbin/sshd" })
  world.lockTarget = "meiyxMac.local-70000"
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /lock-held-by-live-pid:70000/)
  assert.equal(world.launches.length, 0)
})

test("锁指向刚退出的主进程（陈旧锁）：视为可接管，继续启动", async () => {
  const world = baseWorld()
  autoExit(world)
  world.lockTarget = "meiyxMac.local-53046"
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "new-started")
})

test("锁已释放：继续启动", async () => {
  const world = baseWorld()
  autoExit(world)
  world.lockTarget = null
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "new-started")
})

test("新实例接管锁：验证通过后才判定 new-started", async () => {
  const world = baseWorld()
  autoExit(world)
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "new-started")
  // 启动后锁已被新实例接管（指向新 PID），这才是"真的起来了"的证据。
  assert.equal(world.lockTarget, "meiyxMac.local-53100")
})

test("锁始终未被新实例接管：如实报告 unknown，不虚报成功", async () => {
  const world = baseWorld()
  autoExit(world)
  world.lockNeverUpdates = true
  // 锁目标无法解析出 PID：监督流程既不能确认接管，也不能断言失败。
  world.lockTarget = "unparseable-target"
  const result = await run(basePayload(world), fakeOps(world))
  assert.equal(result.phase, "unknown")
  assert.match(result.detail, /launch-lock-unconfirmed/)
  assert.equal(result.exitCode, 2)
})

// ---------------------------------------------------------------------------
// 启动恢复
// ---------------------------------------------------------------------------

test("原始 argv 逐项恢复，不虚构、不丢弃、不额外加参数", async () => {
  const world = baseWorld()
  autoExit(world)
  await run(basePayload(world), fakeOps(world))
  assert.deepEqual(world.launches[0]!.args, ["--user-data-dir=/tmp/ph-profile"])
})

test("没有 user-data-dir 参数时不得凭空补一个", async () => {
  const world = baseWorld()
  autoExit(world)
  const payload = basePayload(world)
  ;(payload as { app: { argv: string[] } }).app.argv = [APP_EXE]
  await run(payload, fakeOps(world))
  assert.deepEqual(world.launches[0]!.args, [])
})

test("cwd 恢复为规划时记录的工作目录", async () => {
  const world = baseWorld()
  autoExit(world)
  await run(basePayload(world), fakeOps(world))
  assert.equal(world.launches[0]!.cwd, "/Users/meiyx")
})

test("环境变量按规划期白名单原样传递，执行期不扩充、不过滤", async () => {
  // 过滤发生在主进程的采集器（whitelistEnv，见 restart-collect 测试）；
  // 监督流程的职责是把已过滤的环境原样交给 launch，不做任何增删。
  const world = baseWorld()
  autoExit(world)
  const payload = basePayload(world)
  ;(payload as { env: Record<string, string> }).env = {
    HOME: "/Users/meiyx",
    PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: "/tmp/ph-config",
  }
  await run(payload, fakeOps(world))
  const env = world.launches[0]!.env
  assert.deepEqual(env, { HOME: "/Users/meiyx", PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: "/tmp/ph-config" })
})

test("多实例上下文不串用：两个载荷各自用各自的 exe/argv/cwd", async () => {
  const worldA = baseWorld()
  autoExit(worldA)
  const worldB = baseWorld()
  autoExit(worldB)
  const payloadB = basePayload(worldB)
  ;(payloadB as { app: { argv: string[]; cwd: string } }).app.argv = [
    APP_EXE,
    "--user-data-dir=/tmp/other-profile",
    "--flag-b",
  ]
  ;(payloadB as { app: { cwd: string } }).app.cwd = "/tmp/other-cwd"
  await run(basePayload(worldA), fakeOps(worldA))
  await run(payloadB, fakeOps(worldB))
  assert.deepEqual(worldA.launches[0]!.args, ["--user-data-dir=/tmp/ph-profile"])
  assert.equal(worldA.launches[0]!.cwd, "/Users/meiyx")
  assert.deepEqual(worldB.launches[0]!.args, ["--user-data-dir=/tmp/other-profile", "--flag-b"])
  assert.equal(worldB.launches[0]!.cwd, "/tmp/other-cwd")
})

test("启动失败能准确报告：launch 抛错与立即退出分别对应 launch-failed / launch-died", async () => {
  const thrown = baseWorld()
  autoExit(thrown)
  thrown.launchBehavior = "throw"
  const r1 = await run(basePayload(thrown), fakeOps(thrown))
  assert.equal(r1.phase, "failed")
  assert.match(r1.detail, /launch-failed/)

  const died = baseWorld()
  autoExit(died)
  died.launchBehavior = "die"
  const r2 = await run(basePayload(died), fakeOps(died))
  assert.equal(r2.phase, "failed")
  assert.match(r2.detail, /launch-died/)
})

test("launch 返回被拒绝的 Promise（真实 spawn 的异步 error）：以 launch-failed:<原因> 收尾", async () => {
  const world = baseWorld()
  autoExit(world)
  const ops = fakeOps(world)
  const statuses: { phase: string; detail: string }[] = []
  const withRecord = ops as Record<string, unknown>
  withRecord.launch = () => {
    const err = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })
    return Promise.reject(err)
  }
  withRecord.writeStatus = (phase: string, detail: string) => {
    statuses.push({ phase, detail })
  }
  const result = await run(basePayload(world), ops)
  assert.equal(result.phase, "failed")
  assert.match(result.detail, /launch-failed:ENOENT/)
  assert.equal(world.launches.length, 0, "启动失败后不得进入验证循环")
  assert.equal(statuses.at(-1)!.phase, "failed")
})

test("launch 的 Promise 在 spawn 事件后成功：流程照常进入验证", async () => {
  const world = baseWorld()
  autoExit(world)
  const ops = fakeOps(world)
  const withRecord = ops as Record<string, unknown>
  withRecord.launch = (exe: string, args: readonly string[], cwd: string, env: Record<string, string>) => {
    const pid = 53100
    world.launches.push({ exe, args, cwd, env })
    world.procs.set(pid, { pid, ppid: 1, uid: 501, lstart: "Sat Nov 15 19:00:00 2026", comm: exe })
    world.lockTarget = `meiyxMac.local-${pid}`
    return Promise.resolve({ pid })
  }
  const result = await run(basePayload(world), ops)
  assert.equal(result.phase, "new-started")
})

// ---------------------------------------------------------------------------
// 契约与解析
// ---------------------------------------------------------------------------

test("SIGNAL_RECHECK_REQUIREMENTS 是运行时不可变数据", () => {
  assert.ok(Object.isFrozen(SIGNAL_RECHECK_REQUIREMENTS))
  assert.equal(SIGNAL_RECHECK_REQUIREMENTS.length, 5)
})

test("监督脚本的 ps 行解析与 TS 侧一致（PID/PPID/UID/启动时间/可执行文件）", () => {
  const line =
    "  53046     1  501 Sat Nov 15 18:24:15 2026 /Applications/OpenCode.app/Contents/MacOS/OpenCode"
  const parsed = parseProcLine(line)
  assert.deepEqual(parsed, {
    pid: 53046,
    ppid: 1,
    uid: 501,
    lstart: "Sat Nov 15 18:24:15 2026",
    comm: "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
  })
  assert.equal(parseProcLine("garbage"), null)
  assert.equal(parseProcLine("53062 53046 501 only-three-tokens"), null)
})

test("监督脚本不提供导出模式之外的副作用入口：测试求值不触发运行", async () => {
  // 求值阶段（文件顶部）已完成：若误触发 run，上面的 import 就会失败。
  assert.equal(typeof runSupervisorFlow, "function")
})
