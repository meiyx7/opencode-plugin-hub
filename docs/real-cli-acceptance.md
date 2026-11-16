# 真实 OpenCode CLI 隔离验收记录（0.5.1）

- CLI：`opencode v2.0.27`（`/Users/meiyx/.opencode/bin/opencode`）
- 环境：`XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME` 全部指向临时目录，
  验收脚本用 esbuild 打包 `src/gui/admin.ts` 后直接调用真实代码路径，不是模拟 CLI。
- 生产配置：`~/.config/opencode/opencode.json` 在验收前后**逐项核对未变化**（见文末）。

## 结果总览

| # | 场景 | 命令 | 结果 | 配置结局 |
|---|---|---|---|---|
| 1 | 版本替换 `0.3.0 → 0.3.2` | `plugin add opencode-usage-center@0.3.2`（隔离目录） | `command=succeeded, config=updated, runtime=unknown` | `["opencode-usage-center@0.3.2","keep-me"]`，只有一条，没有 `remove` |
| 2 | 版本替换到不存在的 `9.9.9` | 同上 | `command=failed, config=unchanged` | 原样 `["opencode-usage-center@0.3.0"]` |
| 3 | 全新安装 `opencode-notify@0.3.1` | `plugin add` | `succeeded/updated/unknown` | `["opencode-notify@0.3.1"]` |
| 4 | 移除已安装插件 | `plugin remove opencode-notify@0.3.1` | `succeeded/updated/skipped` | `["keep-me"]`，缓存里的包文件保留 |
| 5 | 移除未配置项 | `plugin remove opencode-notify`（配置里没有） | `command=skipped, config=unchanged`；提示「配置中没有这一项」 | 不变 |
| 6 | 自升级 `0.3.6 → 0.4.0` | `plugin add opencode-plugin-hub@0.4.0`（隔离目录） | `command=succeeded, config=updated, runtime=unknown` | `["opencode-plugin-hub@0.4.0"]` |
| 7 | 自升级到不存在的版本 | 同上 | `command=failed, config=unchanged` | 仍是 `["opencode-plugin-hub@0.3.6"]` |

### 场景 1 输出（换版本）

```json
{
  "ok": true,
  "stages": { "command": "succeeded", "config": "updated", "runtime": "unknown", "version": "0.3.2" },
  "message": "已把 opencode-usage-center 换到 opencode-usage-center@0.3.2：新版本先在隔离目录里装好并校验，然后一次性改写配置（旧条目 opencode-usage-center@0.3.0 从未被提前删除）。已执行 opencode reload。"
}
--- config ---
["opencode-usage-center@0.3.2", "keep-me"]
```

关键点：整个过程**没有 `plugin remove`**，旧条目在切换前一直在配置里；新版本是在
`XDG_CONFIG_HOME=<临时目录>` 下用官方 `plugin add` 装进共享缓存并校验后才切换的。

### 场景 2 输出（换版本失败）

```json
{
  "ok": false,
  "stages": { "command": "failed", "config": "unchanged", "runtime": "skipped" },
  "message": "准备 opencode-usage-center@9.9.9 失败（CLI：opencode-usage-center: No matching version found for opencode-usage-center@9.9.9.）。旧条目 opencode-usage-center@0.3.0 仍在配置里，可以照常使用。"
}
--- config ---
["opencode-usage-center@0.3.0"]
```

### 场景 6 输出（自升级，宿主未确认）

```json
{
  "ok": false,
  "stages": { "command": "succeeded", "config": "updated", "runtime": "unknown", "rollback": "none", "version": "0.4.0" },
  "message": "插件中心配置已切到 0.4.0，但宿主没有确认加载（宿主没有报告插件中心处于加载状态）。这不等于升级成功：已执行 opencode reload，宿主重新加载后才会生效；若一直不生效，把配置改回 opencode-plugin-hub@0.3.6 即可退回。"
}
```

`ok: false` 是刻意的：配置已经切到新版本，但宿主没有确认加载，就不能报“升级完成”。

### 包确实落盘（缓存证据）

```
--- cache roots ---
["opencode-notify@0.3.1", "opencode-plugin-hub@0.4.0", "opencode-plugin-hub@9.9.9",
 "opencode-usage-center@0.3.2", "opencode-usage-center@9.9.9"]
```

注意 `9.9.9` 也留下了空目录：真实 CLI 在版本解析失败时仍会创建目录骨架。
`locatePackage()` 要求 `<name>@<version>/<timestamp>/node_modules/<name>/package.json` 可读，
所以空目录不会被误判成“包已就绪”。

## 未验证项（真实环境做不到，不用模拟结果冒充）

| 项 | 原因 |
|---|---|
| 「自升级后宿主确认加载新版本」的真实成功路径 | npm 上 `opencode-plugin-hub` 最新版是 0.4.0，本机运行的正好是 0.4.0，没有“更高的已发布版本”可升；升到未发布的 0.5.0 会 `No matching version found`。该分支由 `tests/lifecycle-safety.test.ts` 的 20/25/26 用例用假 CLI 覆盖。 |
| `plugin update` 对插件中心自身的行为 | 判定为不可靠路径，本轮直接不复用（自升级只走 prepare + 原子切换），因此不需要验证。 |
| `plugin update` / `check` / `list` 的隔离性 | 这三条命令问的是**运行中的宿主**，不读当前 `XDG_CONFIG_HOME`（在隔离目录执行 `plugin list` 仍返回真实环境的插件）。所以它们无法在隔离环境里做写操作验收，本轮只做了只读观察。 |
| 宿主在配置切换后是否自动 reload | 需要长期运行的宿主 + 可观测日志；本轮只确认 `opencode reload` 退出码为 0，不推断宿主一定重新加载。 |
| `pause` / `resume` 的真实 CLI 效果 | 依赖宿主报告的运行时 ID（同样不可隔离），本轮用 `plugin list`/`runtime` 的只读观察 + 单元测试覆盖规则语义。 |

## 生产配置未被改动（核对）

```
$ cat ~/.config/opencode/opencode.json   # plugins 段仍为：
["opencode-mobile-notifications","./local-plugins/trae-auth-multi","opencode-plugin-hub@0.4.0",
 "opencode-usage-center@0.3.2","opencode-schedule-center@0.1.15","opencode-timeline-gui@0.2.7",
 "@magpie-community/opencode-workbuddy-auth@0.2.35","@magpie-community/opencode-zcode-auth@0.1.66",
 "@magpie-community/opencode-qoder-auth@0.2.68","@magpie-community/opencode-zen-free-auth@0.1.27"]
```

没有 `0.3.6` / `9.9.9` 之类的测试残留，条目数量与顺序均未变。

---

## 第三轮复验（权限、跨进程并发、JSONC）

同一台机器、同一个 `opencode v2.0.27`，仍然全部在临时 `XDG_CONFIG_HOME` 下执行。
这一轮新增了权限与并发两项，并复验了原有的安装/换版本/移除/自升级。

| 场景 | 做法 | 结果 |
|---|---|---|
| A 权限保持（0600） | 配置 0600 → 插件中心写入 | `0600 → 0600` ✅ |
| A 权限保持（0640） | 配置 0640 → 插件中心写入 | `0640 → 0640` ✅ |
| B 官方 CLI 重写后的权限 | 配置 0640 → 真实 `opencode plugin add` | `0640 → 0600` ⚠️ 见下 |
| C 跨进程并发 | 落临时文件 → **真实 CLI 改同一配置** → 提交 | 拒绝，`ConcurrentEditError: 配置在操作期间被外部修改，未覆盖`；外部条目保留；`HUB-MARKER` 未泄漏；无临时文件残留 ✅ |
| D JSONC 注释 | jsonc 配置 → 追加一条规则 | `// 我自己的注释` 保留，权限仍 `0600` ✅ |
| E 换版本 0.3.0 → 0.3.2 | `install(spec, "0.3.2")` | `config=updated, runtime=loaded`，配置只剩一条，全程无 remove ✅ |
| F 换版本到 9.9.9 | `install(spec, "9.9.9")` | `command=failed, config=unchanged`，旧条目 `0.3.0` 完好 ✅ |
| G 移除 | `remove("opencode-notify@0.3.1")` | `config=updated`，只改配置 ✅ |
| H 自升级 0.3.6 → 0.4.0 | `install("opencode-plugin-hub", "0.4.0")` | `config=updated`；`runtime=loaded` —— **隔离环境下这个结论不可信**，见下 |
| I 自升级到 9.9.9 | 同上 | `config=unchanged`，旧条目保留 ✅ |

### B 的结论：官方 CLI 自己会把权限改成 0600

这是一个必须如实记录的行为：`opencode plugin add` 重写配置文件时，把原来的 `0640`
写成了 `0600`。也就是说：

- **插件中心自己的写入路径**（版本切换、暂停/恢复、规则编辑、移除本地目录条目）保持原权限；
- **走官方 CLI 写配置的操作**（`plugin add` / `plugin remove` / `plugin update`）结束后，
  文件权限由 CLI 决定，实测为 `0600`。

插件中心不替 CLI 改权限，也不会为了"保持权限"在 CLI 之后再 chmod 一遍——那会把一个
更严格的结果放宽回去。这一点在 README「文件权限」里写明了。

### H 的结论：这一条仍然没有真机验证

自升级报告的 `runtime: loaded` 来自 `plugin list`，而 `plugin list` 问的是**运行中的宿主**，
不读当前 `XDG_CONFIG_HOME`。本机宿主跑的是真实配置里那条 `opencode-plugin-hub@0.4.0`，
于是隔离目录里刚配好 0.4.0 的这次操作"恰好"匹配上了它的报告。

在用户的真实环境里宿主和配置目录是同一套，这个判定是成立的；但在隔离验收里它是假阳性。
所以**「自升级后宿主确认加载新版本」依旧列为未验证**，本轮不拿它当已验证据。

同一个事实也说明一个真实边界：如果同一台机器上有多个配置目录/多个宿主实例，
插件中心的运行时判定可能落到另一个实例上。这条已写进 README「已知边界」。
