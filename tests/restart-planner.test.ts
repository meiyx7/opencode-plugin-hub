import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { join } from "node:path"
import {
  DEFAULT_APP_EXE,
  DEFAULT_SIDECAR_SUFFIX,
  SIGNAL_RECHECK_REQUIREMENTS,
  identityFromProcessLike,
  planRestart,
  singletonLockPidFromTarget,
  type ProcessIdentity,
  type RestartPlan,
  type RestartSnapshot,
} from "../src/gui/restart"

const APP_EXE = "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const SIDECAR_EXE =
  "/Users/meiyx/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli"
const SERVER_EXE = "/Users/meiyx/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli"

const selfOk = (over: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
  pid: 53046,
  ppid: 1,
  uid: 501,
  exe: APP_EXE,
  argv: [APP_EXE],
  ...over,
})

const sidecarOk = (over: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
  pid: 53062,
  ppid: 53046,
  uid: 501,
  exe: SIDECAR_EXE,
  ...over,
})

const snapshotOk = (over: Partial<RestartSnapshot> = {}): RestartSnapshot => ({
  self: selfOk(),
  sidecar: sidecarOk(),
  singletonLockPid: 53046,
  processes: [],
  ...over,
})

/** Every refusal must be shaped the same: no target, no actions, a reason and a message. */
function assertRefusal(plan: RestartPlan, reason: string, messagePart?: string) {
  assert.equal(plan.allowed, false)
  if (!plan.allowed) {
    assert.equal(plan.reason, reason)
    assert.equal(plan.target, null)
    assert.deepEqual(plan.actions, [])
    assert.ok(plan.message.length > 0)
    if (messagePart) assert.ok(plan.message.includes(messagePart), `message 应包含「${messagePart}」: ${plan.message}`)
  }
}

test("身份齐全且父子关系成立时允许规划，目标与动作均为纯描述", () => {
  const plan = planRestart(snapshotOk())
  assert.equal(plan.allowed, true)
  if (!plan.allowed) return
  assert.equal(plan.reason, "identity-confirmed")
  assert.equal(plan.target.appPid, 53046)
  assert.equal(plan.target.sidecarPid, 53062)
  assert.equal(plan.target.appExe, APP_EXE)
  assert.equal(plan.target.uid, 501)
  // 动作只是数据描述：每个动作都有 note，且规划阶段不包含任何执行痕迹。
  assert.ok(plan.actions.length >= 4)
  for (const action of plan.actions) assert.ok(action.note.length > 0)
  const kinds = plan.actions.map((action) => action.type)
  assert.deepEqual(kinds, [
    "terminate",
    "await-exit",
    "terminate-if-still-running",
    "await-exit",
    "relaunch",
  ])
  // SingletonLock 一致作为佐证记录在案。
  assert.ok(plan.evidence.some((item) => item.what === "singletonLock" && item.value.includes("一致")))
})

test("自身 PID 缺失：self 为 null 或 PID 非法都拒绝且不猜测目标", () => {
  assertRefusal(planRestart({ ...snapshotOk(), self: null }), "self-unknown")
  assertRefusal(planRestart({ ...snapshotOk(), self: {} }), "self-unknown")
  assertRefusal(planRestart({ ...snapshotOk(), self: selfOk({ pid: 0 }) }), "self-unknown")
  assertRefusal(planRestart({ ...snapshotOk(), self: selfOk({ pid: -1 }) }), "self-unknown")
  assertRefusal(planRestart({ ...snapshotOk(), self: selfOk({ pid: 1.5 }) }), "self-unknown")
})

test("自身 PPID 缺失：身份证据不完整即拒绝", () => {
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ ppid: undefined }) })), "identity-incomplete", "ppid")
})

test("服务进程 PID 不存在或无法确认：拒绝", () => {
  assertRefusal(planRestart({ ...snapshotOk(), sidecar: null }), "sidecar-unconfirmed")
  assertRefusal(planRestart({ ...snapshotOk(), sidecar: {} }), "sidecar-unconfirmed")
  assertRefusal(planRestart({ ...snapshotOk(), sidecar: sidecarOk({ pid: undefined }) }), "sidecar-unconfirmed")
})

test("当前进程不是预期的 OpenCode 桌面主进程：拒绝（server 或 Helper 都不行）", () => {
  const asServer = planRestart(snapshotOk({ self: selfOk({ exe: SERVER_EXE, argv: [SERVER_EXE] }) }))
  assertRefusal(asServer, "not-desktop-main")
  const asHelper = planRestart(
    snapshotOk({
      self: selfOk({ exe: "/Applications/OpenCode.app/Contents/MacOS/OpenCode Helper", argv: ["…Helper"] }),
    }),
  )
  assertRefusal(asHelper, "not-desktop-main")
})

test("服务进程与主进程父子关系不成立：拒绝", () => {
  const plan = planRestart(snapshotOk({ sidecar: sidecarOk({ ppid: 1 }) }))
  assertRefusal(plan, "sidecar-relation-broken")
})

test("PID 冲突：自指、表内重复、与他人重叠都拒绝", () => {
  const selfReferencing = planRestart(
    snapshotOk({ sidecar: sidecarOk({ pid: 53046 }) }),
  )
  assertRefusal(selfReferencing, "pid-conflict")
  const duplicated = planRestart(
    snapshotOk({ processes: [{ pid: 53062 }, { pid: 53062 }] }),
  )
  assertRefusal(duplicated, "pid-conflict")
  const overlapping = planRestart(snapshotOk({ processes: [{ pid: 53046, exe: "x" }] }))
  assertRefusal(overlapping, "pid-conflict")
})

test("身份信息不完整：缺 exe、argv、uid 各自拒绝", () => {
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ exe: undefined }) })), "identity-incomplete", "exe")
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ argv: [] }) })), "identity-incomplete", "argv")
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ uid: undefined }) })), "identity-incomplete", "uid")
  assertRefusal(planRestart(snapshotOk({ sidecar: sidecarOk({ exe: undefined }) })), "sidecar-unconfirmed")
})

test("身份信息互相矛盾：argv[0] 与 exe 不一致即拒绝", () => {
  const plan = planRestart(snapshotOk({ self: selfOk({ argv: ["/somewhere/else/OpenCode"] }) }))
  assertRefusal(plan, "identity-contradiction")
})

test("SingletonLock PID 与主进程 PID 不一致：拒绝，且锁不能单独决定目标", () => {
  assertRefusal(planRestart(snapshotOk({ singletonLockPid: 99999 })), "lock-mismatch")
  assertRefusal(planRestart(snapshotOk({ singletonLockPid: 53062 })), "lock-mismatch")
})

test("SingletonLock PID 一致但其余身份信息不足：仍然拒绝", () => {
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ exe: undefined }), singletonLockPid: 53046 })), "identity-incomplete")
  assertRefusal(
    planRestart({
      self: selfOk({ exe: undefined }),
      sidecar: sidecarOk(),
      singletonLockPid: 53046,
    }),
    "identity-incomplete",
  )
})

test("整份快照为空或全未知：fail-closed 拒绝", () => {
  assertRefusal(planRestart({}), "self-unknown")
  assertRefusal(planRestart({ self: undefined, sidecar: undefined }), "self-unknown")
})

test("缺少 SingletonLock 佐证时不阻断判定，但如实记录缺失", () => {
  const plan = planRestart(snapshotOk({ singletonLockPid: null }))
  assert.equal(plan.allowed, true)
  if (!plan.allowed) return
  assert.ok(plan.evidence.some((item) => item.what === "singletonLock" && item.value.includes("未提供")))
})

test("相同输入必定得到相同输出（确定性）", () => {
  const a = planRestart(snapshotOk())
  const b = planRestart(snapshotOk())
  assert.deepEqual(a, b)
  const refusedA = planRestart({ self: null })
  const refusedB = planRestart({ self: null })
  assert.deepEqual(refusedA, refusedB)
})

test("规划器不得有任何系统操作痕迹（源码级断言）", () => {
  const source = readFileSync(join(process.cwd(), "src/gui/restart.ts"), "utf8")
  // 不得引入任何模块（纯逻辑、零 import）。
  assert.ok(!/^import\s/m.test(source), "restart.ts 不应包含 import 语句")
  assert.ok(!source.includes("require("), "restart.ts 不应包含 require 调用")
  // 不得引用进程操作系统接口。
  const forbidden = [
    "child_process",
    "process.kill",
    "process.exit",
    "process.binding",
    "pkill",
    "pgrep",
    "lsof",
    "launchctl",
    "osascript",
    "open -b",
    "SingletonLock\"", // 锁路径只允许以参数形式进来，不得在此拼接真实路径
  ]
  for (const token of forbidden) {
    assert.ok(!source.includes(token), `restart.ts 不应包含「${token}」`)
  }
  // 系统调用动词只能以「动作描述数据」的受控形式出现。
  assert.ok(!/\bspawn\b/.test(source))
  assert.ok(!/\bexecFile\b/.test(source))
  assert.ok(!/\bexecSync\b/.test(source))
  assert.ok(!/\bexec\(/.test(source))
  assert.ok(!/\bfs\b/.test(source))
})

test("辅助纯函数：SingletonLock 目标解析与 process 字段映射", () => {
  assert.equal(singletonLockPidFromTarget("meiyxMac.local-53046"), 53046)
  assert.equal(singletonLockPidFromTarget("host-1"), 1)
  assert.equal(singletonLockPidFromTarget("no-pid-here"), null)
  assert.equal(singletonLockPidFromTarget(""), null)
  assert.equal(singletonLockPidFromTarget(null), null)
  assert.equal(singletonLockPidFromTarget(undefined), null)

  assert.equal(identityFromProcessLike(null), null)
  const mapped = identityFromProcessLike({
    pid: 53046,
    ppid: 1,
    uid: 501,
    execPath: APP_EXE,
    argv: [APP_EXE],
  })
  assert.deepEqual(mapped, { pid: 53046, ppid: 1, uid: 501, exe: APP_EXE, argv: [APP_EXE] })
  const partial = identityFromProcessLike({ pid: 7 })
  assert.deepEqual(partial, { pid: 7, ppid: undefined, uid: undefined, exe: undefined, argv: undefined })
  // 传入真实形态的数据也能通过规划器：映射结果与本机已知形态一致。
  const plan = planRestart({
    self: mapped,
    sidecar: sidecarOk(),
    singletonLockPid: 53046,
  })
  assert.equal(plan.allowed, true)
})

test("默认预期值与可覆盖项：规划器不硬编码绑定单一安装路径", () => {
  assert.equal(DEFAULT_APP_EXE, "/Applications/OpenCode.app/Contents/MacOS/OpenCode")
  assert.equal(DEFAULT_SIDECAR_SUFFIX, "/opencode-cli")
  // 用户目录安装的 app：通过 options 覆盖预期路径后同样可规划。
  const plan = planRestart(
    snapshotOk({
      self: selfOk({ exe: "/Users/meiyx/Applications/OpenCode.app/Contents/MacOS/OpenCode", argv: ["/Users/meiyx/Applications/OpenCode.app/Contents/MacOS/OpenCode"] }),
    }),
    { expectedAppExe: "/Users/meiyx/Applications/OpenCode.app/Contents/MacOS/OpenCode" },
  )
  assert.equal(plan.allowed, true)
})

test("self UID 非法值全部拒绝：缺失、NaN、Infinity、负数、小数", () => {
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ uid: undefined }) })), "identity-incomplete", "uid")
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ uid: NaN }) })), "identity-incomplete", "uid")
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ uid: Infinity }) })), "identity-incomplete", "uid")
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ uid: -1 }) })), "identity-incomplete", "uid")
  assertRefusal(planRestart(snapshotOk({ self: selfOk({ uid: 1.5 }) })), "identity-incomplete", "uid")
})

test("sidecar UID 缺失或非法：拒绝且不得退化猜测", () => {
  assertRefusal(planRestart(snapshotOk({ sidecar: sidecarOk({ uid: undefined }) })), "sidecar-unconfirmed", "uid")
  assertRefusal(planRestart(snapshotOk({ sidecar: sidecarOk({ uid: NaN }) })), "sidecar-unconfirmed")
  assertRefusal(planRestart(snapshotOk({ sidecar: sidecarOk({ uid: -5 }) })), "sidecar-unconfirmed")
  assertRefusal(planRestart(snapshotOk({ sidecar: sidecarOk({ uid: 2.25 }) })), "sidecar-unconfirmed")
})

test("self 与 sidecar UID 不一致：拒绝生成重启计划", () => {
  const plan = planRestart(snapshotOk({ sidecar: sidecarOk({ uid: 502 }) }))
  assertRefusal(plan, "uid-mismatch")
})

test("UID 一致（正常值）时正常规划并在证据中记录一致性", () => {
  const plan = planRestart(snapshotOk({ self: selfOk({ uid: 0 }), sidecar: sidecarOk({ uid: 0 }) }))
  assert.equal(plan.allowed, true)
  if (!plan.allowed) return
  assert.equal(plan.target.uid, 0)
  assert.ok(plan.evidence.some((item) => item.what === "uid" && item.value.includes("一致")))
})

test("信号动作必须携带执行前复核要求，不等于无条件按 PID 操作", () => {
  const plan = planRestart(snapshotOk())
  assert.equal(plan.allowed, true)
  if (!plan.allowed) return
  const signalActions = plan.actions.filter((action) => action.type === "terminate" || action.type === "terminate-if-still-running")
  assert.equal(signalActions.length, 2)
  for (const action of signalActions) {
    if (action.type !== "terminate" && action.type !== "terminate-if-still-running") return
    assert.deepEqual(action.recheck.requirements, SIGNAL_RECHECK_REQUIREMENTS)
    assert.ok(action.recheck.requirements.length >= 5)
    // 五项复核要求逐条在案：存在性、exe 一致、UID 一致、非 PID 复用、无矛盾。
    assert.ok(action.recheck.requirements.some((r) => r.includes("仍然存在")))
    assert.ok(action.recheck.requirements.some((r) => r.includes("可执行文件")))
    assert.ok(action.recheck.requirements.some((r) => r.includes("UID")))
    assert.ok(action.recheck.requirements.some((r) => r.includes("PID 复用")))
    assert.ok(action.recheck.requirements.some((r) => r.includes("矛盾")))
  }
  // 每个信号动作的复核身份必须与原始目标一致，而不是空泛占位。
  const appAction = plan.actions.find((action) => action.type === "terminate")
  const sidecarAction = plan.actions.find((action) => action.type === "terminate-if-still-running")
  if (!appAction || appAction.type !== "terminate") return assert.fail("缺少主进程终止动作")
  assert.equal(appAction.recheck.exe, APP_EXE)
  assert.equal(appAction.recheck.uid, 501)
  if (!sidecarAction || sidecarAction.type !== "terminate-if-still-running") return assert.fail("缺少服务进程条件终止动作")
  assert.equal(sidecarAction.recheck.exe, SIDECAR_EXE)
  assert.equal(sidecarAction.recheck.uid, 501)
})

test("启动能力必须明确标记为未验证，且不虚构启动上下文", () => {
  const plan = planRestart(snapshotOk())
  assert.equal(plan.allowed, true)
  if (!plan.allowed) return
  assert.equal(plan.relaunchReadiness, "unverified")
  const relaunch = plan.actions.find((action) => action.type === "relaunch")
  if (!relaunch || relaunch.type !== "relaunch") return assert.fail("缺少 relaunch 动作")
  assert.equal(relaunch.readiness, "unverified")
  // 不虚构环境变量、工作目录或实例隔离参数：relaunch 只携带 exe 与 argv。
  assert.deepEqual(Object.keys(relaunch).sort(), ["argv", "exe", "note", "readiness", "type"])
  assert.deepEqual(relaunch.argv, [APP_EXE])
  assert.ok(!("env" in plan.target))
  assert.ok(!("cwd" in plan.target))
  assert.ok(!("userDataDir" in plan.target))
  assert.ok(plan.evidence.some((item) => item.what === "relaunchReadiness" && item.value.includes("unverified")))
})

test("复核约束与就绪状态是规划器输出的一部分（类型层面存在）", () => {
  // 通过一次成功规划与一次拒绝规划，确认新字段在两个分支上的结构稳定。
  const ok = planRestart(snapshotOk())
  const bad = planRestart(snapshotOk({ self: selfOk({ uid: NaN }) }))
  assert.equal(ok.allowed, true)
  assert.equal(bad.allowed, false)
  if (ok.allowed) {
    assert.ok("relaunchReadiness" in ok)
    assert.ok(ok.actions.every((action) => {
      if (action.type === "terminate" || action.type === "terminate-if-still-running") return "recheck" in action
      if (action.type === "relaunch") return "readiness" in action
      return true
    }))
  }
  if (!bad.allowed) {
    assert.equal(bad.target, null)
    assert.deepEqual(bad.actions, [])
  }
})
