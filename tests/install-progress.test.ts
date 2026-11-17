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

test("04. 执行期外部点击锁：只监听 pointerdown/click，Escape 交给宿主 data-owns-escape", () => {
  const LOCK = readFileSync(join(process.cwd(), "src/gui", "dialog-lock.ts"), "utf8")
  assert.match(PAGE, /useLockDialogWhileRunning/, "缺少执行期外部点击锁")
  assert.match(PAGE, /shouldLockEvent/, "锁未使用纯判定函数")
  // 只监听 pointerdown / click 两类外部点击事件，捕获阶段注册并在卸载时移除。
  for (const type of ["pointerdown", "click"]) {
    assert.match(PAGE, new RegExp(`window\\.addEventListener\\("${type}", handler, true\\)`), `未监听 ${type}(捕获)`)
    assert.match(PAGE, new RegExp(`window\\.removeEventListener\\("${type}", handler, true\\)`), `${type} 监听未在清理时移除`)
  }
  // 旧的 window keydown 拦截已删除（Escape 由宿主正式能力负责）。
  assert.doesNotMatch(PAGE, /addEventListener\("keydown"|removeEventListener\("keydown"/, "仍保留无效的 keydown 监听")
  // 判定逻辑里不应再有 keydown 分支、key 字段或 ownsEscapeWhileRunning 实现（注释里说明不处理 Escape 不算）。
  assert.doesNotMatch(LOCK, /event\.key|ownsEscapeWhileRunning\s*\(|type === "keydown"/, "dialog-lock 仍残留 keydown/Escape 逻辑")
  assert.match(LOCK, /isOutside === true/, "纯判定未在“外部”时才拦点击事件")
  assert.match(LOCK, /closest|content/, "缺少内容元素识别（containment）")
  assert.match(PAGE, /closable=\{!running\(\)\}/, "独立 Dialog 执行期未隐藏关闭按钮")
  assert.match(PAGE, /closable=\{!progressRunning\(\)\}/, "详情 Dialog 执行期未隐藏关闭按钮")
})

test("04b. 进度根 running 时声明 data-owns-escape，done 后撤销（Escape 交宿主）", () => {
  assert.match(
    PAGE,
    /data-owns-escape=\{props\.state\.phase === "running" \? "" : undefined\}/,
    "进度根未按运行状态声明 data-owns-escape",
  )
  assert.match(PAGE, /autofocus[\s\S]{0,120}tabindex="-1"/, "焦点未引导到进度子树内")
  assert.match(PAGE, /onMount\(\(\) => rootEl\?\.focus/, "挂载后未主动把焦点置于进度子树")
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

test("06c. ph 变量作用域必须覆盖每个弹框根，否则整块样式退化为纯文字", () => {
  const styles = readFileSync(join(process.cwd(), "src/gui", "styles.ts"), "utf8")
  // 先剥掉注释再取选择器：注释里也会出现类名，否则断言会被自己的说明文字骗过。
  const bare = styles.replace(/\/\*[\s\S]*?\*\//g, "")
  const scopeMatch = bare.match(/([.\w\s,:>-]+)\{\s*\n\s*--ph-strong:/)
  assert.ok(scopeMatch, "未找到 ph 变量定义块")
  const scope = scopeMatch[1]!

  // 宿主 ui.Dialog 把 children 与 footer 渲染到彼此独立的容器里，两者都不在 .ph-root 之内，
  // 因此每个弹框子树的根都必须自己成为变量作用域，否则该子树所有 var(--ph-*) 未定义。
  const roots = new Set([".ph-progress", ".ph-detail"])
  for (const m of PAGE.matchAll(/footer=\{[\s\S]{0,1500}?<div class="([^"]+)"/g)) {
    for (const cls of m[1]!.split(/\s+/)) if (cls.startsWith("ph-")) roots.add(`.${cls}`)
  }
  assert.ok(roots.size >= 3, "未能从 page.tsx 识别出弹框子树根")
  for (const root of roots) {
    assert.ok(scope.includes(root), `${root} 是弹框子树根，却不在 ph 变量作用域内（会退化成无样式文字）`)
  }
  // 依赖关系成立性：这些规则确实引用了 ph 变量，漏作用域就会真的失效。
  assert.match(styles, /\.ph-step-ico\s*\{[^}]*var\(--ph-/, "节点样式应依赖 ph 变量")
})

test("06b. 时间轴是真正的可视化：独立节点 + 连续连接线 + 各状态色 + 失败就地错误", () => {
  const styles = readFileSync(join(process.cwd(), "src/gui", "styles.ts"), "utf8")
  // 每个步骤有独立圆形节点，节点之间由 ::before 竖向连接线相连。
  assert.match(PAGE, /class="ph-step-ico"/, "缺少独立状态节点")
  assert.match(styles, /\.ph-step::before[\s\S]{0,160}left:/, "缺少连续竖向连接线")
  assert.match(styles, /\.ph-step:last-child::before\s*\{\s*display:\s*none/, "最后一步不应有下延伸线")
  // 四种状态各有明确视觉，pending / running / done / failed / skipped 均可区分。
  for (const state of ["pending", "running", "done", "failed", "skipped"]) {
    assert.match(styles, new RegExp(`\\.ph-step\\[data-state="${state}"\\] \\.ph-step-ico`), `${state} 节点缺少独立样式`)
  }
  assert.match(styles, /ph-step-error/, "失败节点没有就地错误样式")
  // 进行中步骤的连接线用强调色，与 pending 的灰色区分开（任务状态样式表）。
  assert.match(styles, /\.ph-step\[data-state="running"\]::before\s*\{[^}]*--ph-accent/, "running 连接线未用强调色")
  assert.match(PAGE, /step\.state === "failed" && step\.error/, "失败节点没有渲染真实错误")
  // 完成后保留完整时间轴：结果区渲染在步骤列表之后，不折叠成一行。
  assert.ok(PAGE.indexOf("<ol class=\"ph-steps\">") < PAGE.indexOf("ph-progress-result"), "时间轴应保留在结果区之前")
})

test("07. 原统一出口约束仍成立：五个入口 reportMutation、唯一 explainMutation", () => {
  for (const name of ["install", "updatePlugin", "pausePlugin", "resumePlugin", "uninstall"]) {
    assert.match(bodyOf(name), /reportMutation\(result/, `${name} 没有走统一出口`)
  }
  const calls = PAGE.split("\n").filter((line) => line.includes("explainMutation("))
  assert.equal(calls.length, 1, `explainMutation 应只被调用一次，实际 ${calls.length}`)
})
