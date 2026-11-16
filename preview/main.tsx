import { render } from "solid-js/web"
import type { Context } from "@opencode/plugin/gui"
import { PluginHubDialog, PluginHubPage } from "../src/gui/page"
import snapshot from "../src/gui/registry-snapshot.json"
// admin 模块引用 node:child_process / fs；浏览器里用简化 mock 替代
// （预览重点验收 UI 与交互，网络请求用真 fetch 走 npm/awesome-opencode）。

// 按本机真实配置构造 10 条，覆盖 npm 包、本地目录、可更新、加载失败等形态。
const fakeState = {
  configPath: "/Users/meiyx/.config/opencode/opencode.json",
  configKey: "plugins",
  plugins: [
    { spec: "opencode-mobile-notifications", name: "opencode-mobile-notifications", kind: "package", version: "0.1.2", removable: true },
    { spec: "./local-plugins/trae-auth-multi", name: "opencode-trae-auth-multi", kind: "path", version: "0.0.1", removable: true },
    { spec: "opencode-plugin-hub@0.3.2", name: "opencode-plugin-hub", kind: "package", version: "0.3.2", removable: false },
    { spec: "opencode-usage-center@0.3.1", name: "opencode-usage-center", kind: "package", version: "0.3.1", removable: true },
    { spec: "opencode-schedule-center@0.1.11", name: "opencode-schedule-center", kind: "package", version: "0.1.11", removable: true },
    { spec: "opencode-timeline-gui@0.2.7", name: "opencode-timeline-gui", kind: "package", version: "0.2.7", removable: true },
    { spec: "@magpie-community/opencode-workbuddy-auth@0.2.31", name: "@magpie-community/opencode-workbuddy-auth", kind: "package", version: "0.2.31", removable: true },
    { spec: "magpie-workbuddy-growth", name: "magpie-workbuddy-growth", kind: "package", version: "1.0.3", removable: true },
    { spec: "@magpie-community/opencode-zcode-auth@0.1.61", name: "@magpie-community/opencode-zcode-auth", kind: "package", version: "0.1.61", removable: true },
    { spec: "@magpie-community/opencode-qoder-auth@0.2.67", name: "@magpie-community/opencode-qoder-auth", kind: "package", version: "0.2.67", removable: true },
    { spec: "-acme.reviewer", name: "acme.reviewer", kind: "control", version: "", removable: true },
  ],
  error: "",
}

const summaries: Record<string, { description: string; license: string; publisher: string }> = {
  "opencode-mobile-notifications": { description: "Send OpenCode notifications to your phone with a callback URL.", license: "MIT", publisher: "meiyx7" },
  "opencode-plugin-hub": { description: "Plugin manager for OpenCode Desktop: browse community plugins, search npm and install without editing JSON.", license: "MIT", publisher: "meiyx7" },
  "opencode-usage-center": { description: "Token usage, cost and cache-hit dashboard for OpenCode sessions.", license: "MIT", publisher: "meiyx7" },
  "opencode-schedule-center": { description: "Schedule prompts and recurring agent jobs from inside OpenCode.", license: "MIT", publisher: "meiyx7" },
  "opencode-timeline-gui": { description: "Turn-by-turn navigation through long sessions, with bookmarks and context jumps.", license: "MIT", publisher: "meiyx7" },
  "@magpie-community/opencode-workbuddy-auth": { description: "WorkBuddy account authentication provider for the magpie plugin family.", license: "MIT", publisher: "magpie-community" },
  "magpie-workbuddy-growth": { description: "WorkBuddy 国内版成长计划与任务签到管家（发现页入口包）：成长计划任务树一键点亮 / 任务签到领取积分 / 猫猫旅行。", license: "MIT", publisher: "connoryang331" },
  "@magpie-community/opencode-zcode-auth": { description: "ZCode authentication provider for OpenCode.", license: "MIT", publisher: "magpie-community" },
  "@magpie-community/opencode-qoder-auth": { description: "Qoder authentication provider for OpenCode.", license: "MIT", publisher: "magpie-community" },
}

// 真实主进程会把本地 package.json 的概述放进 snapshot，预览照做，
// 这样「已安装」列表即使还没查到 registry 也有描述。
const fakeStateWithSummary = {
  ...fakeState,
  plugins: fakeState.plugins.map((entry) => {
    const summary = summaries[entry.name]
    return {
      ...entry,
      description: summary?.description ?? (entry.kind === "path" ? "本地 directory 插件，直接加载工作区里的实现。" : ""),
      license: summary?.license ?? "",
    }
  }),
}

/** ?selfupdate 预览开关：让插件中心自身显示可更新，核对自升级提示与按钮。 */
const selfUpdateDemo = new URLSearchParams(window.location.search).has("selfupdate")

/** 真实的官方检查结果：每条都带 official 与 reason，界面据此决定按钮与徽章。 */
const fakeUpdates = fakeState.plugins.map((entry) => {
  const summary = summaries[entry.name] ?? { description: "", license: "", publisher: "" }
  const selfOutdated = selfUpdateDemo && entry.name === "opencode-plugin-hub"
  const outdated = entry.name === "opencode-usage-center" || selfOutdated
  const failed = entry.name === "magpie-workbuddy-growth"
  const control = entry.kind === "control"
  const path = entry.kind === "path"
  const pinned = /\d+\.\d+\.\d+$/.test(entry.spec)
  return {
    spec: entry.spec,
    name: entry.name,
    id: entry.name === "opencode-mobile-notifications" ? "opencode-notify-callback" : entry.name.replace(/^opencode-/, ""),
    kind: entry.kind,
    current: entry.version,
    latest: outdated ? (selfOutdated ? "0.7.0" : "0.3.2") : "",
    // 自身可更新即使精确锁定也显示（registry 决定，不受 pinned 限制）。
    hasUpdate: outdated && (!pinned || selfOutdated),
    official: control ? "skipped" : path ? "skipped" : failed ? "failed" : outdated ? "outdated" : "current",
    reason: control
      ? "配置规则，不是插件包"
      : path
        ? "本地目录插件由外部维护，官方更新流程会跳过它（目录里的改动不会被覆盖）"
        : failed
          ? "官方检查这个插件时出错"
          : selfOutdated
            ? "插件中心以精确版本运行；升级会进入安全自升级流程，把这个精确版本切换到目标版本"
            : "",
    managed: !control && !path,
    pinned,
    selfUpdate: entry.name === "opencode-plugin-hub" ? true : undefined,
    description: path ? "本地 directory 插件，直接加载工作区里的实现。" : summary.description,
    license: summary.license,
    homepage: "",
    repo: "",
    publisher: summary.publisher,
    error: failed ? "Plugin must export a default definition with an id and an effect or setup function." : "",
  }
})

function Button(props: { children?: unknown; onClick?: (event: MouseEvent) => void; busy?: boolean; disabled?: boolean; variant?: string; size?: string; icon?: string }) {
  return (
    <button class="mock-btn" data-variant={props.variant} onClick={props.onClick} disabled={props.busy || props.disabled}>
      {props.icon ? <MockGlyph name={props.icon} /> : null}
      {props.busy ? "…" : props.children}
    </button>
  )
}
/** 预览不引入图标包，用字形近似真实图标，方便核对按钮和信息层级。 */
const glyphs: Record<string, string> = {
  extensions: "🧩",
  "magnifying-glass": "⌕",
  "outline-rotate-clockwise": "↻",
  refresh: "↻",
  download: "↓",
  eye: "◉",
  github: "GH",
  globe: "◎",
  trash: "⌫",
  check: "✓",
  close: "×",
  "circle-ban-sign": "⊘",
  "circle-exclamation": "!",
  warning: "▲",
  info: "i",
  "bubble-5": "◌",
  cube: "▣",
  "square-arrow-top-right": "↗",
  "outline-dots": "⋯",
  "settings-gear": "⚙",
}
function MockGlyph(props: { name?: string }) {
  return (
    <span class="mock-icon" data-icon={props.name} title={props.name}>
      {glyphs[props.name ?? ""] ?? "•"}
    </span>
  )
}
function Icon(props: { name?: string; size?: string }) {
  return <MockGlyph name={props.name} />
}
function IconButton(props: { icon?: string; label?: string; onClick?: (event: MouseEvent) => void }) {
  return <button class="mock-btn" title={props.label} aria-label={props.label} onClick={props.onClick}><MockGlyph name={props.icon} /></button>
}
function Tooltip(props: { value?: unknown; children?: unknown }) {
  return <span title={String(props.value ?? "")}>{props.children}</span>
}
function Loader() {
  return <span class="mock-spinner" />
}
function Menu(props: { label?: string; items?: unknown[] }) {
  const groups = (props.items ?? []) as any[]
  return (
    <details class="mock-menu">
      <summary title={props.label}>⋯</summary>
      <div class="mock-menu-body">
        {groups.map((entry: any) => {
          if (entry.type === "separator") return <hr />
          if (entry.type === "group")
            return (
              <div>
                <div class="mock-menu-title">{entry.label}</div>
                {entry.items.map((item: any) => (
                  <button class="mock-menu-item" onClick={item.onSelect}>{item.label}</button>
                ))}
              </div>
            )
          return <button class="mock-menu-item" onClick={entry.onSelect}>{entry.label}</button>
        })}
      </div>
    </details>
  )
}
function TextInput(props: { label?: string; placeholder?: string; type?: string; value?: string; onInput?: (v: string) => void; onSubmit?: (v: string) => void }) {
  let current = props.value ?? ""
  return (
    <label class="mock-input">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(e) => { current = e.currentTarget.value; props.onInput?.(current) }}
        onKeyDown={(e) => { if (e.key === "Enter") props.onSubmit?.(current) }}
      />
    </label>
  )
}
/** 预览用的极简 Markdown 渲染：只覆盖 README 常见结构，真实宿主用 ui.Markdown。 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
function inlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img alt="$1" src="$2" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>")
}
function tableCells(line: string) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim())
}
function markdownToHtml(source: string) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let paragraph: string[] = []
  let list: "ul" | "ol" | undefined
  const flushParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!list) return
    out.push(`</${list}>`)
    list = undefined
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      flushParagraph()
      closeList()
      const language = trimmed.slice(3).trim()
      const code: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "")
        i += 1
      }
      i += 1
      out.push(
        `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`,
      )
      continue
    }
    if (!trimmed) {
      flushParagraph()
      closeList()
      i += 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      closeList()
      const level = heading[1]!.length
      out.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`)
      i += 1
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph()
      closeList()
      out.push("<hr />")
      i += 1
      continue
    }
    if (trimmed.startsWith(">")) {
      flushParagraph()
      closeList()
      const quote: string[] = []
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quote.push((lines[i] ?? "").trim().replace(/^>\s?/, ""))
        i += 1
      }
      out.push(`<blockquote>${quote.map((text) => `<p>${inlineMarkdown(text)}</p>`).join("")}</blockquote>`)
      continue
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph()
      if (list !== "ul") {
        closeList()
        out.push("<ul>")
        list = "ul"
      }
      out.push(`<li>${inlineMarkdown(trimmed.replace(/^[-*+]\s+/, ""))}</li>`)
      i += 1
      continue
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph()
      if (list !== "ol") {
        closeList()
        out.push("<ol>")
        list = "ol"
      }
      out.push(`<li>${inlineMarkdown(trimmed.replace(/^\d+[.)]\s+/, ""))}</li>`)
      i += 1
      continue
    }
    const next = lines[i + 1] ?? ""
    if (trimmed.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      flushParagraph()
      closeList()
      const head = tableCells(trimmed)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? "").trim().includes("|")) {
        rows.push(tableCells((lines[i] ?? "").trim()))
        i += 1
      }
      out.push(
        `<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      )
      continue
    }
    paragraph.push(trimmed)
    i += 1
  }
  flushParagraph()
  closeList()
  return out.join("\n")
}
function Markdown(props: { text?: string; class?: string }) {
  return <div class={props.class} innerHTML={markdownToHtml(props.text ?? "")} />
}
function Dialog(props: { title?: string; children?: unknown; footer?: unknown; size?: string }) {
  return (
    <div class="mock-dialog-frame">
      <div class="mock-dialog-head">{props.title}</div>
      <div class="mock-dialog-body">{props.children}</div>
      <div class="mock-dialog-foot">{props.footer}</div>
    </div>
  )
}

/** 预览里补一次主页/仓库与下载量：镜像的搜索索引不返回这两项。 */
async function previewExtra(name: string): Promise<{ weekly: number; monthly: number; homepage: string; repo: string } | undefined> {
  const base = "https://registry.npmmirror.com"
  try {
    const [latest, series] = await Promise.all([
      fetch(`${base}/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(6_000) }).then((r) =>
        r.ok ? r.json() : undefined,
      ),
      fetch(`${base}/downloads/range/last-month/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6_000) }).then(
        (r) => (r.ok ? r.json() : undefined),
      ),
    ])
    const days: { downloads?: number }[] = series?.downloads ?? []
    const sum = (list: { downloads?: number }[]) => list.reduce((total, day) => total + (Number(day.downloads) || 0), 0)
    const repository = latest?.repository
    return {
      weekly: days.length > 0 ? sum(days.slice(-7)) : -1,
      monthly: days.length > 0 ? sum(days) : -1,
      homepage: latest?.homepage ?? "",
      repo: typeof repository === "string" ? repository : repository?.url ?? "",
    }
  } catch {
    return undefined
  }
}

/** 预览的离线兜底：网络不可达时仍然能核对目录、搜索和详情布局。 */
const snapshotEntries = (snapshot as any[]).slice(0, 72).map((entry) => ({
  name: entry.name,
  pkg: entry.pkg,
  version: entry.ver,
  type: entry.type,
  desc: entry.desc,
  long: entry.long,
  repo: entry.repo,
  tags: entry.tags ?? [],
  installed: fakeState.plugins.some((p) => p.name === entry.pkg),
}))

const previewReadme = `# 示例插件

这个 README 由预览环境提供，用来核对详情弹窗的排版。真实数据来自 npm。

## 它能做什么

- 在会话里监听事件，并把通知发到手机
- 支持自定义回调地址和重试
- 不修改宿主的插件加载流程

## 安装

\`\`\`json
{
  "plugins": ["example-plugin"]
}
\`\`\`

| 配置项 | 说明 |
| --- | --- |
| \`url\` | 回调地址 |
| \`retries\` | 失败重试次数 |

> 预览环境不执行安装，按钮只用于检查交互和状态呈现。

## 更多

更多说明见项目主页。这里是较长的正文，用来检查 README 在宽屏双栏下是否保持足够阅读宽度，以及独立滚动是否正常。
`

const offlineHits = snapshotEntries
  .filter((entry) => entry.pkg)
  .map((entry, index) => ({
    name: entry.pkg,
    version: entry.version || "0.1.0",
    description: entry.desc || entry.long,
    published: new Date(Date.now() - (index + 1) * 86_400_000 * 7).toISOString(),
    updated: "",
    installed: entry.installed,
    current: fakeState.plugins.find((p) => p.name === entry.pkg)?.version ?? "",
    hasUpdate: false,
    weekly: 18000 - index * 320,
    monthly: 70000 - index * 1200,
    publisher: "community",
    license: "MIT",
    keywords: entry.tags,
    homepage: "",
    repo: entry.repo,
    npm: `https://www.npmjs.com/package/${entry.pkg}`,
  }))

function offlineSearch(text: string) {
  const needle = text.toLowerCase()
  const matched = offlineHits.filter((hit) =>
    [hit.name, hit.description, ...hit.keywords].join(" ").toLowerCase().includes(needle),
  )
  return (matched.length > 0 ? matched : offlineHits).slice(0, 32)
}

function offlineDetail(name: string) {
  const entry = snapshotEntries.find((item) => item.pkg === name) ?? snapshotEntries.find((item) => item.name === name)
  const installed = fakeState.plugins.find((p) => p.name === name)
  return {
    name,
    version: entry?.version || "0.1.0",
    description: entry?.desc || entry?.long || "预览环境生成的示例包。",
    homepage: "",
    repo: entry?.repo ?? "",
    repoDir: "",
    npm: `https://www.npmjs.com/package/${name}`,
    bugs: "",
    license: "MIT",
    keywords: entry?.tags?.slice(0, 6) ?? ["opencode", "plugin"],
    maintainers: ["community", "meiyx7"],
    weekly: 12480,
    monthly: 51200,
    published: new Date(Date.now() - 12 * 86_400_000).toISOString(),
    created: new Date(Date.now() - 420 * 86_400_000).toISOString(),
    versions: 18,
    unpacked: 284_000,
    files: 42,
    dependencies: ["zod@^3.22.0", "undici@^6.0.0", "yaml@^2.4.0"],
    deprecated: "",
    readme: previewReadme,
    readmeTruncated: false,
    installed: Boolean(installed),
    current: installed?.version ?? "",
    hasUpdate: false,
    error: "",
  }
}

const ctx = {
  client: {},
  main: () => ({
    snapshot: async () => fakeStateWithSummary,
    updates: async () => ({ items: fakeUpdates, error: "" }),
    search: async (input: { query: string }) => {
      // 与主进程同一套策略：官方源不可达时落到镜像，镜像不认 keywords: 限定词，结果本地过滤。
      const text = input.query.trim() ? `${input.query.trim()} opencode-plugin` : "opencode-plugin"
      const bases = ["https://registry.npmjs.org", "https://registry.npmmirror.com"]
      let response: Response | undefined
      for (const base of bases) {
        try {
          response = await fetch(`${base}/-/v1/search?size=100&text=${encodeURIComponent(text)}`, {
            signal: AbortSignal.timeout(6_000),
          })
          if (!response.ok) continue
          break
        } catch {
          // 下一个源
        }
      }
      if (!response) return { hits: offlineSearch(input.query.trim()), error: "当前网络无法连接 npm registry，预览使用本地示例结果。" }
      const body = await response.json()
      const wanted = new Set(["opencode", "opencode-plugin", "opencode-plugins", "opencode-ai"])
      const picked = (body.objects ?? []).filter((item: any) => {
        const pkg = item.package ?? {}
        const name = pkg.name ?? ""
        const keywords = (pkg.keywords ?? []).map((k: string) => String(k).toLowerCase())
        if (keywords.some((k: string) => /^(dsh|deepseek-harness|deepseek)$/i.test(k)) || /^dsh-/i.test(name)) return false
        return /opencode/i.test(name) || keywords.some((k: string) => wanted.has(k)) || /\bopencode\b/i.test(pkg.description ?? "")
      })
      // 镜像不返回 links 和下载量：详情接口补主页/仓库，下载接口补周/月。
      const extra = await Promise.all(picked.map((item: any) => previewExtra(item.package.name)))
      const hits = picked.slice(0, 50).map((item: any, index: number) => ({
        name: item.package.name,
        version: item.package.version ?? "",
        description: item.package.description ?? "",
        published: item.package.date ?? "",
        updated: item.package.date ?? "",
        installed: fakeState.plugins.some((p) => p.name === item.package.name),
        current: fakeState.plugins.find((p) => p.name === item.package.name)?.version ?? "",
        hasUpdate: false,
        weekly: item.downloads?.weekly ?? extra[index]?.weekly ?? -1,
        monthly: item.downloads?.monthly ?? extra[index]?.monthly ?? -1,
        publisher: item.package.maintainers?.[0]?.username ?? "",
        license: item.package.license ?? "",
        keywords: item.package.keywords ?? [],
        homepage: item.package.links?.homepage ?? extra[index]?.homepage ?? "",
        repo: item.package.links?.repository ?? extra[index]?.repo ?? "",
        npm: item.package.links?.npm ?? `https://www.npmjs.com/package/${item.package.name}`,
      }))
      return { hits, error: "" }
    },
    browse: async (input: { force: boolean }) => {
      // raw.githubusercontent.com 在部分网络会被重置，api.github.com 仍然可用。
      // 预览跑在浏览器里，自定义 accept 头会触发 CORS 预检，所以 contents API 走默认 JSON + base64 解码。
      const sources = [
        "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json",
        "https://api.github.com/repos/awesome-opencode/awesome-opencode/contents/dist/registry.json?ref=main",
      ]
      let raw: any[] | undefined
      let used = sources[0]!
      for (const url of sources) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
          if (!response.ok) continue
          const body = await response.json()
          if (Array.isArray(body)) {
            raw = body
            used = url
            break
          }
          if (typeof body?.content === "string") {
            const text = decodeURIComponent(escape(atob(body.content.replace(/\n/g, ""))))
            const parsed = JSON.parse(text)
            if (Array.isArray(parsed)) {
              raw = parsed
              used = url
              break
            }
          }
        } catch {
          // 下一个源
        }
      }
      if (!raw) {
        return {
          entries: snapshotEntries,
          source: "builtin",
          registry: sources[0]!,
          fetchedAt: 0,
          error: "当前网络无法连接插件目录，预览使用本地内置快照。",
        }
      }
      const entries = raw
        .filter((entry) => ["plugins", "mcp", "themes"].includes(entry.type ?? "plugins"))
        .slice(0, 60)
        .map((entry) => {
          const repo = (entry.repoUrl ?? "").replace(/\/+$/, "").replace(/\.git$/, "")
          const fromInstall = /"plugin"\s*:\s*\[\s*"([^"]+)"/.exec(entry.installation ?? "")
          const guess = fromInstall?.[1] ?? repo.split("/").pop() ?? ""
          const pkg = guess && !guess.includes(" ") ? guess : ""
          return {
            name: entry.displayName ?? pkg ?? repo,
            pkg,
            version: "",
            type: entry.type ?? "plugins",
            desc: (entry.tagline ?? "").trim(),
            long: (entry.description ?? "").trim().slice(0, 300),
            repo,
            tags: (entry.tags ?? []).slice(0, 6),
            installed: fakeState.plugins.some((p) => p.name === pkg),
          }
        })
      return { entries, source: "network", registry: used, fetchedAt: Date.now(), error: "" }
    },
    detail: async (input: { name: string }) => {
      const path = `/${encodeURIComponent(input.name)}`
      const bases = ["https://registry.npmjs.org", "https://registry.npmmirror.com"]
      let response: Response | undefined
      for (const base of bases) {
        try {
          response = await fetch(`${base}${path}`)
          break
        } catch {
          // 下一个源
        }
      }
      if (!response) return offlineDetail(input.name)
      if (!response.ok) return offlineDetail(input.name)
      const body = await response.json()
      const latest = body["dist-tags"]?.latest ?? ""
      const manifest = latest ? body.versions?.[latest] : undefined
      return {
        name: input.name,
        version: latest,
        description: manifest?.description ?? body.description ?? "",
        homepage: manifest?.homepage ?? "",
        repo: typeof manifest?.repository === "object" ? manifest.repository.url?.replace(/^git\+/, "").replace(/\.git$/, "") ?? "" : "",
        repoDir: "",
        npm: `https://www.npmjs.com/package/${input.name}`,
        bugs: typeof manifest?.bugs === "object" ? manifest.bugs.url ?? "" : "",
        license: manifest?.license ?? "",
        keywords: manifest?.keywords ?? [],
        maintainers: (body.maintainers ?? []).map((m: any) => m.name),
        weekly: -1,
        monthly: -1,
        published: body.time?.[latest] ?? "",
        created: body.time?.created ?? "",
        versions: Object.keys(body.versions ?? {}).length,
        unpacked: manifest?.dist?.unpackedSize ?? 0,
        files: manifest?.dist?.fileCount ?? 0,
        dependencies: Object.entries(manifest?.dependencies ?? {}).map(([k, v]) => `${k}@${v}`),
        deprecated: typeof manifest?.deprecated === "string" ? manifest.deprecated : "",
        readme: typeof body.readme === "string" ? body.readme.slice(0, 30000) : "",
        readmeTruncated: false,
        installed: fakeState.plugins.some((p) => p.name === input.name),
        current: fakeState.plugins.find((p) => p.name === input.name)?.version ?? "",
        hasUpdate: false,
        error: "",
      }
    },
    openUrl: async (input: { url: string }) => { window.open(input.url, "_blank"); return { ok: true } },
    openConfig: async () => ({ ok: true }),
    // 预览不执行真实操作，但把「分阶段结果」的形态演示出来：配置没动 = 错误语气。
    install: async () => ({
      ok: false,
      message: "预览模式不执行安装",
      state: fakeState,
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }),
    update: async () => ({
      ok: false,
      message: "预览模式不执行更新",
      state: fakeState,
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }),
    remove: async () => ({
      ok: false,
      message: "预览模式不执行移除",
      state: fakeState,
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }),
    pause: async () => ({
      ok: false,
      message: "预览模式不写配置规则",
      state: fakeState,
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }),
    resume: async () => ({
      ok: false,
      message: "预览模式不写配置规则",
      state: fakeState,
      stages: { command: "skipped", config: "unchanged", runtime: "skipped" },
    }),
    reload: async () => ({ ok: true, message: "预览模式", state: fakeState }),
    // 预览里展示运行状态徽章：一条已加载、一条未知，用于核对 UI 呈现。
    runtime: async () => ({
      items: fakeState.plugins.map((entry) => {
        const control = entry.kind === "control"
        // ?clean 预览分支：让运行状态全部正常，用来核对「无事不显示摘要」。
        const failed = !params.has("clean") && entry.name === "magpie-workbuddy-growth"
        const paused = !params.has("clean") && entry.name === "opencode-timeline-gui"
        return {
          spec: entry.spec,
          name: entry.name,
          id: control ? "" : entry.name.replace(/^@[^/]+\//, "").replace(/^opencode-/, ""),
          status: control ? "control" : failed ? "failed" : paused ? "unknown" : "loaded",
          runtimeVersion: entry.version,
          error: failed ? "Plugin must export a default definition with an id and an effect or setup function." : "",
          available: true,
          paused,
          rule: paused ? "-opencode-timeline-gui" : "",
          pausedBy: paused ? "exact" : "",
          rules: paused ? ["-opencode-timeline-gui"] : [],
        }
      }),
      discovered: [{ id: "workspace-scratch", version: "local", source: "/Users/meiyx/project/.opencode/plugins/scratch", section: "Server" }],
      error: "",
    }),
  }),
  ui: { Button, Icon, IconButton, Tooltip, Loader, Menu, TextInput, Markdown, Dialog },
  dialogs: {
    active: () => false,
    open: (renderDialog: (dialog: { close: () => void }) => unknown) => {
      const holder = document.getElementById("detail-holder")!
      holder.innerHTML = ""
      // Solid 的 render 来自 solid-js/web；在 holder 内挂一个 root
      void import("solid-js/web").then(({ render: solidRender }) => {
        solidRender(() => renderDialog({ close: () => { holder.innerHTML = "" } }) as never, holder)
      })
    },
    confirm: async () => true,
  },
  layout: { settings: () => undefined },
} as unknown as Context

const params = new URLSearchParams(window.location.search)
const embedded = params.has("embedded")
if (params.has("dark")) document.documentElement.dataset.theme = "dark"
const narrow = Number(params.get("narrow") ?? "")
if (Number.isFinite(narrow) && narrow > 0) document.getElementById("root")!.style.width = `${narrow}px`
render(
  () => (
    <>
      <PluginHubPage ctx={ctx} admin={(ctx as any).main()} embedded={embedded} />
      <div id="detail-holder" />
    </>
  ),
  document.getElementById("root")!,
)
// 截图/回归时可直接落到指定页签：?tab=installed
const initialTab = params.get("tab")
if (initialTab === "installed") {
  setTimeout(() => document.querySelectorAll<HTMLButtonElement>(".ph-tab")[2]?.click(), 0)
} else if (initialTab === "search") {
  setTimeout(() => document.querySelectorAll<HTMLButtonElement>(".ph-tab")[1]?.click(), 0)
}
