/**
 * 自更新专项测试：admin.install() 的 selfUpdated 判定 + 重启确认流程的每条分支。
 * 只用 Node 内置 node:test、临时目录和 fetch 桩，不引入第三方依赖。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as admin from "../src/gui/admin.ts"
import {
  RESTART_CONFIRM,
  SELF_UPDATE_CONFIRM,
  restartNote,
  runSelfUpdateRestart,
  type HubNote,
  type RestartAttempt,
} from "../src/gui/self-update.ts"

const REAL_FETCH = globalThis.fetch
const ENV_KEYS = ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_PLUGIN_HUB_REGISTRY"] as const
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

let temp = ""
let tarball: Buffer = Buffer.alloc(0)
let route: (url: string) => Response = () => new Response("", { status: 404 })

globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String(input)
  return route(url)
}) as typeof fetch

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json")
}

async function writeConfig(specs: string[]): Promise<void> {
  await writeFile(configPath(), `${JSON.stringify({ plugins: specs }, null, 2)}\n`, "utf8")
}

async function readConfigSpecs(): Promise<string[]> {
  return (JSON.parse(await readFile(configPath(), "utf8")) as { plugins: string[] }).plugins
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "plugin-hub-self-update-"))
  await mkdir(join(temp, "config", "opencode"), { recursive: true })
  await mkdir(join(temp, "cache"), { recursive: true })
  process.env.XDG_CONFIG_HOME = join(temp, "config")
  process.env.XDG_CACHE_HOME = join(temp, "cache")
  process.env.OPENCODE_PLUGIN_HUB_REGISTRY = "http://plugin-hub.test"
  tarball = Buffer.alloc(0)
  route = () => new Response("", { status: 404 })
  await writeConfig([])
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined)
})

after(() => {
  globalThis.fetch = REAL_FETCH
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

/** A real .tgz with `package/package.json`, built with the system tar (no npm dependency). */
async function makeTarball(dir: string, version: string): Promise<Buffer> {
  const stage = join(dir, "stage")
  await mkdir(join(stage, "package"), { recursive: true })
  await writeFile(
    join(stage, "package", "package.json"),
    JSON.stringify({ name: "opencode-plugin-hub", version }, null, 2),
  )
  const archive = join(dir, "package.tgz")
  const result = spawnSync("tar", ["-czf", archive, "-C", stage, "package"], { encoding: "utf8" })
  assert.equal(result.status, 0, `生成测试 tarball 失败：${result.stderr}`)
  return readFile(archive)
}

// ---------------------------------------------------------------------------
// install(): selfUpdated 判定
// ---------------------------------------------------------------------------

test("1. 普通 npm 插件安装不触发 selfUpdated", async () => {
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true)
  assert.match(result.message, /已添加/)
  assert.notEqual(result.selfUpdated, true)
  assert.deepEqual(await readConfigSpecs(), ["opencode-notify"])
})

test("2. 普通 npm 插件更新不触发 selfUpdated", async () => {
  await writeConfig(["opencode-notify@1.0.0"])
  const result = await admin.install("opencode-notify", "1.2.0")
  assert.equal(result.ok, true)
  assert.match(result.message, /已更新/)
  assert.notEqual(result.selfUpdated, true)
  assert.deepEqual(await readConfigSpecs(), ["opencode-notify@1.2.0"])
})

test("3. 插件中心自身安装触发 selfUpdated", async () => {
  const result = await admin.install("opencode-plugin-hub", "0.3.7")
  assert.equal(result.ok, true)
  assert.equal(result.selfUpdated, true)
  assert.deepEqual(await readConfigSpecs(), ["opencode-plugin-hub@0.3.7"])
})

test("4. 插件中心自身更新触发 selfUpdated", async () => {
  await writeConfig(["opencode-plugin-hub@0.3.6"])
  const result = await admin.install("opencode-plugin-hub", "0.3.7")
  assert.equal(result.ok, true)
  assert.equal(result.selfUpdated, true)
  assert.match(result.message, /已更新/)
  assert.deepEqual(await readConfigSpecs(), ["opencode-plugin-hub@0.3.7"])
})

test("5. 本地目录插件更新不误判为插件中心自身更新", async () => {
  const pluginDir = join(temp, "local-hub")
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: "opencode-plugin-hub", version: "0.3.6" }),
  )
  await writeConfig([pluginDir])
  tarball = await makeTarball(join(temp, "tarball-work"), "0.3.7")
  route = (url) => {
    if (url.endsWith("/-/ping")) return json({ ok: true })
    if (url.endsWith("/opencode-plugin-hub")) {
      return json({
        "dist-tags": { latest: "0.3.7" },
        versions: { "0.3.7": { dist: { tarball: "http://plugin-hub.test/pkg.tgz" } } },
      })
    }
    if (url.endsWith("/pkg.tgz")) return new Response(tarball, { status: 200 })
    return new Response("", { status: 404 })
  }
  const result = await admin.install("opencode-plugin-hub", "0.3.7")
  assert.equal(result.ok, true, `目录更新应成功：${result.message}`)
  assert.equal(result.selfUpdated, undefined, "目录插件走文件替换分支，不能触发自更新")
  assert.match(result.message, /已更新到 0\.3\.7/)
  assert.equal(
    (JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8")) as { version: string }).version,
    "0.3.7",
  )
  assert.deepEqual(await readConfigSpecs(), [pluginDir], "目录插件不应改写配置")
})

test("6. 安装失败不触发 selfUpdated", async () => {
  const invalid = await admin.install("../not-a-package", "")
  assert.equal(invalid.ok, false)
  assert.notEqual(invalid.selfUpdated, true)

  const pluginDir = join(temp, "local-hub-fail")
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: "opencode-plugin-hub", version: "0.3.6" }),
  )
  await writeConfig([pluginDir])
  const failed = await admin.install("opencode-plugin-hub", "9.9.9")
  assert.equal(failed.ok, false, "registry 没有这个版本，目录刷新应失败")
  assert.notEqual(failed.selfUpdated, true)
  assert.deepEqual(await readConfigSpecs(), [pluginDir])
})

// ---------------------------------------------------------------------------
// 回归：普通插件安装 / 更新 / 移除
// ---------------------------------------------------------------------------

test("普通插件安装、更新、移除流程没有回归", async () => {
  const added = await admin.install("opencode-notify", "1.0.0")
  assert.equal(added.ok, true)
  assert.notEqual(added.selfUpdated, true)
  const updated = await admin.install("opencode-notify", "1.1.0")
  assert.equal(updated.ok, true)
  assert.notEqual(updated.selfUpdated, true)
  assert.deepEqual(await readConfigSpecs(), ["opencode-notify@1.1.0"])
  const removed = await admin.remove("opencode-notify@1.1.0")
  assert.equal(removed.ok, true)
  assert.equal(removed.selfUpdated, undefined)
  assert.deepEqual(await readConfigSpecs(), [])
})

test("插件中心自身仍然不能移除", async () => {
  await writeConfig(["opencode-plugin-hub@0.3.6"])
  const result = await admin.remove("opencode-plugin-hub@0.3.6")
  assert.equal(result.ok, false)
  assert.match(result.message, /不能移除/)
  assert.deepEqual(await readConfigSpecs(), ["opencode-plugin-hub@0.3.6"])
})

// ---------------------------------------------------------------------------
// 重启确认流程（纯逻辑，无需 DOM）
// ---------------------------------------------------------------------------

interface DriveResult {
  notes: HubNote[]
  events: string[]
  confirmCalls: number
  restartCalls: number
}

async function drive(options: { confirmed: boolean; attempt?: RestartAttempt }): Promise<DriveResult> {
  const notes: HubNote[] = []
  const events: string[] = []
  let confirmCalls = 0
  let restartCalls = 0
  await runSelfUpdateRestart({
    confirm: async () => {
      confirmCalls += 1
      events.push("confirm")
      return options.confirmed
    },
    restart: async () => {
      restartCalls += 1
      events.push("restart")
      return options.attempt ?? "started"
    },
    notify: (note) => {
      notes.push(note)
      events.push(`note:${note.text}`)
    },
  })
  return { notes, events, confirmCalls, restartCalls }
}

test("7. 用户取消重启：不显示正在重启或重启成功，明确提示尚未重启", async () => {
  const result = await drive({ confirmed: false })
  assert.equal(result.confirmCalls, 1)
  assert.equal(result.restartCalls, 0, "取消时不得调用重启")
  const all = result.notes.map((note) => note.text).join("\n")
  assert.ok(!all.includes("正在重启"))
  assert.ok(!all.includes("重启成功"))
  assert.match(result.notes.at(-1)!.text, /尚未重启/)
  assert.match(result.notes.at(-1)!.text, /更多操作 → 彻底重启 OpenCode/, "取消后仍告知重启入口")
  assert.equal(result.notes.at(-1)!.tone, "warning")
})

test("8. 自动重启失败：保留明确的手动重启提示", async () => {
  for (const attempt of ["unavailable", "failed"] as const) {
    const result = await drive({ confirmed: true, attempt })
    assert.equal(result.restartCalls, 1)
    const last = result.notes.at(-1)!
    assert.equal(last.tone, "error")
    assert.match(last.text, /手动/)
    assert.match(last.text, /完全退出/)
    assert.match(last.text, /serve --service/)
    assert.match(last.text, /重新打开/)
    assert.match(last.text, /彻底重启 OpenCode/)
    assert.ok(!last.text.includes("重启成功"))
  }
  assert.match(restartNote("unavailable").text, /手动/)
  assert.match(restartNote("failed").text, /手动/)
  assert.match(restartNote("started").text, /正在重启/)
})

test("确认之后才允许提示正在重启", async () => {
  const result = await drive({ confirmed: true, attempt: "started" })
  assert.equal(result.notes.length, 2)
  assert.match(result.notes[0]!.text, /需要/)
  assert.ok(!result.notes[0]!.text.includes("正在重启"))
  assert.match(result.notes[1]!.text, /正在重启/)
  const confirmAt = result.events.indexOf("confirm")
  const restartingAt = result.events.findIndex((event) => event.includes("正在重启"))
  assert.ok(confirmAt >= 0 && restartingAt > confirmAt, "确认必须发生在『正在重启』之前")
  assert.ok(result.events.indexOf("restart") > restartingAt)
})

test("确认弹窗准确说明实际影响范围", () => {
  for (const dialog of [SELF_UPDATE_CONFIRM, RESTART_CONFIRM]) {
    assert.match(dialog.description, /所有/)
    assert.match(dialog.description, /serve --service/)
    assert.match(dialog.description, /其他/)
    assert.match(dialog.description, /窗口|实例/)
  }
})

test("页面接入可测流程，且自更新分支不提前 return", () => {
  const page = readFileSync(join(process.cwd(), "src/gui/page.tsx"), "utf8")
  assert.match(page, /runSelfUpdateRestart\(\{/)
  assert.ok(!page.includes("插件中心已更新，正在重启"), "不得在确认前提示正在重启")
  const start = page.indexOf("if (result.selfUpdated)")
  const end = page.indexOf("const latest = version")
  assert.ok(start > 0 && end > start)
  const block = page.slice(start, end)
  const code = block
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
  assert.ok(!/\breturn\b/.test(code), "自更新分支不得提前 return，状态同步必须继续")
  assert.match(page, /彻底重启 OpenCode…/, "工具栏重启入口保留")
})
