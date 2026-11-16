/**
 * 安装 / 更新进度 Dialog 的源码结构断言（项目无 jsdom，无法做真实 DOM 点击）。
 *
 * 这些断言防的是「某个入口绕过统一进度机制」「详情安装先关闭 Dialog」「执行期仍可关闭」
 * 这类回归；真正的渲染正确性由 typecheck + build + 预览人工核对。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PAGE = readFileSync(join(process.cwd(), "src/gui", "page.tsx"), "utf8")

function bodyOf(name: string): string {
  const start = PAGE.indexOf(`const ${name} = async`)
  assert.ok(start >= 0, `page.tsx 里找不到入口 ${name}`)
  const rest = PAGE.slice(start + 10)
  const end = rest.indexOf("\n  const ")
  return end < 0 ? rest : rest.slice(0, end)
}

test("01. install / updatePlugin 都设置 running 进度并收敛为 done", () => {
  for (const name of ["install", "updatePlugin"]) {
    const body = bodyOf(name)
    assert.match(body, /setProgress\(\{/, `${name} 没有设置进度`)
    assert.match(body, /phase: "running"/, `${name} 没有进入执行中`)
    assert.match(body, /finishProgress\(/, `${name} 没有收敛为结果`)
    assert.match(body, /failProgress\(/, `${name} 异常路径未收敛进度`)
  }
})

test("02. 详情页安装不再先 dialog.close() 再 install", () => {
  const start = PAGE.indexOf("const openDetail =")
  assert.ok(start >= 0)
  const rest = PAGE.slice(start)
  const block = rest.slice(0, rest.indexOf("\n  }") + 4)
  assert.doesNotMatch(block, /dialog\.close\(\)\s*\n\s*void install/, "详情安装仍先关闭 Dialog 再启动操作")
  assert.match(block, /void install\(name, version, true\)/, "详情安装应走 fromDetail 就地切换")
  assert.match(block, /progress=\{progress\(\)\?\.op\.name === name/, "详情未接收进度状态")
})

test("03. 所有 install/updatePlugin 入口都统一（无遗漏的直接 admin 调用）", () => {
  // 除定义处外，admin.install/admin.update 只在 install()/updatePlugin() 内各出现一次。
  const adminInstall = PAGE.match(/admin\.install\(/g) ?? []
  const adminUpdate = PAGE.match(/admin\.update\(/g) ?? []
  assert.equal(adminInstall.length, 1, `admin.install 直呼点应只有一处，实际 ${adminInstall.length}`)
  assert.equal(adminUpdate.length, 1, `admin.update 直呼点应只有一处，实际 ${adminUpdate.length}`)
  // 6 个 UI 入口都通过 void install / void updatePlugin 调用。
  const entryCalls = PAGE.match(/void (install|updatePlugin)\(/g) ?? []
  assert.ok(entryCalls.length >= 6, `安装/更新入口应至少 6 处，实际 ${entryCalls.length}`)
})

test("04. 执行期间锁住所有关闭路径：closable 与 window 捕获监听", () => {
  assert.match(PAGE, /useLockDialogWhileRunning/, "缺少执行期关闭锁")
  assert.match(PAGE, /window\.addEventListener\("keydown", onKey, true\)/, "未拦截 Escape")
  assert.match(PAGE, /window\.addEventListener\("pointerdown", onPointer, true\)/, "未拦截外部点击")
  assert.match(PAGE, /event\.key === "Escape"/, "未识别 Escape 键")
  assert.match(PAGE, /closable=\{!running\(\)\}/, "独立 Dialog 执行期未隐藏关闭按钮")
  assert.match(PAGE, /closable=\{!progressRunning\(\)\}/, "详情 Dialog 执行期未隐藏关闭按钮")
})

test("05. 关闭按钮只在结果阶段出现（执行期不可关闭）", () => {
  assert.match(PAGE, /<Show when=\{done\(\)\}>/, "独立 Dialog 关闭按钮未按 done 条件渲染")
  assert.match(PAGE, /<Show when=\{state\(\)\.phase === "done"\}>/, "详情 Dialog 关闭按钮未按 done 条件渲染")
})

test("06. 不伪造进度：无定时器推进阶段、无百分比字段", () => {
  const pv = readFileSync(join(process.cwd(), "src/gui", "progress-view.ts"), "utf8")
  assert.doesNotMatch(pv, /setTimeout|setInterval/, "阶段推进不应使用定时器")
  // 只看真实的百分比字面量（数字+%），注释里的“百分比”一词不算。
  assert.doesNotMatch(pv, /\d+\s*%/, "不应出现百分比数值")
  assert.match(PAGE, /import \{[\s\S]*buildProgressReport[\s\S]*\} from "\.\/progress-view"/, "未接入纯函数映射")
})

test("07. 原统一出口约束仍成立：五个入口 reportMutation、唯一 explainMutation", () => {
  for (const name of ["install", "updatePlugin", "pausePlugin", "resumePlugin", "uninstall"]) {
    assert.match(bodyOf(name), /reportMutation\(result/, `${name} 没有走统一出口`)
  }
  const calls = PAGE.split("\n").filter((line) => line.includes("explainMutation("))
  assert.equal(calls.length, 1, `explainMutation 应只被调用一次，实际 ${calls.length}`)
})
