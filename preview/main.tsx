import { render } from "solid-js/web"
import type { Context } from "@opencode/plugin/gui"
import { PluginHubDialog, PluginHubPage } from "../src/gui/page"
// admin 模块引用 node:child_process / fs；浏览器里用简化 mock 替代
// （预览重点验收 UI 与交互，网络请求用真 fetch 走 npm/awesome-opencode）。

const fakeState = {
  configPath: "/Users/meiyx/.config/opencode/opencode.json",
  configKey: "plugins",
  plugins: [
    { spec: "opencode-plugin-hub", name: "opencode-plugin-hub", kind: "package", version: "0.1.4", removable: false },
    { spec: "opencode-usage-center", name: "opencode-usage-center", kind: "package", version: "0.2.0", removable: true },
    { spec: "opencode-qoder-bridge", name: "opencode-qoder-bridge", kind: "package", version: "0.3.2", removable: true },
  ],
  error: "",
}

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

const ctx = {
  client: {},
  main: () => ({
    snapshot: async () => fakeState,
    updates: async () => ({
      items: [
        { spec: "opencode-plugin-hub", name: "opencode-plugin-hub", kind: "package", current: "0.1.4", latest: "0.1.4", hasUpdate: false, managed: true, error: "" },
        { spec: "opencode-usage-center", name: "opencode-usage-center", kind: "package", current: "0.2.0", latest: "0.2.1", hasUpdate: true, managed: true, error: "" },
        { spec: "opencode-qoder-bridge", name: "opencode-qoder-bridge", kind: "package", current: "0.3.2", latest: "0.3.3", hasUpdate: true, managed: true, error: "" },
        { spec: "/local/dev-plugin", name: "dev-plugin", kind: "path", current: "1.0.0", latest: "", hasUpdate: false, managed: false, error: "无法连接 npm registry，本次未检查" },
      ],
      error: "",
    }),
    search: async (input: { query: string }) => {
      const text = input.query.trim() ? `${input.query.trim()} keywords:opencode-plugin` : "keywords:opencode-plugin"
      const response = await fetch(`https://registry.npmjs.org/-/v1/search?size=25&text=${encodeURIComponent(text)}`)
      const body = await response.json()
      const hits = (body.objects ?? []).map((item: any) => ({
        name: item.package.name,
        version: item.package.version ?? "",
        description: item.package.description ?? "",
        published: item.package.date ?? "",
        updated: item.package.date ?? "",
        installed: fakeState.plugins.some((p) => p.name === item.package.name),
        current: fakeState.plugins.find((p) => p.name === item.package.name)?.version ?? "",
        hasUpdate: false,
        weekly: item.downloads?.weekly ?? 0,
        monthly: item.downloads?.monthly ?? 0,
        publisher: item.package.maintainers?.[0]?.username ?? "",
        license: item.package.license ?? "",
        keywords: item.package.keywords ?? [],
        homepage: item.package.links?.homepage ?? "",
        repo: item.package.links?.repository ?? "",
        npm: item.package.links?.npm ?? `https://www.npmjs.com/package/${item.package.name}`,
      }))
      return { hits, error: "" }
    },
    browse: async (input: { force: boolean }) => {
      const response = await fetch("https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json")
      const raw = await response.json()
      const entries = (raw as any[])
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
      return { entries, source: "network", registry: "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json", fetchedAt: Date.now(), error: "" }
    },
    detail: async (input: { name: string }) => {
      const response = await fetch(`https://registry.npmjs.org/${input.name.replace("/", "%2f")}`)
      if (!response.ok) return { name: input.name, version: "", description: "", homepage: "", repo: "", repoDir: "", npm: `https://www.npmjs.com/package/${input.name}`, bugs: "", license: "", keywords: [], maintainers: [], weekly: 0, monthly: 0, published: "", created: "", versions: 0, unpacked: 0, files: 0, dependencies: [], deprecated: "", readme: "", readmeTruncated: false, installed: false, current: "", hasUpdate: false, error: `npm registry 返回 ${response.status}` }
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
        weekly: 0,
        monthly: 0,
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
      items: fakeState.plugins.map((entry, index) => ({
        spec: entry.spec,
        name: entry.name,
        status: index === 0 ? "loaded" : "unknown",
        runtimeVersion: index === 0 ? entry.version : "",
        error: "",
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

const embedded = new URLSearchParams(window.location.search).has("embedded")
render(
  () => (
    <>
      <PluginHubPage ctx={ctx} admin={(ctx as any).main()} embedded={embedded} />
      <div id="detail-holder" />
    </>
  ),
  document.getElementById("root")!,
)
