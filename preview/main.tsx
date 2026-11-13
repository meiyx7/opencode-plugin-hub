import { render } from "solid-js/web"
import type { Context } from "@opencode/plugin/gui"
import { PluginHubDialog, PluginHubPage } from "../src/gui/page"
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

const fakeUpdates = fakeState.plugins.map((entry) => {
  const summary = summaries[entry.name] ?? { description: "", license: "", publisher: "" }
  const latest = entry.name === "opencode-usage-center" ? "0.3.2" : entry.name === "opencode-timeline-gui" ? "0.2.8" : entry.version
  return {
    spec: entry.spec,
    name: entry.name,
    kind: entry.kind,
    current: entry.version,
    latest,
    hasUpdate: latest !== entry.version,
    managed: entry.kind !== "path",
    description: entry.kind === "path" ? "本地 directory 插件，直接加载工作区里的实现。" : summary.description,
    license: summary.license,
    homepage: "",
    repo: "",
    publisher: summary.publisher,
    error: entry.name === "opencode-trae-auth-multi" ? "不是 npm 包名，无法查询版本" : "",
  }
})

function Button(props: { children?: unknown; onClick?: (event: MouseEvent) => void; busy?: boolean; disabled?: boolean; variant?: string; size?: string; icon?: string }) {
  return (
    <button class="mock-btn" data-variant={props.variant} onClick={props.onClick} disabled={props.busy || props.disabled}>
      {props.icon ? <span class="mock-icon" title={props.icon} /> : null}
      {props.busy ? "…" : props.children}
    </button>
  )
}
function Icon(props: { name?: string; size?: string }) {
  return <span class="mock-icon" title={props.name} />
}
function IconButton(props: { icon?: string; label?: string; onClick?: (event: MouseEvent) => void }) {
  return <button class="mock-btn" title={props.label} aria-label={props.label} onClick={props.onClick}><span class="mock-icon" title={props.icon} /></button>
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
function Markdown(props: { text?: string; class?: string }) {
  return <div class={props.class} innerHTML={props.text ?? ""} />
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
      if (!response) return { hits: [], error: "无法连接 npm registry" }
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
      if (!raw) return { entries: [], source: "builtin", registry: sources[0]!, fetchedAt: 0, error: "无法连接插件目录" }
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
      if (!response) return { name: input.name, version: "", description: "", homepage: "", repo: "", repoDir: "", npm: `https://www.npmjs.com/package/${input.name}`, bugs: "", license: "", keywords: [], maintainers: [], weekly: -1, monthly: -1, published: "", created: "", versions: 0, unpacked: 0, files: 0, dependencies: [], deprecated: "", readme: "", readmeTruncated: false, installed: false, current: "", hasUpdate: false, error: "无法连接 npm registry" }
      if (!response.ok) return { name: input.name, version: "", description: "", homepage: "", repo: "", repoDir: "", npm: `https://www.npmjs.com/package/${input.name}`, bugs: "", license: "", keywords: [], maintainers: [], weekly: -1, monthly: -1, published: "", created: "", versions: 0, unpacked: 0, files: 0, dependencies: [], deprecated: "", readme: "", readmeTruncated: false, installed: false, current: "", hasUpdate: false, error: `npm registry 返回 ${response.status}` }
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
    install: async () => ({ ok: false, message: "预览模式不执行安装", state: fakeState }),
    remove: async () => ({ ok: false, message: "预览模式不执行移除", state: fakeState }),
    reload: async () => ({ ok: true, message: "预览模式", state: fakeState }),
    restart: async () => ({ ok: false }),
    // 预览里展示运行状态徽章：一条已加载、一条未知，用于核对 UI 呈现。
    runtime: async () => ({
      items: fakeState.plugins.map((entry) => ({
        spec: entry.spec,
        name: entry.name,
        status: entry.name === "magpie-workbuddy-growth" ? "failed" : "loaded",
        runtimeVersion: entry.version,
        error:
          entry.name === "magpie-workbuddy-growth"
            ? "Plugin must export a default definition with an id and an effect or setup function."
            : "",
        available: true,
      })),
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
if (params.get("tab") === "installed") {
  setTimeout(() => document.querySelectorAll<HTMLButtonElement>(".ph-tab")[2]?.click(), 0)
}
