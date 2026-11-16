# 官方 CLI 能力与当前实现对照表（TASK-01 交付）

审计基线：`opencode v2.0.27`（`/Users/meiyx/.opencode/bin/opencode`），
以本机 `opencode plugin --help` 输出与 `docs/real-cli-probe.md` / `docs/real-cli-acceptance.md`
的隔离实测记录为准。审计日期：2026-11-16。

> 原则：先核实命令真实存在、参数与副作用，再决定是否改代码。本表只记录事实与结论；
> 「是否需要调整」为 `否` 的操作保持现有生产代码不变。

## 一、命令真实存在性（`opencode plugin --help`）

`plugin` 子命令实有五个：`list`、`add`、`check`、`update`、`remove`。
候选命令全部真实存在，当前版本支持；无虚构命令。

## 二、对照表

| 操作 | 当前实现 | 官方能力 | 是否需要调整 | 调整原因 |
|---|---|---|---|---|
| 安装（全新） | `pluginAdd(target)` 写入全局配置 + 共享缓存；随后 `editConfig` 结果核验 | `opencode plugin add <pkg>`，自动写全局配置；支持 `pkg@version`；不校验插件入口 | 否 | 已用官方机制；命令退出码不作为唯一依据，额外读配置与 manifest 核验 |
| 指定版本安装 | `install(spec, version)` → `pluginAdd(pkg@version)` | `plugin add pkg@version` 支持精确版本，版本不存在则失败且不写配置 | 否 | 已支持；失败时旧配置不变（实测场景 2） |
| 换版本（已装） | 隔离目录 `pluginAddIsolated` 准备目标版本 → 校验 manifest → `editConfig` 一次性切换，**全程不 remove 旧条目** | 官方**没有**「原地换版本」能力：`plugin add pkg@new` 只会追加，留下重复声明 | 否 | 现有实现规避了官方 CLI 的追加语义，用「隔离准备 + 原子切换」实现换版本；这是必要且正确的自定义编排，不改 |
| 插件列表读取 | `pluginList()` + 本地 manifest（`locatePackage`） | `opencode plugin list`，问的是**运行中的宿主**，不读当前配置目录 | 否 | 已知边界：`list/check/update` 作用于宿主且不可隔离。列表展示以配置为事实源，运行时信息仅作补充，不把宿主返回当作配置事实 |
| 更新（普通插件） | `pluginUpdate(entry.spec)` + 结果核验 | `opencode plugin update <target>`；只更新包插件，跳过本地目录与精确锁定；无更新时打印 `No plugin updates available` | 否 | 已用官方机制；退出 0 不等于状态变化，额外读配置核验（实测/单测覆盖） |
| 移除（npm 插件） | `pluginRemove(entry.spec)` + 结果核验 | `opencode plugin remove <spec>`，只改配置、不动缓存包文件；未配置时打印 `is not configured`（exit 0） | 否 | 已用官方机制；对「未配置」退出 0 的语义做了结果核验，不误报成功 |
| 移除（本地目录） | 仅 `editConfig` 删除配置引用，**不删除用户目录** | 官方无「删除本地目录」命令 | 否 | 保持现有谨慎策略，绝不递归删用户目录 |
| 配置读取/写入 | `readConfig` / `editConfig`（jsonc 单节点编辑，保留注释与权限，检测跨进程并发） | CLI 的 add/remove/update 会重写整个配置文件并可能改权限（实测 0640→0600）、重排格式 | 否 | 需要精细编辑的场景（换版本/暂停/恢复/规则/本地移除）继续用插件中心的 jsonc 编辑；安装/移除/更新交给官方 CLI，二者各司其职 |
| 命令后配置核验 | 每个操作后 `setState(result.state)` + `verify()` / `loadRuntime()` | CLI 退出码不代表最终配置/运行状态 | 否 | 已实现多层核验，不把退出码当唯一依据 |
| 启用/暂停状态 | 基于配置规则的 `pause` / `resume` + `evaluateRules` | 官方无独立「暂停插件」命令；通过配置禁用规则实现 | 否 | 见 TASK-03：保持基于配置规则的机制，不创造新协议 |

## 三、关键事实（来自隔离实测，不可从帮助文本推断）

1. `plugin add` 只追加、不替换；换版本若直接用它会产生重复声明 —— 因此换版本走「隔离准备 + 原子切换」。
2. `plugin add` 不校验插件入口是否可加载（`left-pad` 也能装成功）—— 命令成功 ≠ 插件可用。
3. `list`/`check`/`update` 问的是运行中宿主，不可在隔离环境做写操作验收 —— 相关真实运行时行为标注为未验证。
4. 官方 CLI 重写配置会重排格式、可能改权限；插件中心的 jsonc 编辑保留更多原始格式与权限。

## 四、结论

当前生产代码对官方 CLI 的使用与真实能力一致：**安装/更新/移除走官方命令，换版本/暂停/恢复/配置精细编辑走插件中心的原子写入并在操作后重新核验**。
TASK-02「统一 npm 插件管理实现」不需要替换现有机制 —— 现有实现已满足「优先使用官方机制、不把退出码当唯一依据、操作后重读配置、保留指定版本安装/本地目录/自身更新」的要求。
本批不改动生产代码，避免为「统一」而破坏已验证的行为。

## 五、TASK-03 / TASK-04 核查结论（暂停 / 恢复 / 卸载）

逐项对照需求与 `src/gui/admin.ts` 现有实现，结论均为**已满足，无需改代码**：

| 需求 | 现有实现位置 | 结论 |
|---|---|---|
| 暂停只写配置规则、不动包与磁盘 | `pauseLocked`：追加 `-<runtime id>`，条目与包文件都不动 | 已满足 |
| 暂停幂等（重复暂停不重复写） | `pauseLocked`：`state0.verdict.disabled` 直接返回 unchanged；队列内再查一次 | 已满足 |
| 恢复只删自己的精确规则、通配不动 | `resumeLocked`：`exactRulesFor` 只挑精确规则，通配保留 | 已满足 |
| 恢复幂等 | `resumeLocked`：无规则时直接返回 unchanged | 已满足 |
| 只改目标插件、保留其它字段 | `editConfig` jsonc 单节点编辑 + `entryBySpec` 并发守卫 | 已满足 |
| 配置解析失败不覆盖、报明示错误 | `readConfig().parseError` 提前返回 | 已满足 |
| 配置写入失败保留原状 | `written.ok` / `applied` / `gone` 三处写后核验 | 已满足 |
| 插件不存在给明示提示 | `findBySpec` 空值返回「配置中没有这一项」 | 已满足 |
| 拿不到运行时 ID 不猜、零改动 | `resolveId` 失败返回 `id=""` 并拒绝 | 已满足 |
| 暂停/恢复成功 ≠ 运行时立即重载 | 返回 `verification` 明确宿主尚未确认 | 已满足 |
| npm 移除走官方命令并写后核验 | `pluginRemove` + `gone` 核验，命令成功但配置仍在则 `ok:false` | 已满足 |
| 本地目录移除只删配置引用、绝不递归删目录 | `removeLocked` path 分支仅 `editConfig`，明示磁盘目录未删 | 已满足 |
| 不误删其它插件 | jsonc 单节点编辑 + 写后 `gone` 只针对目标 spec | 已满足 |

对应测试：`tests/rules.test.ts`（规则形状/优先级）、`tests/lifecycle-safety.test.ts`
用例 13/14/15/16/17/18/19/29/30（并发、注释保留、通配、自定义 ID、幂等、只追加、
移除失败不谎报、本地目录不删盘）。均为既有覆盖，本批未改动相关逻辑与测试。

## 六、TASK-05 / TASK-06 / TASK-07 核查与改动结论

| 任务 | 结论 | 改动 |
|---|---|---|
| TASK-05 统一状态模型 | 列表判定原已集中在 `runtimeState`，但埋在组件里、无法单测 | 抽出纯函数 `status-view.ts`（`classifyState`/`severityOf`/`needsAttention`），列表徽章、排序、摘要共用；排序语义严格不变；新增 `tests/status-view.test.ts` 覆盖全部状态与排序 |
| TASK-06 异常反馈 | `feedback.ts` 已按 stages 分类；前端 catch 的错误此前只处理版本不一致 | 抽出纯函数 `error-view.ts`，覆盖网络/权限/配置/版本/版本不一致/未知六类，保留底层原因、文案各异；`readableError` 委托之；新增 `tests/error-view.test.ts` |
| TASK-07 交互一致性 | 第一批已统一安装/更新的进度 Dialog；`track()` 统一防重复；各操作后刷新列表/详情 | 无额外改动；逐项核对见下 |

TASK-07 逐项核对（均满足）：
- 按钮 Loading：`busy={isBusy(install:${name})}` 覆盖所有生命周期按钮；
- 重复提交：`track()` 单飞守卫 + 后端 `withLock()` 双层；
- 完成后刷新：install/update/uninstall 后 `setState` + `loadRuntime()` + `checkUpdates(true)`；
- 列表与详情状态一致：详情 `installed/current/hasUpdate` 来自同一后端 detail 结果，状态判定共用 status-view；
- Dialog 提前关闭：第一批已修复详情安装不再先关闭，进度期锁住 Escape/外部点击/关闭按钮；
- 失败后恢复交互：`track()` 的 `finally { end(key) }` 保证忙碌态释放；
- 搜索/列表切换不影响在途操作：操作状态在页面组件生命周期内，tab 切换只重置筛选不动在途 Promise。

## 七、未验证项（受环境限制，不冒充真实运行验证）

- `opencode plugin update` / `check` / `list` 作用于运行中宿主，无法在隔离环境做写操作验收（详见 real-cli-probe.md 第 8 节）；
- 「自身更新后宿主确认加载新版本」的真实成功路径：本机运行版本已是最新，无更高已发布版本可升；由假 CLI 单测覆盖，非真机验证；
- 进度 Dialog 的 Escape/外部点击拦截依赖捕获阶段监听；宿主 Dialog 的实际关闭实现不在本仓库（`@opencode/plugin` 的 gui 实现由宿主注入），需在真实客户端窗口复验拦截是否生效。
