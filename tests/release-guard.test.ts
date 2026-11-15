/**
 * 发布工作流专项测试：分支限制、版本保护、npm 版本占用检查的每一种 HTTP / 网络结果。
 * 直接运行 publish.yml 调用的 scripts/verify-release.mjs，用本地 HTTP server 注入响应，
 * 不访问真实 npm registry，也不引入第三方依赖。
 */
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

const root = process.cwd()
const script = join(root, "scripts", "verify-release.mjs")
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version

type Mode = { kind: "respond"; status: number } | { kind: "hang" } | { kind: "reset" }
let mode: Mode = { kind: "respond", status: 404 }
let server: Server
let base: string

before(async () => {
  server = createServer((_req, res) => {
    if (mode.kind === "hang") return // never answer: the client must time out
    if (mode.kind === "reset") {
      res.destroy()
      return
    }
    res.writeHead(mode.status, { "content-type": "application/json" })
    res.end(mode.status === 200 ? JSON.stringify({ version }) : JSON.stringify({ error: "fixture" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface GuardResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Async spawn (not spawnSync): the local server must stay free to answer the child. */
function runGuard(overrides: Record<string, string> = {}): Promise<GuardResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "main",
        INPUT_VERSION: version,
        NPM_REGISTRY_BASE: base,
        NPM_LOOKUP_TIMEOUT_MS: "1000",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

const tagEnv: Record<string, string> = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: `refs/tags/v${version}`,
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_NAME: `v${version}`,
  INPUT_VERSION: "",
}

// ---------------------------------------------------------------------------
// 1. 手动发布分支限制
// ---------------------------------------------------------------------------

test("手动发布：从 main 触发且版本未被占用 → 通过", async () => {
  mode = { kind: "respond", status: 404 }
  const result = await runGuard()
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /HTTP 404/)
  assert.match(result.stdout, /Release version verified/)
})

test("手动发布：从非 main 分支或 tag 触发 → 发布前明确失败", async () => {
  mode = { kind: "respond", status: 404 }
  for (const ref of ["refs/heads/feature/x", "refs/heads/hotfix", `refs/tags/v${version}`]) {
    const result = await runGuard({ GITHUB_REF: ref })
    assert.notEqual(result.code, 0, `${ref} 必须被拒绝`)
    assert.match(result.stderr, /refs\/heads\/main/, `${ref} 的原因必须写明 main`)
  }
})

test("Tag 触发保持原有逻辑：tag 对应提交照常发布，不受分支限制", async () => {
  mode = { kind: "respond", status: 404 }
  const result = await runGuard(tagEnv)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Release version verified/)
})

test("未知触发方式直接失败（fail-closed）", async () => {
  mode = { kind: "respond", status: 404 }
  const result = await runGuard({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF_TYPE: "branch" })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /unsupported trigger/)
})

// ---------------------------------------------------------------------------
// 2. 保留的原有版本保护
// ---------------------------------------------------------------------------

test("Tag 与手动输入版本都必须与 package.json 一致", async () => {
  mode = { kind: "respond", status: 404 }
  const badTag = await runGuard({
    ...tagEnv,
    GITHUB_REF: "refs/tags/v9.9.9",
    GITHUB_REF_NAME: "v9.9.9",
  })
  assert.notEqual(badTag.code, 0)
  assert.match(badTag.stderr, /package\.json/)

  const badInput = await runGuard({ INPUT_VERSION: "9.9.9" })
  assert.notEqual(badInput.code, 0)
  assert.match(badInput.stderr, /package\.json/)
})

test("SemVer 格式检查：非法版本与空输入一律拒绝", async () => {
  mode = { kind: "respond", status: 404 }
  for (const value of ["0.3", "v0.3.6", "0.3.6.1", "0.3.6 evil", ""]) {
    const result = await runGuard({ INPUT_VERSION: value })
    assert.notEqual(result.code, 0, `应拒绝 ${JSON.stringify(value)}`)
  }
})

// ---------------------------------------------------------------------------
// 3. npm 版本占用检查：只有确定的 404 才允许发布
// ---------------------------------------------------------------------------

test("HTTP 200：版本已存在，禁止发布", async () => {
  mode = { kind: "respond", status: 200 }
  const result = await runGuard()
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /already published/)
})

test("5xx / 权限错误 / 其它异常状态：无法确认，禁止发布", async () => {
  for (const status of [500, 502, 503, 504, 401, 403, 429, 418]) {
    mode = { kind: "respond", status }
    const result = await runGuard()
    assert.notEqual(result.code, 0, `HTTP ${status} 必须拒绝发布`)
    assert.match(result.stderr, /cannot confirm/, `HTTP ${status} 必须说明无法确认`)
  }
})

test("网络超时、连接失败、连接被重置：都不能跳过占用检查", async () => {
  mode = { kind: "hang" }
  const slow = await runGuard({ NPM_LOOKUP_TIMEOUT_MS: "250" })
  assert.notEqual(slow.code, 0)
  assert.match(slow.stderr, /cannot confirm/)

  mode = { kind: "reset" }
  const reset = await runGuard()
  assert.notEqual(reset.code, 0)
  assert.match(reset.stderr, /cannot confirm/)

  mode = { kind: "respond", status: 404 }
  const refused = await runGuard({ NPM_REGISTRY_BASE: "http://127.0.0.1:1" })
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /cannot confirm/)
})

// ---------------------------------------------------------------------------
// 4. YAML 接线与原有发布保护没有丢失
// ---------------------------------------------------------------------------

test("publish.yml 接入新 guard 并保留 Trusted Publishing / provenance / 测试门禁", () => {
  const yml = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8")
  assert.match(yml, /tags: \['v\*'\]/, "tag 触发保持原样")
  assert.match(yml, /workflow_dispatch:/)
  assert.match(yml, /refs\/heads\/main/, "YAML 层的手动分支限制")
  assert.match(yml, /node scripts\/verify-release\.mjs/)
  assert.match(yml, /npm ci/)
  assert.match(yml, /npm test/)
  assert.match(yml, /npm run typecheck/)
  assert.match(yml, /id-token: write/, "OIDC 权限保留")
  assert.match(yml, /npm install -g npm@latest/)
  assert.match(yml, /npm publish --access public --provenance/)
  assert.ok(!yml.includes("npm view"), "旧的『npm view 失败即视为未发布』逻辑不得残留")
})
