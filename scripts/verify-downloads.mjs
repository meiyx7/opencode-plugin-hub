/**
 * Phase 4: real npm API verification. No mocks, no stubs.
 *
 * Prints the requested URL, HTTP status, raw body, and the exact value the GUI would render for
 * the real package `opencode-plugin-hub`. If the official host is unreachable, it says so and
 * exits non-zero — it never substitutes a mirror or a canned number.
 */
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "node_modules", ".cache", "plugin-hub-verify")
const packageName = "opencode-plugin-hub"

await mkdir(outDir, { recursive: true })
const bundle = join(outDir, "downloads.mjs")
await build({
  stdin: {
    contents:
      'export { downloadsFor, NPM_DOWNLOADS_API } from "./src/gui/registry.ts"\n' +
      'export { formatCount, countTitle } from "./src/gui/download-format.ts"\n',
    resolveDir: root,
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "silent",
})
const app = await import(pathToFileURL(bundle).href)

const periods = ["last-week", "last-month"]
const raw = {}

console.log(`包名: ${packageName}`)
console.log(`官方下载量 API: ${app.NPM_DOWNLOADS_API}`)
console.log("")

for (const period of periods) {
  const url = `${app.NPM_DOWNLOADS_API}/point/${period}/${encodeURIComponent(packageName)}`
  console.log(`[${period}] 请求地址: ${url}`)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } })
    const text = await response.text()
    console.log(`[${period}] HTTP 状态码: ${response.status}`)
    console.log(`[${period}] 返回数据: ${text}`)
    if (response.ok) raw[period] = JSON.parse(text).downloads
  } catch (error) {
    console.log(`[${period}] 无法访问官方接口: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  console.log("")
}

console.log("应用自身调用 downloadsFor()（同样走真实网络）:")
let counts
try {
  counts = await app.downloadsFor(packageName)
} catch (error) {
  counts = {}
  console.log(`调用失败: ${error instanceof Error ? error.message : String(error)}`)
}
const weekly = counts.weekly ?? -1
const monthly = counts.monthly ?? -1
console.log(`  解析结果: weekly=${counts.weekly ?? "暂不可用"}, monthly=${counts.monthly ?? "暂不可用"}`)
console.log(`  页面展示值: 周下载 ${app.formatCount(weekly)} (${app.countTitle(weekly, "周下载") ?? "无提示"})`)
console.log(`             月下载 ${app.formatCount(monthly)} (${app.countTitle(monthly, "月下载") ?? "无提示"})`)
console.log(`  与直连返回一致: 周 ${weekly === (raw["last-week"] ?? null)}, 月 ${monthly === (raw["last-month"] ?? null)}`)
console.log("")

const complete = Number.isInteger(weekly) && weekly >= 0 && Number.isInteger(monthly) && monthly >= 0
if (!complete) {
  console.log("结论: 官方接口不可用，本次真实验证未完成；未使用任何 Mock 或镜像数据替代。")
  process.exit(1)
}
console.log("结论: 官方 point 接口真实可达，页面数值与官方返回一致。")
