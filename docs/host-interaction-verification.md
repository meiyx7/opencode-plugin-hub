# 进度 Dialog 关闭行为 · 当前实现说明

本插件在「安装 / 更新」执行期阻止 Dialog 被关闭，职责划分如下：

- **Escape**：完全交给 OpenCode 宿主的正式 `data-owns-escape` 能力。插件不注册任何 keydown 监听。
- **外部点击**：由插件在 window 捕获阶段做局部拦截（只拦落在 Dialog 内容范围之外的 pointerdown / click）。
- **关闭按钮**：执行期隐藏（标题栏 `closable=false`、底部关闭按钮仅在结果态出现），操作结束后恢复。

真实客户端交互 **未验证**（见文末）。

## 1. 宿主 data-owns-escape 的源码依据

证据来自本机 OpenCode.app（v2.3.0）`app.asar` 中 `main-*.js.map` 内嵌的真实源码，非推测：

- `ui/src/context/dialog.tsx` 的 `onKeyDown(event)`：
  ```
  if (event.key !== "Escape") return
  if (within && event.target instanceof Node && !within.contains(event.target)) return
  if (event.target instanceof Element && event.target.closest("[data-owns-escape]")) return
  dispatch({ type: "dismiss" })
  event.preventDefault()
  event.stopPropagation()
  ```
- 宿主以 `createEffect(() => { if (!open()) return; makeEventListener(window, "keydown", onKeyDown, { capture: true }) })`
  在 window 捕获阶段处理 Escape；`makeEventListener` 同步调用 `addEventListener`。

## 2. 宿主如何跳过 Escape dismiss

`dispatch(dismiss)` **之前**，宿主检查 `event.target.closest("[data-owns-escape]")`：
若当前焦点元素的祖先链（含自身）带 `data-owns-escape`，宿主直接 `return`，不关闭 Dialog。

这是宿主 **handler 内部** 的判断，与插件监听器是否注册、注册先后、`defaultPrevented` 都无关——
因此比“插件自己注册 keydown 去拦宿主”可靠（后者因宿主先注册、且不读 `defaultPrevented` 而无效，
本实现已删除此类监听）。

## 3. 插件如何把属性限制在 running 阶段

进度内容根节点（`ProgressBody` 的根 `div`）按运行状态声明：

```tsx
data-owns-escape={props.state.phase === "running" ? "" : undefined}
```

- `running` 时属性存在 → 宿主放行 Escape，Dialog 不关；
- `done` 后属性移除 → Escape 恢复正常关闭语义。

## 4. 插件如何让宿主识别该属性

Escape 的 `event.target` 是当前焦点元素。根节点设 `tabindex="-1"`、`autofocus`，并在 `onMount`
时主动 `rootEl.focus({ preventScroll: true })`，使焦点落在带 `data-owns-escape` 的子树内。
进度执行期 Dialog 内没有其它可聚焦控件，因此焦点稳定命中该属性，宿主可稳定识别。

## 5. 外部点击为何仍需插件局部拦截

外部点击不由 `data-owns-escape` 处理，宿主仍会关闭：

- 覆盖层 `data-component="dialog-overlay"` 的 `onClick` 触发 `backdrop.click` dismiss；
- Kobalte 的 `create-interact-outside` 在 `document` 捕获阶段监听 `pointerdown`，
  用 `content.contains(target)` 判断内外，外部即触发 `onDismiss`。

因此插件在 window 捕获阶段监听 `pointerdown` / `click`，只对「落在 Dialog 内容范围之外」的事件
`preventDefault + stopImmediatePropagation`；内容元素由进度根 `closest('[data-slot="dialog-content"], [role="dialog"]')`
取得，找不到时退回进度根自身（范围始终小于整窗）。Dialog 内部交互一律放行，无法判定内外时不拦截。
判定逻辑集中在纯函数 `dialog-lock.ts`，由单元测试覆盖。

## 6. 真实客户端验证状态

**未验证。** 本机运行中的宿主加载的是 npm 已发布 `0.6.1`，不是本分支未发布改动；
客户端也未暴露 CDP 调试端口，无法从外部驱动真实窗口做按键/点击验证。
上述结论为源码层面依据 + 事件传播推导 + 本地 mock 预览实测，不能替代真实客户端验证。
后续在测试环境安装本分支构建后，需人工复验：安装/更新期间 Escape 与外部点击不关闭、
关闭按钮不可用、完成后 Escape 与外部点击恢复正常、关闭详情后重开无进度残留。
