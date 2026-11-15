/**
 * 生命周期测试：admin.install() 的 selfUpdated 判定、配置控制项识别、`opencode reload` 的结果回传。
 * 只用 Node 内置 node:test、临时目录和 fetch 桩，不引入第三方依赖。
 *
 * selfUpdated 只表示「配置已指向新版本、当前窗口仍是旧构建」；加载交给 OpenCode，
 * 插件中心不重启宿主，因此这里不再有重启确认/状态回传的用例。
 */
import test, { after, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as admin from "../src/gui/admin.ts"

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
// 配置控制项：`-id` 禁用规则与 `*` 通配是规则，不是已安装的插件包
// ---------------------------------------------------------------------------

test("7. 禁用规则与通配项按规则展示，不伪装成插件包", async () => {
  await writeConfig(["-acme.reviewer", "*", "opencode-notify"])
  const state = await admin.snapshot()
  const bySpec = new Map(state.plugins.map((entry) => [entry.spec, entry]))
  assert.equal(bySpec.get("-acme.reviewer")!.kind, "control")
  assert.equal(bySpec.get("-acme.reviewer")!.name, "acme.reviewer", "规则名不带 - 前缀")
  assert.equal(bySpec.get("*")!.kind, "control")
  assert.equal(bySpec.get("opencode-notify")!.kind, "package")
})

test("8. 控制项不触发 registry 查询，也不会被判定为可更新", async () => {
  await writeConfig(["-acme.reviewer", "*"])
  let calls = 0
  route = () => {
    calls += 1
    return new Response("", { status: 404 })
  }
  const result = await admin.updates()
  assert.equal(calls, 0, "控制项不应发任何 registry 请求")
  assert.equal(
    result.items.every((item) => item.hasUpdate === false && item.error === ""),
    true,
  )
})

test("9. 移除禁用规则只删掉这一条，其他条目保留", async () => {
  await writeConfig(["-acme.reviewer", "opencode-notify"])
  const result = await admin.remove("-acme.reviewer")
  assert.equal(result.ok, true)
  assert.deepEqual(await readConfigSpecs(), ["opencode-notify"])
})

test("10. 安装同名插件时追加启用条目，不改写已有禁用规则", async () => {
  await writeConfig(["-acme.reviewer"])
  const result = await admin.install("opencode-notify", "")
  assert.equal(result.ok, true)
  assert.deepEqual(await readConfigSpecs(), ["-acme.reviewer", "opencode-notify"])
})

// ---------------------------------------------------------------------------
// 控制项识别：官方语法是 `-id` / `*` / `.*` / `prefix.*`，而 `pkg@*` 是 npm 版本范围
// ---------------------------------------------------------------------------

test("11. isControlSpec 只认官方语法的规则项", () => {
  const controls = ["-acme.reviewer", "*", ".*", "acme.*", "acme.reviewer.*", "-acme.*", "-acme.reviewer.*"]
  for (const spec of controls) {
    assert.equal(admin.isControlSpec(spec), true, `${spec} 应识别为控制项`)
  }
  for (const spec of ["  *  ", " -acme.reviewer "]) {
    assert.equal(admin.isControlSpec(spec), true, `${spec} 去掉空白后仍是控制项`)
  }
})

test("12. 带版本范围的包名不会被误判成控制项", () => {
  const packages = [
    "foo@*",
    "@scope/foo@*",
    "foo@latest",
    "foo@^1.2.0",
    "foo@1.2.3",
    "opencode-notify",
    "@scope/foo",
    "./local-plugin",
    "",
    "-",
  ]
  for (const spec of packages) {
    assert.equal(admin.isControlSpec(spec), false, `${spec} 不是控制项`)
  }
})

test("13. foo@* 按包展示，名字与版本范围分开", async () => {
  await writeConfig(["foo@*", "@scope/foo@*", "-acme.reviewer"])
  const state = await admin.snapshot()
  const bySpec = new Map(state.plugins.map((entry) => [entry.spec, entry]))
  assert.equal(bySpec.get("foo@*")!.kind, "package")
  assert.equal(bySpec.get("foo@*")!.name, "foo")
  assert.equal(bySpec.get("@scope/foo@*")!.kind, "package")
  assert.equal(bySpec.get("@scope/foo@*")!.name, "@scope/foo")
  assert.equal(bySpec.get("-acme.reviewer")!.kind, "control")
})

test("14. foo@* 会按包名去 registry 查版本", async () => {
  await writeConfig(["foo@*", "-acme.reviewer"])
  const asked: string[] = []
  route = (url) => {
    asked.push(url)
    return json({ name: "foo", "dist-tags": { latest: "1.4.0" }, versions: { "1.4.0": { version: "1.4.0" } } })
  }
  const result = await admin.updates()
  assert.equal(asked.length, 1, "只有包名去查，控制项不发请求")
  assert.match(asked[0]!, /\/foo\/latest$/)
  const bySpec = new Map(result.items.map((item) => [item.spec, item]))
  assert.equal(bySpec.get("foo@*")!.name, "foo")
  assert.equal(bySpec.get("-acme.reviewer")!.hasUpdate, false)
})

// ---------------------------------------------------------------------------
// 配置重载：等子进程真正结束，按退出码报告，不以「进程对象存在」为成功
// ---------------------------------------------------------------------------

test("15. reload 成功只在 opencode reload 退出码为 0 时报告", async () => {
  const result = await admin.reload([process.execPath, "-e", "process.exit(0)"])
  assert.equal(result.ok, true)
  assert.match(result.message, /opencode reload/)
  assert.doesNotMatch(result.message, /Desktop|彻底重启/, "重载不是 Desktop 重启")
  assert.equal(Array.isArray(result.state.plugins), true, "无论成败都回传最新配置状态")
})

test("16. reload 失败带退出码和命令输出，不返回成功", async () => {
  const result = await admin.reload([
    process.execPath,
    "-e",
    "console.error('no background service'); process.exit(3)",
  ])
  assert.equal(result.ok, false)
  assert.match(result.message, /退出码 3/)
  assert.match(result.message, /no background service/)
})

test("17. reload 在 CLI 无法启动时明确失败", async () => {
  const result = await admin.reload([join(temp, "definitely-not-opencode")])
  assert.equal(result.ok, false)
  assert.match(result.message, /无法启动 opencode CLI/)
})

test("18. reload 没有 CLI 时不假装执行过命令", async () => {
  const result = await admin.reload([])
  assert.equal(result.ok, false)
  assert.match(result.message, /找不到 opencode CLI/)
})
