# 进度 Dialog 关闭行为 · 真实宿主交互验证记录

## 结论：未验证（受执行环境限制）

本轮修复（`feat/install-update-progress` @ 修复提交）涉及「执行期禁止关闭 Dialog」的
Escape / 外部点击拦截，以及详情 Dialog 关闭后清理进度状态。这些行为依赖宿主注入的
`ui.Dialog` 实现与真实客户端窗口事件，无法在当前环境用真实宿主验证。

### 为什么不能在真实宿主验证

- 本机确实运行着 OpenCode 桌面客户端（`/Applications/OpenCode.app`，CLI `2.3.0-arm64`
  的 `serve --service`，窗口 renderer 进程在跑），但**它加载的是 npm 上已发布的
  `opencode-plugin-hub@0.6.1`**（见 `~/.config/opencode/opencode.json`），
  而本修复是 `feat/install-update-progress` 分支上**尚未发布、未合并**的工作区改动。
- 要把本修复放进真实宿主窗口，需要 npm 发布并改用户配置安装新版本——本任务明确禁止
  「发布 npm / 合并 main / 修改真实配置」。因此真实宿主里跑不到本次改动。
- 客户端未暴露 Chrome DevTools Protocol 调试端口（监听端口均为 service RPC，非 CDP），
  无法从外部驱动真实窗口做点击/按键验证。

### 已用替代验证（不等于真实宿主验证，仅作单元/结构层面保证）

- 纯函数 `shouldClearProgress` 单测覆盖：完成/失败后关闭清理、执行中不清理、
  只清本包不误清其它包、无进度时无需清理。
- 源码结构断言覆盖：详情 `onClose` 已接入条件清理、独立 Dialog 清理逻辑未变、
  执行期 Escape/外部点击锁与 `closable=false` 仍在、关闭回调只 close 一次且不触发重复刷新。
- 本地预览（Vite + mock 宿主组件）验证了阶段时间线、执行中只有一个进行中状态、
  执行期无关闭按钮、结果态展示与详情页就地切换。预览的 Dialog 是 mock，
  **不能证明真实宿主的 Escape/外部点击拦截生效**。

### 待真实环境补验清单（发布到测试环境后由人工执行）

1. 安装期间按 Escape，Dialog 不关闭。
2. 更新期间按 Escape，Dialog 不关闭。
3. 安装期间点击 Dialog 外部，Dialog 不关闭。
4. 更新期间点击 Dialog 外部，Dialog 不关闭。
5. 操作期间关闭按钮不可用（标题栏 X 与底部关闭按钮均不可见/不可用）。
6. 操作完成后可以正常关闭。
7. 关闭详情后再次打开同一插件详情，不残留上一次进度/结果。

> 特别说明：当前实现用 window 捕获阶段监听拦截 Escape（keydown）与外部点击（pointerdown/click），
> 仅在 `running` 阶段生效，且只对「落在 Dialog 内容之外」的指针事件拦截（内容元素识别见下）。
> `ui.Dialog` 的关闭实现由宿主注入，若宿主在更高优先级或不同阶段处理这些事件，拦截可能失效。
> 上述 7 项必须在真实客户端复验后才能判定通过。

## 宿主 Dialog 事件模型核查（基于本机 OpenCode.app 的 app.asar，v2.3.0 / CLI 2.0.27）

为避免“凭猜测加 DOM 选择器或假定宿主结构”，直接从已安装客户端的
`app.asar` 源码映射（`main-*.js.map`）提取并核对了真实实现：

- `ui/src/runtime/plugin/ui.tsx`：插件的 `ui.Dialog` 只把 `closable===false` 映射为
  `DialogHeader hideClose`（仅隐藏标题栏 X），**不透传** `ref` / `class` /
  `preventBackdropDismiss`。因此插件无法用 props 选择退出关闭，也拿不到 Dialog DOM 句柄。
- `ui/src/overlays/dialog/dialog.tsx`：Dialog 内容元素是 Kobalte `Content`，
  带 `data-slot="dialog-content"`；Kobalte `DialogContent` 还带 `role="dialog"`。
  覆盖层 `data-component="dialog-overlay"` 的 `onClick` 触发 `backdrop.click` dismiss。
- `ui/src/context/dialog.tsx`：Escape 由**捕获阶段**的 `window keydown` 处理 → `dispatch(dismiss)`；
  外部点击最终也走同一 dismiss 状态机。
- `@kobalte/core` 的 `create-interact-outside`：`document` 捕获阶段监听 `pointerdown`，
  用 `content.contains(target)` 判断内外；外部事件发 cancelable CustomEvent，
  Dialog 据此 `onDismiss`。`role="dialog"` / `data-slot="dialog-content"` / `contains` 均为真实实现。

结论：把 window 捕获监听改成「仅拦 Escape 键 + 仅拦 target 不在 Dialog 内容元素内的 pointerdown/click」
是有据可依的收窄；内容元素由进度体根节点 `closest('[data-slot="dialog-content"], [role="dialog"]')` 取得，
找不到时退回进度体自身（范围仍严格小于整窗，绝不无差别锁窗口），且判定集中在纯函数 `dialog-lock.ts` 单测。

### 本轮已用「真实事件派发」验证（本地预览 + mock 宿主组件，非真实客户端）

在预览页用 `dispatchEvent` 派发真实 KeyboardEvent / PointerEvent，核对 `defaultPrevented`：

| 阶段 | 内部 pointerdown/click | 外部 pointerdown/click | Escape | Tab |
|---|---|---|---|---|
| running | 放行(false) | 拦截(true) | 拦截(true) | 放行(false) |
| done | 放行 | 放行 | 放行 | 放行 |

> 这验证的是收窄后的**判定逻辑**，不是宿主是否真的据此关闭。真实客户端里
> Escape/外部点击是否被宿主更高优先级的监听抢先处理，仍需按上面 7 项人工复验。
