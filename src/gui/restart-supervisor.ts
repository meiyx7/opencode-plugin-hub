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
 *   1. re-check the planned app identity (PID + start time + exe + UID),
 *   2. TERM the app and wait for it to exit (never KILL the app),
 *   3. handle the sidecar: skip if gone; otherwise re-check identity fresh,
 *      TERM, wait, re-check AGAIN, and only then KILL; refuse on any mismatch,
 *   4. verify the SingletonLock no longer points at a live foreign process,
 *   5. relaunch the ORIGINAL executable with the ORIGINAL argv, cwd and a
 *      whitelisted environment,
 *   6. verify the new instance stays alive and takes over the lock,
 *   7. record every phase in the status file for the UI to pick up later.
 *
 * The instance credential against PID reuse is the process START TIME
 * (`ps -o lstart=`, second-resolution): a recycled PID gets a fresh start
 * time, so a pid+exe+uid coincidence without the same start time is refused.
 * This narrows but does NOT eliminate the PID-reuse window (see the
 * credential note in restart-collect.ts); the fail-closed posture — refuse on
 * any mismatch, never reuse an earlier re-check — is what keeps signalling
 * safe. KILL is
 * always preceded by a fresh re-check that re-reads the start time; results
 * from earlier re-checks are never reused.
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
  if (tokens.length < 9) return null
  var pid = parseInt(tokens[0], 10)
  var ppid = parseInt(tokens[1], 10)
  var uid = parseInt(tokens[2], 10)
  // lstart renders as four tokens: 'Thu Nov 15 18:24:15 2026'
  var lstart = tokens.slice(3, 8).join(' ')
  var comm = tokens.slice(8).join(' ')
  if (!isFinite(pid) || pid <= 0) return null
  if (!lstart || !comm) return null
  return { pid: pid, ppid: ppid, uid: uid, lstart: lstart, comm: comm }
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
          out = cp.execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
          })
        } catch (e) { out = null }
      }
      if (out === null) return null
      var lines = String(out).split('\\n').filter(function (l) { return l.trim().length > 0 })
      if (lines.length === 0) return null
      return parseProcLine(lines[0])
    },
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

// instance credential re-check. The app record carries the original ppid (a
// reparented app is treated as changed, fail-closed); the sidecar record does
// NOT carry ppid because the app's death legitimately reparents it to launchd.
function recheckIdentity(rec, ops) {
  var cur = ops.procInfo(rec.pid)
  if (!cur) return { ok: false, reason: 'pid-gone' }
  if (cur.comm !== rec.exe) return { ok: false, reason: 'exe-mismatch' }
  if (cur.uid !== rec.uid) return { ok: false, reason: 'uid-mismatch' }
  if (!rec.lstart || cur.lstart !== rec.lstart) return { ok: false, reason: 'instance-mismatch' }
  if (typeof rec.ppid === 'number' && cur.ppid !== rec.ppid) return { ok: false, reason: 'ppid-mismatch' }
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
      !app.lstart || !Array.isArray(app.argv) || app.argv.length === 0 || typeof app.cwd !== 'string') {
    return done('failed', 'invalid-payload', 1)
  }
  if (sidecar && sidecar.pid === app.pid) return done('failed', 'invalid-payload', 1)

  // 1. fresh identity re-check of the planned app before touching it
  var rc = recheckIdentity(app, ops)
  if (!rc.ok) return done('failed', 'app-recheck-failed:' + rc.reason, 1)

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
