/**
 * 更新检查 UI 反馈与已安装页状态入口（阶段 3）的静态断言。
 *
 * 与项目内 install-progress.test.ts 同一手法：这些行为是 Solid 模板渲染的结果，
 * 用源码断言锁住关键结构是本项目既有约定，避免为纯展示逻辑引入 DOM 测试框架。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PAGE = readFileSync(join(process.cwd(), "src", "gui", "page.tsx"), "utf8")
const STYLES = readFileSync(join(process.cwd(), "src", "gui", "styles.ts"), "utf8")

test("U1. 手动检查开始即显示「检查中」，完成后给出分类计数", () => {
  assert.match(PAGE, /notify\("检查中……", "info"\)/, "点击后应立即反馈检查中")
  assert.match(PAGE, /检查完成：\$\{stale\} 个可更新，\$\{current\} 个已是最新，\$\{failed \+ unknown\} 个检查失败/, "结果应给出四类计数")
})

test("U2. 结果展示 Registry 实际来源与自动切换原因", () => {
  assert.match(PAGE, /当前使用 \$\{updateRegistry\(\)!\.registryUsed\}/, "应显示实际使用源")
  assert.match(PAGE, /已自动切换：\$\{reg\.message\}/, "应显示切换原因")
  assert.match(PAGE, /data-fallback=\{updateRegistry\(\)!\.fallbackUsed/, "切换状态应有可见标记")
})

test("U3. 检查失败不伪装成无更新：失败原因单独呈现", () => {
  assert.match(PAGE, /版本查询失败：\$\{result\.registry\.error\}/, "registry 失败应显示真实错误")
  assert.match(PAGE, /data-failed=\{updateRegistry\(\)!\.error/, "失败状态有可见标记")
  assert.doesNotMatch(PAGE, /result\.registry\?\.error[\s\S]{0,40}已是最新/, "不得把失败说成最新")
})

test("U4. Registry 设置区域提供 auto/official/mirror 三选项与环境变量提示", () => {
  assert.match(PAGE, /chooseRegistryMode\("auto"\)/, "自动选项")
  assert.match(PAGE, /chooseRegistryMode\("official"\)/, "官方选项")
  assert.match(PAGE, /chooseRegistryMode\("mirror"\)/, "镜像选项")
  assert.match(PAGE, /当前使用自定义 Registry（\$\{status\(\)\.envUrl\}）；UI 中的选择暂不生效/, "环境变量覆盖提示")
})

test("U5. 切换 Registry 模式后清空旧结果并重新检查", () => {
  assert.match(PAGE, /setCheckSummary\(""\)[\s\S]{0,80}void checkUpdates\(false\)/, "切换源后应立即按新模式检查")
})

test("U6. 顶部独立「需要关注」摘要已删除，只保留下方筛选入口", () => {
  assert.doesNotMatch(PAGE, /class="ph-attention"/, "顶部摘要块仍在")
  assert.doesNotMatch(PAGE, /需要关注/, "顶部摘要标题仍在")
  assert.doesNotMatch(STYLES, /\.ph-attention-chip/, "摘要专用样式仍在")
  assert.match(PAGE, /installedFilterButton\("all", "全部"\)/, "全部筛选项保留")
})

test("U7. 筛选项按数量显示，全部始终显示，当前筛选归零回到全部", () => {
  assert.match(PAGE, /<Show when=\{id === "all" \|\| filterCounts\(\)\[id\] > 0\}>/, "零数量的筛选项应隐藏")
  assert.match(
    PAGE,
    /if \(current !== "all" && filterCounts\(\)\[current\] === 0\) setInstalledFilter\("all"\)/,
    "当前筛选归零应回到全部",
  )
})

test("U8. 精确锁定插件显示专用升级入口与来源说明", () => {
  assert.match(PAGE, /stale\(\) && info\(\)\?\.pinnedRegistryUpdate/, "精确锁定升级按钮分流")
  assert.match(PAGE, /升级到 v\{info\(\)!\.latest\}/, "按钮写明目标版本")
  assert.match(PAGE, /registry 发现稳定版 v\{info\(\)!\.latest\}/, "显示 registry 来源")
  assert.match(PAGE, /onClick=\{\(\) => void install\(entry\.name, info\(\)!\.latest\)\}/, "复用 install 安全流程")
})

test("U9. 精确锁定升级仍保持精确版本配置（install 的 target 含版本）", () => {
  const admin = readFileSync(join(process.cwd(), "src", "gui", "admin.ts"), "utf8")
  assert.match(admin, /const target = version\.trim\(\) \? `\$\{name\}@\$\{version\.trim\(\)\}` : name/, "带版本安装写成精确 spec")
})
