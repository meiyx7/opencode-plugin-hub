# 真实 OpenCode CLI 行为实测记录（0.5.1 依据）

环境：`opencode v2.0.27`（`/Users/meiyx/.opencode/bin/opencode`），
全部测试在隔离的 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME` 下进行，
未对用户生产配置做任何写操作（测试后已核对 `~/.config/opencode/opencode.json` 内容不变）。

## 1. `plugin add <pkg>@<version>`：支持指定版本

```
$ opencode plugin add opencode-plugin-hub@0.3.6
Plugin "opencode-plugin-hub@0.3.6" installed and added to <cfg>/opencode.json
exit=0
```

- 精确版本可用；不存在的版本会失败且**不写配置**：
  ```
  [cause]: opencode-plugin-hub: No matching version found for opencode-plugin-hub@9.9.9.
  exit=1
  ```

## 2. `plugin add` 只追加，从不替换

已有 `opencode-plugin-hub@0.3.6` 时：

| 命令 | 结果 |
|---|---|
| `plugin add opencode-plugin-hub@0.4.0` | 追加第二条，配置变成 `["…@0.3.6","…@0.4.0"]` |
| `plugin add opencode-plugin-hub` | 再追加第三条 `["…@0.3.6","…@0.4.0","opencode-plugin-hub"]` |
| `plugin add opencode-plugin-hub@0.4.0`（重复同一 spec） | 打印 `is already configured`，`exit=0`，配置不变 |

结论：**官方 CLI 没有“原地换版本”能力**。直接把 `plugin add pkg@new` 当作换版本，
必然留下重复声明。

## 3. `plugin add` 不校验插件入口

```
$ opencode plugin add left-pad@1.3.0
Plugin "left-pad@1.3.0" installed and added to <cfg>/opencode.jsonc
exit=0
```

`left-pad` 不是插件包，`add` 仍然成功写配置。入口是否可用只有**加载时**才知道，
所以“命令成功”不能当作“插件可用”。

## 4. 临时配置目录只写配置，不污染真实配置

```
$ XDG_CONFIG_HOME=<scratch> XDG_CACHE_HOME=<shared> opencode plugin add opencode-plugin-hub@0.4.0
$ cat <real>/opencode.json      # => 仍然只有 0.3.6，未被改动
$ ls <shared>/opencode/npm/     # => opencode-plugin-hub@0.4.0/<timestamp>/node_modules/...
```

包落到**共享缓存**、配置只写临时目录。这是“先准备、后切换”成立的前提。

## 5. 缓存布局

```
<XDG_CACHE_HOME>/opencode/npm/<name>@<range>/<timestamp>/node_modules/<name>/package.json
```

目录名用的是配置文件里写的 spec（`pkg@0.4.0` / `pkg@latest`），
所以配置切到哪个 spec，就必须先准备好那个 spec 的包。

## 6. 其他命令（与 0.5.0 的模型一致）

| 命令 | 输出 | 退出码 |
|---|---|---|
| `plugin remove <spec>` | `Plugin "x" removed from <cfg>` | 0 |
| `plugin remove <未配置>` | `Plugin "x" is not configured` | 0 |
| `plugin check` | `Server\n  <id> <ver> (current)` | 0 |
| `plugin update`（无更新） | `No plugin updates available` | 0 |
| `plugin update <未配置>` | `Error: Plugin is not configured: x` | 1 |
| `reload` | `Configuration reloaded` | 0 |

## 7. jsonc 注释保留（但格式会被重排）

CLI 用 jsonc 感知的编辑器，注释保留：

```jsonc
// 之前
{ "plugins": [ "opencode-notify" // 通知插件
] }
// 之后（注释还在，缩进被重排）
{ "plugins": [ "opencode-notify",
    "opencode-plugin-hub@0.4.0" ] }
```

结论：CLI 会重排整个文件。插件中心自己写配置时用 jsonc 单节点编辑，能保留更多原始格式，
因此「安装」交给 CLI，「配置切换」由插件中心原子写入。

## 8. `list` / `check` / `update` 作用于**运行中的宿主**，不可隔离

在隔离 `XDG_CONFIG_HOME` 下执行 `plugin list`，返回的却是用户真实环境里正在加载的插件
（`@magpie-community/...`、`opencode-notify-callback` …）。说明这三条命令通过 IPC 询问
运行中的 server，而不是读当前目录下的配置。

因此：

- 隔离验收只能安全地覆盖 `plugin add` / `plugin remove`（纯配置 + 包操作）；
- `list` / `check` / `update` 的真实行为只能在宿主运行中观察，本轮按“只读观察”记录，
  写操作（`update`）不做隔离验证，明确标记为未验证。
