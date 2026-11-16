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

> 特别说明：当前实现用 window 捕获阶段监听拦截 Escape（keydown）与外部点击（pointerdown），
> 仅在 `running` 阶段生效。`ui.Dialog` 的关闭实现由宿主注入，若宿主在更高优先级或不同阶段
> 处理这些事件，拦截可能失效。上述 7 项必须在真实客户端复验后才能判定通过。
