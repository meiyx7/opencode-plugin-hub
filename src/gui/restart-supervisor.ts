/**
 * The detached restart supervisor.
 *
 * This file exports ONE string, `SUPERVISOR_SOURCE`: a self-contained CommonJS
 * script that is executed as `node -e <source> run <payload-json>` from the
 * Electron main process. It must be self-contained because the main process —
 * one of the things being restarted — dies shortly after spawning it, and the
 * published package ships `src/` only (no `scripts/`), so no separate helper
 * file exists to point a runtime at.
 *
 * The script's flow:
 *   1. re-check the planned app identity (PID + start time + age + exe + UID)
 *      AND the kernel parent relation (getppid() === app.pid),
 *   2. TERM the app and wait for it to exit (never KILL the app),
 *   3. handle the sidecar: skip if gone; otherwise re-check identity fresh,
 *      TERM, wait, re-check AGAIN, and only then KILL; refuse on any mismatch,
 *   4. verify the SingletonLock no longer points at a live foreign process,
 *   5. relaunch the ORIGINAL executable with the ORIGINAL argv, cwd and a
 *      whitelisted environment,
 *   6. verify the new instance stays alive and takes over the lock,
 *   7. record every phase in the status file for the UI to pick up later.
 *
 * 身份凭据分层（TASK-2 最终裁定）：「能采集到信息」「大概率是原进程」「满足
 * 发破坏性信号前的安全要求」三者不是一回事。发 TERM/KILL 前必须满足：
 *   a. 主进程：内核父子关系 —— 本监督进程由目标 app 亲自 spawn，
 *      getppid() === app.pid 由内核保证，PID 复用无法伪造（原父死后 ppid
 *      变为 launchd，复用者不可能重新成为本进程的父进程）；
 *   b. 全部目标：最小年龄门 + 存活时间单调性 —— `ps lstart` 只有秒级精度，
 *      单独使用无法区分同一秒内的 PID 复用；因此只接受采集时已存活
 *      ≥ MIN_SIGNAL_AGE_SECONDS 的进程，且每次复核时新鲜 etime ≥ 记录
 *      etime。复用者必然在原进程死后启动，其启动秒 ≥ 记录秒 + 年龄门，
 *      lstart 显示值必然不同、etime 必然更小 —— 同秒复用在构造上不可能。
 * 任一证据缺失、字段异常或目标过新：拒发信号，写入 failed 并给出原因，
 * 提示手动重启。绝不为了重启成功率降低校验标准；TERM 与 KILL 前各自执行
 * 全新一轮复核，绝不复用先前的复核结果。
 *
 * In tests the same source is evaluated as a module: it exports
 * `runSupervisorFlow(payload, ops)` so every branch is driven with injected
 * operations and no real process is ever touched.
 */
export const SUPERVISOR_SOURCE = `'use strict'
// OpenCode restart supervisor. Detached from the app it restarts; every phase
// is written to the status file so the UI can report the real outcome later.
//
// ops injected below are the ONLY window into the system. In production they
// wrap ps/readlink/spawn; in tests they are fakes.

function parseProcLine(line) {
  var tokens = String(line).trim().split(/\\s+/)
  if (tokens.length < 10) return null
  var pid = parseInt(tokens[0], 10)
  var ppid = parseInt(tokens[1], 10)
  var uid = parseInt(tokens[2], 10)
  // lstart renders as five tokens: 'Thu Nov 15 18:24:15 2026'
  var lstart = tokens.slice(3, 8).join(' ')
  var etime = tokens[8]
  var comm = tokens.slice(9).join(' ')
  if (!isFinite(pid) || pid <= 0) return null
  if (!lstart || !etime || !comm) return null
  return { pid: pid, ppid: ppid, uid: uid, lstart: lstart, etime: etime, comm: comm }
}

// Minimum age (seconds) a process must have at credential-capture time before
// its second-resolution lstart may support a signalling decision. Below this
// age a same-second PID reuse could not be excluded, so the flow refuses.
var MIN_SIGNAL_AGE_SECONDS = 2

// Parses ps etime ('[[dd-]hh:]mm:ss') into total seconds; null when malformed.
// Fields are strictly digit-checked so garbage can never masquerade as a
// valid age credential. BSD ps does not zero-pad hours (1:05:23), so hours
// accept one or two digits; minutes and seconds are always two digits.
function etimeSeconds(etime) {
  var rest = String(etime || '').trim()
  var days = 0
  var dash = rest.indexOf('-')
  if (dash >= 0) {
    var dayPart = rest.slice(0, dash)
    rest = rest.slice(dash + 1)
    if (!/^\\d+$/.test(dayPart)) return null
    days = parseInt(dayPart, 10)
  }
  var parts = rest.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  var hours = parts.length === 3 ? parts[0] : null
  var minutes = parts.length === 3 ? parts[1] : parts[0]
  var secs = parts[parts.length - 1]
  if (hours !== null && !/^\\d{1,2}$/.test(hours)) return null
  if (!/^\\d{2}$/.test(minutes) || !/^\\d{2}$/.test(secs)) return null
  var total = (hours !== null ? parseInt(hours, 10) * 3600 : 0) + parseInt(minutes, 10) * 60 + parseInt(secs, 10)
  return days * 86400 + total
}

function makeRealOps(payload) {
  var cp = require('node:child_process')
  var fs = require('node:fs')
  var path = require('node:path')
  function logDir() {
    try { return path.dirname(payload.statusPath) } catch (e) { return null }
  }
  return {
    procInfo: function (pid) {
      var out = null
      for (var attempt = 0; attempt < 2 && out === null; attempt++) {
        try {
          out = cp.execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,etime=,comm='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
          })
        } catch (e) { out = null }
      }
      if (out === null) return null
      var lines = String(out).split('\\n').filter(function (l) { return l.trim().length > 0 })
      if (lines.length === 0) return null
      return parseProcLine(lines[0])
    },
    getPpid: function () { return process.getppid() },
    signal: function (pid, sig) { cp.spawnSync('kill', ['-' + sig, String(pid)], { stdio: 'ignore' }) },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) },
    readLink: function (p) {
      try { return fs.readlinkSync(p) } catch (e) { return null }
    },
    launch: function (exe, args, cwd, env) {
      // Spawn proof, not a pid guess: Node reports launch failures (ENOENT,
      // EACCES, ...) only asynchronously via the error event, so the flow
      // awaits either the spawn event (the process really exists) or the
      // error event before doing anything else. close/exit are deliberately
      // not observed here — the verification loop below decides life or
      // death from the process table, not from child events.
      return new Promise(function (resolve, reject) {
        var child = cp.spawn(exe, args, { cwd: cwd, env: env, detached: true, stdio: 'ignore' })
        var settled = false
        child.on('error', function (e) {
          if (settled) return
          settled = true
          reject(e)
        })
        child.on('spawn', function () {
          if (settled) return
          settled = true
          child.unref()
          resolve({ pid: child.pid })
        })
      })
    },
    now: function () { return Date.now() },
    writeStatus: function (phase, detail) {
      var record = { requestId: payload.requestId, phase: phase, at: Date.now(), detail: detail || '' }
      try { fs.writeFileSync(payload.statusPath, JSON.stringify(record)) } catch (e) { /* best effort */ }
    },
    log: function (line) {
      var dir = logDir()
      if (!dir) return
      try {
        fs.appendFileSync(path.join(dir, 'restart.log'), '[' + new Date().toISOString() + '] ' + line + '\\n')
      } catch (e) { /* best effort */ }
    },
  }
}

// instance credential re-check (fresh read, never cached). The app record
// carries the original ppid (a reparented app is treated as changed,
// fail-closed); the sidecar record does NOT carry ppid because the app's
// death legitimately reparents it to launchd. Beyond field equality the
// age credential is enforced: the record must have been captured on a
// process at least MIN_SIGNAL_AGE_SECONDS old, and the fresh etime must not
// be smaller than the recorded one — a recycler is always younger.
function recheckIdentity(rec, ops) {
  var cur = ops.procInfo(rec.pid)
  if (!cur) return { ok: false, reason: 'pid-gone' }
  if (cur.comm !== rec.exe) return { ok: false, reason: 'exe-mismatch' }
  if (cur.uid !== rec.uid) return { ok: false, reason: 'uid-mismatch' }
  if (!rec.lstart || cur.lstart !== rec.lstart) return { ok: false, reason: 'instance-mismatch' }
  if (typeof rec.ppid === 'number' && cur.ppid !== rec.ppid) return { ok: false, reason: 'ppid-mismatch' }
  if (!rec.etime) return { ok: false, reason: 'etime-missing' }
  if (!cur.etime) return { ok: false, reason: 'etime-missing' }
  var recAge = etimeSeconds(rec.etime)
  var curAge = etimeSeconds(cur.etime)
  if (recAge === null || curAge === null) return { ok: false, reason: 'etime-unparseable' }
  if (recAge < MIN_SIGNAL_AGE_SECONDS) return { ok: false, reason: 'credential-too-young' }
  if (curAge < recAge) return { ok: false, reason: 'etime-shrunk' }
  return { ok: true }
}

function lockHoldsLiveForeignPid(payload, ops) {
  if (!payload.lockPath) return null
  var target = ops.readLink(payload.lockPath)
  if (!target) return null
  var match = target.match(/-(\\d+)$/)
  if (!match) return null
  var lockPid = parseInt(match[1], 10)
  if (lockPid === payload.app.pid) return null // stale lock of the instance we just ended
  if (ops.procInfo(lockPid) !== null) return lockPid // a live process we did not plan for
  return null
}

async function runSupervisorFlow(payload, ops) {
  var app = payload && payload.app
  var sidecar = payload && payload.sidecar
  var timeouts = (payload && payload.timeouts) || {}
  var result = { phase: 'unknown', detail: '', exitCode: 2 }
  function done(phase, detail, exitCode) {
    result = { phase: phase, detail: detail, exitCode: exitCode }
    ops.writeStatus(phase, detail)
    ops.log('phase=' + phase + (detail ? ' detail=' + detail : ''))
    return result
  }

  if (!app || !isFinite(app.pid) || app.pid <= 0 || typeof app.exe !== 'string' || !app.exe ||
      !app.lstart || !app.etime || !Array.isArray(app.argv) || app.argv.length === 0 || typeof app.cwd !== 'string') {
    return done('failed', 'invalid-payload', 1)
  }
  if (sidecar && (!isFinite(sidecar.pid) || sidecar.pid <= 0 || typeof sidecar.exe !== 'string' || !sidecar.exe ||
      !sidecar.lstart || !sidecar.etime)) {
    return done('failed', 'invalid-payload', 1)
  }
  if (sidecar && sidecar.pid === app.pid) return done('failed', 'invalid-payload', 1)

  // 1. fresh identity re-check of the planned app before touching it
  var rc = recheckIdentity(app, ops)
  if (!rc.ok) return done('failed', 'app-recheck-failed:' + rc.reason, 1)

  // 1.5 kernel parent relation (TASK-2, app only): this supervisor was
  //     spawned by the app itself, so getppid() === app.pid is a kernel-
  //     guaranteed fact that PID reuse cannot forge — once the original
  //     parent dies our ppid becomes launchd and can never point back at a
  //     recycled process. Missing or mismatched parent evidence refuses the
  //     signal outright (fail-closed).
  var parentPid = typeof ops.getPpid === 'function' ? ops.getPpid() : null
  if (parentPid !== app.pid) return done('failed', 'app-parent-mismatch:' + parentPid, 1)

  // 2. TERM the app; the app is never KILLed — if it will not exit, the
  //    supervisor reports and stops instead of escalating.
  try { ops.signal(app.pid, 'TERM') } catch (e) { return done('failed', 'term-failed', 1) }
  ops.writeStatus('term-sent', '')
  var appDeadline = ops.now() + (timeouts.appExitMs || 8000)
  while (ops.procInfo(app.pid) !== null) {
    if (ops.now() >= appDeadline) return done('failed', 'app-exit-timeout', 1)
    await ops.sleep(200)
  }
  ops.writeStatus('current-exited', '')

  // 3. sidecar: fresh re-check before EVERY signal (TERM and KILL separately)
  if (sidecar) {
    var alive = ops.procInfo(sidecar.pid)
    if (!alive) {
      ops.writeStatus('sidecar-exited', '')
    } else {
      var r1 = recheckIdentity(sidecar, ops)
      if (!r1.ok) return done('failed', 'sidecar-recheck-failed:' + r1.reason, 1)
      try { ops.signal(sidecar.pid, 'TERM') } catch (e) { return done('failed', 'sidecar-term-failed', 1) }
      await ops.sleep(timeouts.sidecarGraceMs || 2000)
      if (ops.procInfo(sidecar.pid) !== null) {
        var r2 = recheckIdentity(sidecar, ops) // fresh read: TERM may have exposed a recycled PID
        if (!r2.ok) return done('failed', 'sidecar-recheck-before-kill-failed:' + r2.reason, 1)
        try { ops.signal(sidecar.pid, 'KILL') } catch (e) { return done('failed', 'sidecar-kill-failed', 1) }
      }
      var scDeadline = ops.now() + (timeouts.sidecarExitMs || 5000)
      while (ops.procInfo(sidecar.pid) !== null) {
        if (ops.now() >= scDeadline) return done('failed', 'sidecar-exit-timeout', 1)
        await ops.sleep(200)
      }
      ops.writeStatus('sidecar-cleared', '')
    }
  }

  // 4. SingletonLock: never deleted, never signalled — a lock held by a live
  //    process we did not plan for aborts the relaunch.
  var foreignLockPid = lockHoldsLiveForeignPid(payload, ops)
  if (foreignLockPid !== null) return done('failed', 'lock-held-by-live-pid:' + foreignLockPid, 1)

  // 5. relaunch the ORIGINAL executable with the ORIGINAL argv, cwd and the
  //    whitelisted environment recorded at plan time. launch() resolves only
  //    when the spawn has actually taken (spawn event) and rejects with the
  //    real spawn error otherwise, so a launch failure is reported with its
  //    reason instead of being mislabeled later as 'launch-died'.
  var child
  try {
    child = await ops.launch(app.exe, app.argv.slice(1), app.cwd, payload.env || {})
  } catch (e) {
    return done('failed', 'launch-failed:' + ((e && e.code) || (e && e.message) || 'unknown'), 1)
  }
  if (!child || !isFinite(child.pid) || child.pid <= 0) {
    return done('failed', 'launch-failed:no-pid', 1)
  }
  ops.writeStatus('relaunching', 'pid:' + child.pid)

  // 6. verify: the new instance stays alive and (when the lock path is known)
  //    takes over the SingletonLock with its own PID.
  var verifyDeadline = ops.now() + (timeouts.launchVerifyMs || 4000)
  var lockConfirmed = !payload.lockPath
  while (true) {
    if (ops.procInfo(child.pid) === null) return done('failed', 'launch-died', 1)
    if (payload.lockPath) {
      var target = ops.readLink(payload.lockPath)
      var match = target ? target.match(/-(\\d+)$/) : null
      if (match && parseInt(match[1], 10) === child.pid) { lockConfirmed = true; break }
    }
    if (ops.now() >= verifyDeadline) break
    await ops.sleep(250)
  }
  if (!lockConfirmed) return done('unknown', 'launch-lock-unconfirmed', 2)
  return done('new-started', 'pid:' + child.pid + (payload.lockPath ? '' : ' lock-unverified'), 0)
}

// Run mode: "node -e SOURCE run PAYLOAD" (production, argv[1]==='run') or
// "node supervisor.cjs run PAYLOAD" (smoke checks, argv[2]==='run').
var runMark = process.argv.indexOf('run', 1)
if (runMark > 0) {
  var payload = JSON.parse(process.argv[runMark + 1])
  var ops = makeRealOps(payload)
  runSupervisorFlow(payload, ops).then(function (r) { process.exit(r.exitCode) }, function () { process.exit(1) })
}

module.exports = { runSupervisorFlow: runSupervisorFlow, makeRealOps: makeRealOps, parseProcLine: parseProcLine }
`
