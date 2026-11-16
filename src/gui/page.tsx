import { createEffect, createMemo, createSignal, For, onMount, Show, Switch, Match } from "solid-js"
import type { Context, IconName, IpcClient } from "@opencode/plugin/gui"
import type { Admin } from "../contract"
import { countTitle, countWithUnit, formatCount } from "./download-format"
import { explainMutation, type Tone } from "./feedback"
import { CSS } from "./styles"

type AdminClient = IpcClient<typeof Admin.spec>
type HubState = Awaited<ReturnType<AdminClient["snapshot"]>>
type PluginEntry = HubState["plugins"][number]
type SearchHit = Awaited<ReturnType<AdminClient["search"]>>["hits"][number]
type CatalogEntry = Awaited<ReturnType<AdminClient["browse"]>>["entries"][number]
type CatalogResult = Awaited<ReturnType<AdminClient["browse"]>>
type UpdateInfo = Awaited<ReturnType<AdminClient["updates"]>>["items"][number]
type PackageDetail = Awaited<ReturnType<AdminClient["detail"]>>
type MutationResult = Awaited<ReturnType<AdminClient["install"]>>
type RuntimeInfo = Awaited<ReturnType<AdminClient["runtime"]>>["items"][number]
type DiscoveredPlugin = NonNullable<Awaited<ReturnType<AdminClient["runtime"]>>["discovered"]>[number]

type Tab = "catalog" | "search" | "installed"
/** 已安装页的状态筛选；管理页先看问题项，而不是按配置顺序翻。 */
type InstalledFilter = "all" | "update" | "paused" | "failed" | "pending" | "unknown"
type Note = { text: string; tone: Tone; scope?: Tab }

const PAGE = 24

/** 一行的运行状态：服务端事实 + 配置规则一起决定，界面按它出徽章和按钮。 */
type RowState = "loaded" | "failed" | "paused" | "pending" | "unknown" | "control" | "rule"

const CATALOG_SOURCE_FALLBACK = "https://github.com/awesome-opencode/awesome-opencode"
const CATALOG_SOURCE_TITLE = "精选目录来自 awesome-opencode 社区维护的 registry.json，不是 OpenCode 官方推荐"

const TYPE_LABEL: Record<string, string> = {
  plugins: "插件",
  mcp: "MCP",
  themes: "主题",
}

const TYPE_FILTERS = [
  { value: "all", label: "全部" },
  { value: "plugins", label: "插件" },
  { value: "mcp", label: "MCP" },
  { value: "themes", label: "主题" },
] as const
type TypeFilter = (typeof TYPE_FILTERS)[number]["value"]

const SORTS = [
  { value: "relevance", label: "相关度" },
  { value: "downloads", label: "周下载" },
  { value: "recent", label: "最近发布" },
] as const
type Sort = (typeof SORTS)[number]["value"]

const SUGGESTIONS = ["qoder", "notify", "memory", "auth", "usage", "theme", "mcp"]

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—"
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function relativeDate(value: string): string {
  if (!value) return ""
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value.slice(0, 10)
  const days = Math.floor((Date.now() - time) / 86_400_000)
  if (days <= 0) return "今天"
  if (days === 1) return "昨天"
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

function initial(name: string): string {
  const base = name.replace(/^@/, "").split("/").pop() ?? name
  const cleaned = base.replace(/^opencode[-_]?/i, "")
  return (cleaned || base).slice(0, 1).toUpperCase()
}

function typeIcon(type: string): IconName {
  if (type === "mcp") return "mcp"
  if (type === "themes") return "appearance"
  return "extensions"
}

function repoLink(url: string, directory: string): string {
  if (!url || !directory) return url
  if (!/^https:\/\/github\.com\//i.test(url)) return url
  return `${url}/tree/HEAD/${directory.replace(/^\/+/, "")}`
}

function noteIcon(tone: Tone): IconName {
  if (tone === "error") return "circle-exclamation"
  if (tone === "success") return "circle-check"
  if (tone === "warning") return "warning"
  return "info"
}

/**
 * A schema error almost always means the window bundle and the `serve --service` process
 * are running different builds of this plugin. Say that in words instead of showing
 * `SchemaError(Missing key at ...)`, which gives the user nothing to act on.
 */
function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/SchemaError|Missing key at/i.test(text)) {
    return "插件窗口与后台服务版本不一致，需要 OpenCode 重新加载（插件中心不重启宿主）。"
  }
  if (/unknown method|not implemented|no such method|method.*not.*found/i.test(text)) {
    return "后台服务还在跑旧版本，没有这个接口。请让 OpenCode 重新加载插件后重试。"
  }
  return text
}

const NPM_LIKE = /^(@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i

interface DetailFallback {
  version?: string
  description?: string
  homepage?: string
  repo?: string
  npm?: string
}


interface DetailDialogProps {
  ctx: Context
  admin: AdminClient
  name: string
  fallback?: DetailFallback
  busy: boolean
  onInstall: (version: string) => void
  onClose: () => void
}

function DetailDialog(props: DetailDialogProps) {
  const ui = props.ctx.ui
  const [data, setData] = createSignal<PackageDetail>()
  const [failure, setFailure] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  const load = async () => {
    try {
      const result = await props.admin.detail({ name: props.name })
      setData(result)
      if (result.error) setFailure(result.error)
    } catch (error) {
      setFailure(readableError(error))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void load()
  })

  const open = (url: string) => {
    if (!url) return
    void props.admin.openUrl({ url })
  }

  const version = () => data()?.version || props.fallback?.version || ""
  const current = () => data()?.current || ""
  const description = () => data()?.description || props.fallback?.description || ""
  const homepage = () => data()?.homepage || props.fallback?.homepage || ""
  const repo = () => data()?.repo || props.fallback?.repo || ""
  const npm = () => data()?.npm || props.fallback?.npm || `https://www.npmjs.com/package/${props.name}`
  const bugs = () => data()?.bugs || ""
  const canInstall = () => !loading() && data() !== undefined && !failure() && (data()?.version ?? "") !== ""
  const update = () => data()?.hasUpdate === true
  const installed = () => data()?.installed === true

  return (
    <ui.Dialog
      title="插件详情"
      size="x-large"
      footer={
        <div class="ph-dialog-footer">
          <div class="ph-dialog-links">
            <Show when={homepage()}>
              <ui.Button size="small" variant="ghost" icon="globe" onClick={() => open(homepage())}>
                主页
              </ui.Button>
            </Show>
            <Show when={repo()}>
              <ui.Button
                size="small"
                variant="ghost"
                icon="github"
                onClick={() => open(repoLink(repo(), data()?.repoDir ?? ""))}
              >
                源码
              </ui.Button>
            </Show>
            <Show when={npm()}>
              <ui.Button size="small" variant="ghost" icon="cube" onClick={() => open(npm())}>
                npm
              </ui.Button>
            </Show>
            <Show when={bugs()}>
              <ui.Button size="small" variant="ghost" icon="bubble-5" onClick={() => open(bugs())}>
                问题反馈
              </ui.Button>
            </Show>
          </div>
          <span class="ph-spacer" />
          <ui.Button size="small" onClick={props.onClose}>
            关闭
          </ui.Button>
        </div>
      }
    >
      <div class="ph-detail">
        <Show when={loading()}>
          <div class="ph-detail-loading">
            <ui.Loader size="large" />
            <span>正在读取 npm 上的 README 与统计…</span>
          </div>
        </Show>

        <Show when={!loading() && data()}>
          <div class="ph-detail-head">
            <div class="ph-detail-identity">
              <div class="ph-tile ph-detail-avatar">{initial(data()!.name || props.name)}</div>
              <div class="ph-detail-titles">
                <div class="ph-detail-name">{data()!.name || props.name}</div>
                <div class="ph-detail-pkg">npm 包 · {props.name}</div>
                <div class="ph-detail-badges">
                  <Show when={version()}>
                    <span class="ph-badge" data-tone="accent">
                      最新 v{version()}
                    </span>
                  </Show>
                  <Show when={installed()}>
                    <span class="ph-badge" data-tone="success">
                      已安装{current() ? ` v${current()}` : ""}
                    </span>
                  </Show>
                  <Show when={update()}>
                    <span class="ph-badge" data-tone="warning">
                      可更新
                    </span>
                  </Show>
                  <Show when={data()!.deprecated}>
                    <span class="ph-badge" data-tone="danger">
                      已废弃
                    </span>
                  </Show>
                </div>
                <div class="ph-detail-desc">{description() || "这个包没有提供描述。"}</div>
              </div>
            </div>
            <div class="ph-detail-primary">
              <Show when={canInstall() && (update() || !installed())}>
                <ui.Button
                  variant="contrast"
                  size="small"
                  icon="download"
                  busy={props.busy}
                  onClick={() => props.onInstall(data()!.version)}
                >
                  {update() ? `更新到 v${version()}` : `安装 v${version()}`}
                </ui.Button>
              </Show>
            </div>
          </div>

          <Show when={data()!.deprecated}>
            <div class="ph-warning">
              <ui.Icon name="warning" size="small" />
              <span>{data()!.deprecated}</span>
            </div>
          </Show>

          <Show when={failure()}>
            <div class="ph-warning" data-tone="danger">
              <ui.Icon name="circle-exclamation" size="small" />
              <span>{failure()}</span>
            </div>
          </Show>

          <div class="ph-detail-layout">
            <div class="ph-detail-main">
              <section class="ph-section">
                <div class="ph-section-head">
                  <span class="ph-section-title">README</span>
                  <span class="ph-readme-note">来自 npm</span>
                </div>
                <Show
                  when={data()!.readme}
                  fallback={
                    <div class="ph-readme-empty">
                      这个包没有附带 README。可以打开 npm 页面或项目主页进一步了解。
                    </div>
                  }
                >
                  <ui.Markdown text={data()!.readme} class="ph-readme" />
                  <Show when={data()!.readmeTruncated}>
                    <div class="ph-readme-note">README 较长，这里只显示前一部分。完整内容见 npm 页面。</div>
                  </Show>
                </Show>
              </section>
            </div>

            <aside class="ph-detail-side">
              <Show when={data()!.version}>
                <div class="ph-detail-stats">
                  <div class="ph-detail-stat">
                    <b title={countTitle(data()!.weekly, "周下载")}>{formatCount(data()!.weekly)}</b>
                    <span>周下载</span>
                  </div>
                  <div class="ph-detail-stat">
                    <b title={countTitle(data()!.monthly, "月下载")}>{formatCount(data()!.monthly)}</b>
                    <span>月下载</span>
                  </div>
                  <div class="ph-detail-stat">
                    <b>{data()!.versions || "—"}</b>
                    <span>已发布版本</span>
                  </div>
                  <div class="ph-detail-stat">
                    <b>{data()!.unpacked ? formatBytes(data()!.unpacked) : "—"}</b>
                    <span>{data()!.files ? `解包体积 · ${data()!.files} 文件` : "解包体积"}</span>
                  </div>
                </div>
              </Show>

              <div class="ph-side-block">
                <div class="ph-side-title">发布信息</div>
                <div class="ph-meta-list">
                  <div class="ph-meta-row">
                    <span class="ph-meta-key">最新版本</span>
                    <span class="ph-meta-value">{version() ? `v${version()}` : "—"}</span>
                  </div>
                  <div class="ph-meta-row">
                    <span class="ph-meta-key">当前安装</span>
                    <span class="ph-meta-value">{installed() ? (current() ? `v${current()}` : "已安装") : "未安装"}</span>
                  </div>
                  <Show when={data()!.published}>
                    <div class="ph-meta-row">
                      <span class="ph-meta-key">最新发布</span>
                      <span class="ph-meta-value">{relativeDate(data()!.published)}</span>
                    </div>
                  </Show>
                  <Show when={data()!.created}>
                    <div class="ph-meta-row">
                      <span class="ph-meta-key">首次发布</span>
                      <span class="ph-meta-value">{relativeDate(data()!.created)}</span>
                    </div>
                  </Show>
                  <Show when={data()!.license}>
                    <div class="ph-meta-row">
                      <span class="ph-meta-key">许可证</span>
                      <span class="ph-meta-value">{data()!.license}</span>
                    </div>
                  </Show>
                  <Show when={data()!.maintainers.length > 0}>
                    <div class="ph-meta-row">
                      <span class="ph-meta-key">维护者</span>
                      <span class="ph-meta-value">{data()!.maintainers.join(", ")}</span>
                    </div>
                  </Show>
                </div>
              </div>

              <Show when={data()!.keywords.length > 0}>
                <div class="ph-side-block">
                  <div class="ph-side-title">关键词</div>
                  <div class="ph-chips">
                    <For each={data()!.keywords}>{(keyword) => <span class="ph-chip">{keyword}</span>}</For>
                  </div>
                </div>
              </Show>

              <Show when={data()!.dependencies.length > 0}>
                <div class="ph-side-block">
                  <details class="ph-details">
                    <summary>依赖 {data()!.dependencies.length} 个</summary>
                    <div class="ph-chips">
                      <For each={data()!.dependencies}>{(dep) => <span class="ph-chip">{dep}</span>}</For>
                    </div>
                  </details>
                </div>
              </Show>
            </aside>
          </div>
        </Show>

        <Show when={!loading() && !data()}>
          <div class="ph-readme-empty">{failure() || "未能读取这个包的详情。"}</div>
        </Show>
      </div>
    </ui.Dialog>
  )
}

export function PluginHubPage(props: { ctx: Context; admin: AdminClient; embedded?: boolean }) {
  const ui = props.ctx.ui
  const [state, setState] = createSignal<HubState>()
  const [tab, setTab] = createSignal<Tab>("catalog")

  const [catalog, setCatalog] = createSignal<readonly CatalogEntry[]>([])
  const [meta, setMeta] = createSignal<CatalogResult>()
  const [filter, setFilter] = createSignal("")
  const [typeFilter, setTypeFilter] = createSignal<TypeFilter>("all")
  const [limit, setLimit] = createSignal(PAGE)

  const [hits, setHits] = createSignal<readonly SearchHit[]>([])
  const [query, setQuery] = createSignal("")
  const [searched, setSearched] = createSignal(false)
  /** 这批结果对应的关键词；输入框会先变，结果区只说已经搜过的那个词。 */
  const [resultQuery, setResultQuery] = createSignal("")
  const [searchError, setSearchError] = createSignal("")
  const [sort, setSort] = createSignal<Sort>("relevance")
  /** 搜索结果分批渲染：50 张卡一次挂载会拖慢首屏。 */
  const [hitLimit, setHitLimit] = createSignal(12)

  const [updates, setUpdates] = createSignal<Map<string, UpdateInfo>>(new Map())
  const [checked, setChecked] = createSignal(false)
  const [installedQuery, setInstalledQuery] = createSignal("")
  const [installedFilter, setInstalledFilter] = createSignal<InstalledFilter>("all")
  // 运行事实（服务端已加载/失败/未知），与“已在配置中”分开表达。
  const [runtime, setRuntime] = createSignal<Map<string, RuntimeInfo>>(new Map())
  const [runtimeError, setRuntimeError] = createSignal("")
  /** 运行时里存在、但全局配置没有列出的插件（发现目录、项目配置）。 */
  const [discovered, setDiscovered] = createSignal<readonly DiscoveredPlugin[]>([])
  /** 配置与上一次已知运行状态不一致的条目数：安装/移除后等待宿主加载的数量。 */
  const pendingCount = createMemo(() => {
    const map = runtime()
    if (map.size === 0) return 0 // 从未拿到过运行事实：不虚构“待生效”数量
    return (state()?.plugins ?? []).filter((entry) => {
      if (entry.kind === "control" || entry.kind === "enable-rule" || entry.rule) return false
      const info = map.get(entry.spec)
      // 已暂停的插件本来就不该在运行时列表里，不算“等加载”。
      if (info?.paused) return false
      // unknown：服务端已应答但没加载它；info 缺失：刚改过配置，尚未重新读取。
      // failed 是“已加载但报错”，不算等待加载。
      return !info || (info.status === "unknown" && info.available)
    }).length
  })
  /**
   * 待生效状态栏只在拿到过运行事实、且确有配置项与运行事实不一致时出现。
   * 服务端读不到（旧版本后台）时显示未知，不显示虚构的“全部已生效”。
   */
  const hasPendingChanges = () => runtime().size > 0 && pendingCount() > 0
  const pendingChangesCount = () => pendingCount()

  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [note, setNote] = createSignal<Note>()
  const isBusy = (key: string) => busyKeys().has(key)
  const begin = (key: string) =>
    setBusyKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  const end = (key: string) =>
    setBusyKeys((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  /**
   * 同一个键只允许一个操作在跑：生命周期操作已经由后端加了锁，这里再加一道，
   * 是为了不让「连点两下」把两个请求都发出去、让第二个白等一次失败。
   */
  const track = async <T,>(key: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (isBusy(key)) {
      notify(`${key.replace(/^install:/, "")} 上一个操作还没结束，请稍等`, "warning")
      return undefined
    }
    begin(key)
    try {
      return await task()
    } finally {
      end(key)
    }
  }
  /** scope 让目录/搜索的失败只留在对应页签，不跟着用户跑到「已安装」。 */
  const notify = (text: string, tone: Tone = "info", scope?: Tab) =>
    setNote(text ? { text, tone, scope } : undefined)
  const visibleNote = () => {
    const current = note()
    if (!current) return undefined
    if (current.scope && current.scope !== tab()) return undefined
    return current
  }

  const refresh = async () => {
    try {
      setState(await props.admin.snapshot())
    } catch (error) {
      notify(readableError(error), "error")
    }
  }

  /** 读取服务端运行事实；读不到时保留 unknown，不假装全部已加载。 */
  const loadRuntime = async () => {
    try {
      const result = await props.admin.runtime()
      const map = new Map<string, RuntimeInfo>()
      for (const item of result.items) map.set(item.spec, item)
      setRuntime(map)
      setDiscovered(result.discovered ?? [])
      setRuntimeError(result.error)
    } catch (error) {
      // Older running builds have no runtime method: keep the honest unknown state.
      setRuntime(new Map())
      setDiscovered([])
      setRuntimeError((state()) ? readableError(error) : "")
    }
  }

  /** Fills the update map: keyed by config spec, so directory plugins match their own row. */
  const checkUpdates = async (silent = false) => {
    await track("updates", async () => {
      try {
        const result = await props.admin.updates()
        const map = new Map<string, UpdateInfo>()
        for (const item of result.items) map.set(item.spec, item)
        setUpdates(map)
        // 整体失败时 items 为空：这不是“检查完成、全部最新”，不能标记为已检查。
        setChecked(result.error === "" && result.items.length > 0)
        if (silent) return
        const stale = result.items.filter((item) => item.hasUpdate).length
        const failed = result.items.filter((item) => item.official === "failed").length
        const skipped = result.items.filter((item) => item.official === "skipped").length
        // 官方命令跳过本地插件和精确锁定版本：这是设计行为，要说明原因而不是报错。
        const message = result.error
          ? `${result.error}${result.raw ? `（${result.raw}）` : ""}`
          : failed > 0
            ? `${failed} 个插件官方检查失败${stale > 0 ? `，${stale} 个可更新` : ""}`
            : stale > 0
              ? `官方检查发现 ${stale} 个可更新的插件${skipped > 0 ? `（${skipped} 个按规则跳过）` : ""}`
              : skipped > 0
                ? `官方检查：没有可更新的插件（${skipped} 个被跳过，见每行原因）`
                : "官方检查：已检查的插件均为最新版本"
        notify(
          message,
          result.error ? "error" : failed > 0 ? "warning" : stale > 0 ? "info" : "success",
        )
      } catch (error) {
        if (!silent) notify(readableError(error), "error")
      }
    })
  }

  const loadCatalog = async (force: boolean) => {
    await track("catalog", async () => {
      try {
        const result = await props.admin.browse({ force })
        setCatalog([...result.entries])
        setMeta(result)
        // A fallback source still shows the full list, so a network miss is a downgrade to note,
        // not an error to alarm about. Only the stale built-in snapshot is worth a warning.
        if (result.error) notify(result.error, result.source === "builtin" ? "warning" : "info", "catalog")
        // Keep the installed view in sync with what the catalog just reported.
        await refresh()
      } catch (error) {
        notify(readableError(error), "error", "catalog")
      }
    })
  }

  const runSearch = async (text: string) => {
    setQuery(text)
    // 只接受最后一次请求的结果：较早的关键词晚返回时不得覆盖新结果。
    const seq = ++searchSeq
    await track("search", async () => {
      try {
        const result = await props.admin.search({ query: text })
        if (seq !== searchSeq) return
        setHits(result.hits)
        setResultQuery(text.trim())
        setSearchError(result.error)
        setSearched(true)
        if (result.error) notify(result.error, "error", "search")
      } catch (error) {
        if (seq !== searchSeq) return
        // 搜索失败时清空旧结果，避免用户把上一个关键词的结果当成这一次的。
        setHits([])
        setResultQuery(text.trim())
        setSearchError(readableError(error))
        setSearched(true)
        notify(readableError(error), "error", "search")
      }
    })
  }

  /** 输入防抖 450ms 自动搜索；同一个词不重复请求。 */
  let searchTimer: number | undefined
  let lastSearch = ""
  let searchSeq = 0
  const scheduleSearch = (text: string) => {
    setQuery(text)
    if (searchTimer) window.clearTimeout(searchTimer)
    const trimmed = text.trim()
    if (!trimmed) {
      // 清空即失效：排队中的旧结果不允许再回填。
      searchSeq += 1
      return
    }
    searchTimer = window.setTimeout(() => {
      if (trimmed === lastSearch) return
      lastSearch = trimmed
      void runSearch(trimmed)
    }, 450)
  }

  /**
   * 所有生命周期操作结果的唯一出口：文案和语气都来自 explainMutation。
   * 入口自己不判断成没成功——服务端已经按阶段说清了，界面不再猜第二遍。
   */
  const reportMutation = (result: MutationResult, successTone: Tone = "success") => {
    const report = explainMutation(result, successTone)
    notify(report.text, report.tone)
  }

  const specFor = (name: string) => state()?.plugins.find((entry) => entry.name === name)?.spec ?? name

  const install = async (name: string, version = "") => {
    await track(`install:${name}`, async () => {
      try {
        const result = await props.admin.install({ spec: name, version })
        // 服务端回的就是权威状态：先用它，再重新读一遍运行事实。
        setState(result.state)
        reportMutation(result)
        if (!result.ok && result.stages?.config !== "updated") return
        // 只有配置真的改了才动本地列表，失败时不能提前把目录/搜索结果改成“已安装”。
        if (result.stages?.config === "updated") {
          setCatalog((prev) => prev.map((entry) => (entry.pkg === name ? { ...entry, installed: true } : entry)))
          setHits((prev) =>
            prev.map((hit) =>
              hit.name === name
                ? { ...hit, installed: true, current: version || result.stages?.version || hit.current, hasUpdate: false }
                : hit,
            ),
          )
        }
        // 配置变了：之前的运行事实与检查结果都已过期，全部重新读取。
        await Promise.all([loadRuntime(), checkUpdates(true)])
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  /** 更新走官方 `opencode plugin update <target>`，不走“再装一次”。 */
  const updatePlugin = async (spec: string, name: string) => {
    await track(`install:${name}`, async () => {
      try {
        const result = await props.admin.update({ spec, version: "" })
        setState(result.state)
        reportMutation(result)
        if (!result.ok && result.stages?.config !== "updated") return
        await Promise.all([loadRuntime(), checkUpdates(true)])
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const pausePlugin = async (entry: PluginEntry) => {
    await track(`install:${entry.name}`, async () => {
      try {
        const result = await props.admin.pause({ spec: entry.spec, version: "" })
        setState(result.state)
        // 暂停是“中性”成功：规则写进去了，但宿主仍可能在跑它，所以用 info 而不是 success。
        reportMutation(result, "info")
        if (!result.ok) return
        await loadRuntime()
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const resumePlugin = async (entry: PluginEntry) => {
    await track(`install:${entry.name}`, async () => {
      try {
        const result = await props.admin.resume({ spec: entry.spec, version: "" })
        setState(result.state)
        reportMutation(result)
        if (!result.ok) return
        await loadRuntime()
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const uninstall = async (entry: PluginEntry) => {
    const isPath = entry.kind === "path"
    const ok = await props.ctx.dialogs.confirm({
      title: `移除 ${entry.name}？`,
      description: isPath
        ? "只从配置里移除这个目录条目，磁盘上的目录不会被删除。"
        : "npm 插件走官方 opencode plugin remove：只改配置，不删除缓存里的包文件，也不会删除本地目录。",
      confirm: "移除",
      danger: true,
    })
    if (!ok) return
    await track(`install:${entry.name}`, async () => {
      try {
        const result = await props.admin.remove({ spec: entry.spec, version: "" })
        setState(result.state)
        reportMutation(result)
        if (!result.ok) return
        setCatalog((prev) =>
          prev.map((item) => (item.pkg === entry.name ? { ...item, installed: false } : item)),
        )
        setHits((prev) =>
          prev.map((hit) =>
            hit.name === entry.name ? { ...hit, installed: false, current: "", hasUpdate: false } : hit,
          ),
        )
        setUpdates((prev) => {
          const next = new Map(prev)
          next.delete(entry.spec)
          return next
        })
        void loadRuntime()
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const reload = async () => {
    await track("reload", async () => {
      try {
        const result = await props.admin.reload()
        setState(result.state)
        notify(result.message, result.ok ? "success" : "error")
        // 重载之后运行事实必然过期，立即重新读取。
        if (result.ok) await loadRuntime()
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const openUrl = async (url: string) => {
    if (!url) return
    try {
      const result = await props.admin.openUrl({ url })
      if (!result.ok) notify(`无法打开链接：${url}`, "error")
    } catch (error) {
      notify(readableError(error), "error")
    }
  }

  const openConfig = async () => {
    await track("config", async () => {
      try {
        const result = await props.admin.openConfig()
        if (!result.ok) notify("无法打开配置文件", "error")
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const openDetail = (name: string, fallback?: DetailFallback) => {
    props.ctx.dialogs.open((dialog) => (
      <DetailDialog
        ctx={props.ctx}
        admin={props.admin}
        name={name}
        fallback={fallback}
        busy={isBusy(`install:${name}`)}
        onInstall={(version) => {
          dialog.close()
          void install(name, version)
        }}
        onClose={() => dialog.close()}
      />
    ))
  }

  /** Local filter over the curated list: no request per keystroke. */
  const visible = createMemo(() => {
    const needle = filter().trim().toLowerCase()
    const type = typeFilter()
    return catalog().filter((entry) => {
      if (type !== "all" && entry.type !== type) return false
      if (!needle) return true
      return [entry.name, entry.pkg, entry.desc, entry.long, ...entry.tags]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    })
  })

  const typeCounts = createMemo<Record<TypeFilter, number>>(() => {
    const all = catalog()
    return {
      all: all.length,
      plugins: all.filter((entry) => entry.type === "plugins").length,
      mcp: all.filter((entry) => entry.type === "mcp").length,
      themes: all.filter((entry) => entry.type === "themes").length,
    }
  })

  const sortedHits = createMemo(() => {
    const list = [...hits()]
    if (sort() === "downloads") list.sort((a, b) => b.weekly - a.weekly) // -1 (unknown) sinks to the end
    else if (sort() === "recent") list.sort((a, b) => (b.published || "").localeCompare(a.published || ""))
    return list
  })
  const visibleHits = createMemo(() => sortedHits().slice(0, hitLimit()))
  const searchInstalledCount = createMemo(() => hits().filter((hit) => hit.installed).length)
  const searchUpdateCount = createMemo(() => hits().filter((hit) => hit.hasUpdate).length)
  // 结果集合变化（新搜索、清空）后回到首批；副作用放在 createEffect 而不是 memo 里。
  createEffect(() => {
    void hits()
    setHitLimit(12)
  })

  const registryUrl = () => meta()?.registry || CATALOG_SOURCE_FALLBACK
  const outdated = createMemo(() => [...updates().values()].filter((item) => item.hasUpdate).length)
  // 未能检查的条目数：官方检查失败或结果无法识别，都不能被总结成“已是最新”。
  const uncheckedCount = createMemo(
    () => [...updates().values()].filter((item) => item.official === "failed" || item.official === "unknown").length,
  )

  /** 运行事实：已加载 / 加载失败 / 已暂停 / 待加载 / 未验证 / 配置规则。 */
  const runtimeState = (entry: PluginEntry): RowState => {
    // `-id` / `*` 是配置里的启用规则，不参与“是否已加载”的判断。
    if (entry.kind === "control") return "control"
    // 插件中心自己追加的启用规则（裸 ID）看上去像包名，但它是规则。
    if (entry.kind === "enable-rule" || entry.rule) return "rule"
    const info = runtime().get(entry.spec)
    // 规则明确禁用时，运行时不报告它是正常现象 —— 先表达“已暂停”，不当作未验证。
    if (info?.paused) return "paused"
    if (!info) return runtimeError() ? "unknown" : "pending"
    if (info.status === "failed") return "failed"
    if (info.status === "loaded") return "loaded"
    // 服务端已应答但列表里没有：配置已写入、尚未被加载；应答不可用才是真正的“未验证”。
    return info.available ? "pending" : "unknown"
  }
  const failedCount = createMemo(
    () => (state()?.plugins ?? []).filter((entry) => runtimeState(entry) === "failed").length,
  )
  const pausedCount = createMemo(
    () => (state()?.plugins ?? []).filter((entry) => runtimeState(entry) === "paused").length,
  )
  const pendingRuntimeCount = createMemo(
    () => (state()?.plugins ?? []).filter((entry) => runtimeState(entry) === "pending").length,
  )
  const unknownCount = createMemo(
    () => (state()?.plugins ?? []).filter((entry) => runtimeState(entry) === "unknown").length,
  )
  const filterCounts = createMemo<Record<InstalledFilter, number>>(() => ({
    all: state()?.plugins.length ?? 0,
    update: outdated(),
    paused: pausedCount(),
    failed: failedCount(),
    pending: pendingRuntimeCount(),
    unknown: unknownCount(),
  }))
  /** 只有确实存在问题项时才显示摘要；顺序与列表严重程度一致。 */
  const attentionItems = createMemo(() => {
    const items: { id: InstalledFilter; label: string; count: number; tone: "danger" | "accent" | "warning" }[] = []
    if (failedCount() > 0) items.push({ id: "failed", label: "加载失败", count: failedCount(), tone: "danger" })
    if (pendingRuntimeCount() > 0)
      items.push({ id: "pending", label: "待加载", count: pendingRuntimeCount(), tone: "accent" })
    if (outdated() > 0) items.push({ id: "update", label: "可更新", count: outdated(), tone: "warning" })
    return items
  })
  /** 问题项排前面：加载失败 → 待加载 → 可更新 → 未验证 → 已暂停 → 正常 → 配置规则，同级保持配置顺序。 */
  const severity = (entry: PluginEntry): number => {
    const status = runtimeState(entry)
    if (status === "control" || status === "rule") return 6
    if (status === "failed") return 0
    if (status === "pending") return 1
    if (updates().get(entry.spec)?.hasUpdate) return 2
    if (status === "unknown") return 3
    // 暂停是用户主动造成的“不生效”，比正常项更值得先看到，但仍排在故障之后。
    if (status === "paused") return 4
    return 5
  }
  const visiblePlugins = createMemo(() => {
    const needle = installedQuery().trim().toLowerCase()
    const filter = installedFilter()
    return (state()?.plugins ?? [])
      .filter((entry) => {
        if (filter === "update" && updates().get(entry.spec)?.hasUpdate !== true) return false
        if (filter === "paused" && runtimeState(entry) !== "paused") return false
        if (filter === "failed" && runtimeState(entry) !== "failed") return false
        if (filter === "pending" && runtimeState(entry) !== "pending") return false
        if (filter === "unknown" && runtimeState(entry) !== "unknown") return false
        if (!needle) return true
        const info = updates().get(entry.spec)
        return [entry.name, entry.spec, info?.description ?? "", info?.publisher ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      })
      .sort((a, b) => severity(a) - severity(b))
  })
  const bySpec = (spec: string) => updates().get(spec)
  const byPackage = createMemo(() => {
    const map = new Map<string, UpdateInfo>()
    for (const item of updates().values()) map.set(item.name, item)
    return map
  })

  const switchTab = (next: Tab) => {
    setTab(next)
    // Leaving the installed view resets its filters, so a searched name does not
    // silently hide the list next time it is opened.
    if (next !== "installed") {
      setInstalledFilter("all")
      setInstalledQuery("")
    }
    // The first look at the installed list also checks the registry, once.
    if (next !== "catalog" && !checked() && !isBusy("updates")) void checkUpdates(true)
  }

  onMount(() => {
    // refresh 先行保证「已安装」不依赖目录拉取的成败；loadCatalog 成功后还会再同步一次。
    void refresh()
    void loadCatalog(false)
    void checkUpdates(true)
    void loadRuntime()
  })

  const tabButton = (id: Tab, label: string, icon: IconName, count?: number | string, alert?: number) => (
    <button
      class="ph-tab"
      role="tab"
      id={`ph-tab-${id}`}
      aria-selected={tab() === id}
      aria-controls="ph-tabpanel"
      data-active={tab() === id}
      onClick={() => switchTab(id)}
      onKeyDown={(event) => {
        // 左右方向键在页签间移动，符合 tablist 的键盘约定。
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        const order: Tab[] = ["catalog", "search", "installed"]
        const index = order.indexOf(tab())
        const next = event.key === "ArrowRight" ? (index + 1) % order.length : (index + order.length - 1) % order.length
        switchTab(order[next]!)
      }}
    >
      <ui.Icon name={icon} size="small" />
      {label}
      <Show when={count !== undefined && count !== ""}>
        <span class="ph-count">{count}</span>
      </Show>
      <Show when={alert !== undefined && alert > 0}>
        <span class="ph-count ph-count-alert" title={`${alert} 个可更新`}>
          {alert} 可更新
        </span>
      </Show>
    </button>
  )

  const versionLabel = (current: string, latest: string, stale: boolean) => (
    <span class="ph-version">
      {current ? `v${current}` : ""}
      <Show when={stale && latest}>
        <span class="ph-version-arrow"> → v{latest}</span>
      </Show>
    </span>
  )

  const catalogRow = (entry: CatalogEntry) => {
    const info = () => byPackage().get(entry.pkg)
    const stale = () => info()?.hasUpdate === true
    const busy = () => isBusy(`install:${entry.pkg}`)
    const detail = () =>
      openDetail(entry.pkg, {
        version: entry.version,
        description: entry.desc || entry.long,
        repo: entry.repo,
      })
    return (
      <article class="ph-card" data-stale={stale() ? "true" : undefined} data-busy={busy() ? "true" : undefined}>
        <div class="ph-card-main">
          <div class="ph-card-head">
            <div class="ph-tile">
              <ui.Icon name={typeIcon(entry.type)} size="normal" />
            </div>
            <div class="ph-card-titles">
              <div class="ph-name-row">
                <span class="ph-name" title={entry.name}>
                  {entry.name}
                </span>
                <Show when={stale()}>
                  <span class="ph-badge" data-tone="accent" title={`可更新至 v${info()!.latest}`}>
                    可更新
                  </span>
                </Show>
                <Show when={!stale() && entry.installed}>
                  <span class="ph-badge" data-tone="success">
                    已安装
                  </span>
                </Show>
              </div>
              <div class="ph-card-sub">
                <Show
                  when={entry.pkg}
                  fallback={
                    <span class="ph-pkg" title={entry.repo}>
                      GitHub 仓库
                    </span>
                  }
                >
                  <span class="ph-pkg" title={entry.pkg}>
                    {entry.pkg}
                  </span>
                </Show>
                <Show when={entry.version}>
                  <span class="ph-dot" />
                  <span class="ph-version">v{entry.version}</span>
                </Show>
                <Show when={stale()}>
                  <span class="ph-version-arrow">→ v{info()!.latest}</span>
                </Show>
              </div>
            </div>
          </div>
          <div
            class="ph-card-body"
            role="button"
            tabindex="0"
            onClick={() => (entry.pkg ? detail() : void openUrl(entry.repo))}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                if (entry.pkg) detail()
                else void openUrl(entry.repo)
              }
            }}
          >
            <div class="ph-desc ph-clamp">{entry.desc || entry.long || "—"}</div>
            <div class="ph-meta">
              <span class="ph-type">{TYPE_LABEL[entry.type] ?? entry.type}</span>
              <Show when={!entry.pkg}>
                <span class="ph-dot" />
                <span>仅 GitHub 发布</span>
              </Show>
              <Show when={entry.tags.length > 0}>
                <span class="ph-dot" />
                <span>{entry.tags.slice(0, 3).join(" / ")}</span>
              </Show>
            </div>
          </div>
        </div>
        <div class="ph-actions">
          <div class="ph-actions-left">
            <Show when={entry.pkg}>
              <ui.Button variant="ghost" size="small" icon="eye" onClick={detail}>
                详情
              </ui.Button>
            </Show>
            <ui.Button
              variant="ghost-muted"
              size="small"
              icon="square-arrow-top-right"
              onClick={() => void openUrl(entry.repo)}
            >
              源码
            </ui.Button>
          </div>
          <div class="ph-actions-right">
            <Show when={!stale() && !entry.installed && !entry.pkg}>
              <span class="ph-badge">需手动</span>
            </Show>
            <Show when={stale()}>
              <ui.Button
                variant="neutral"
                size="small"
                icon="download"
                busy={busy()}
                onClick={() => void updatePlugin(specFor(entry.pkg), entry.pkg)}
              >
                更新
              </ui.Button>
            </Show>
            <Show when={!stale() && !entry.installed && entry.pkg}>
              <ui.Button
                variant="neutral"
                size="small"
                icon="download"
                busy={busy()}
                onClick={() => void install(entry.pkg)}
              >
                安装
              </ui.Button>
            </Show>
          </div>
        </div>
      </article>
    )
  }

  const searchRow = (hit: SearchHit) => {
    const detail = () =>
      openDetail(hit.name, {
        version: hit.version,
        description: hit.description,
        homepage: hit.homepage,
        repo: hit.repo,
        npm: hit.npm,
      })
    return (
      <article
        class="ph-card"
        data-stale={hit.hasUpdate ? "true" : undefined}
        data-busy={isBusy(`install:${hit.name}`) ? "true" : undefined}
      >
        <div class="ph-card-main">
          <div class="ph-card-head">
            <div class="ph-tile">{initial(hit.name)}</div>
            <div class="ph-card-titles">
              <div class="ph-name-row">
                <span class="ph-name" title={hit.name}>
                  {hit.name}
                </span>
                <Show when={hit.hasUpdate}>
                  <span class="ph-badge" data-tone="accent">
                    可更新
                  </span>
                </Show>
                <Show when={!hit.hasUpdate && hit.installed}>
                  <span class="ph-badge" data-tone="success">
                    已安装
                  </span>
                </Show>
              </div>
              <div class="ph-card-sub">
                <span class="ph-pkg">npm</span>
                <Show when={hit.version}>
                  <span class="ph-dot" />
                  <span class="ph-version">v{hit.version}</span>
                </Show>
                <Show when={hit.installed && hit.current}>
                  <span class="ph-dot" />
                  <span class="ph-version">当前 v{hit.current}</span>
                </Show>
              </div>
            </div>
          </div>
          <div
            class="ph-card-body"
            role="button"
            tabindex="0"
            onClick={detail}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                detail()
              }
            }}
          >
            <div class="ph-desc ph-clamp">{hit.description || "—"}</div>
            <div class="ph-meta">
              <span class="ph-meta-strong" title={countTitle(hit.weekly, "周下载")}>
                <ui.Icon name="download" size="small" />
                {countWithUnit(hit.weekly, "周")}
              </span>
              <span class="ph-dot" />
              <span title={countTitle(hit.monthly, "月下载")}>{countWithUnit(hit.monthly, "月")}</span>
              <Show when={hit.publisher}>
                <span class="ph-dot" />
                <span>by {hit.publisher}</span>
              </Show>
              <Show when={hit.published}>
                <span class="ph-dot" />
                <span>{relativeDate(hit.published)}更新</span>
              </Show>
            </div>
          </div>
        </div>
        <div class="ph-actions">
          <div class="ph-actions-left">
            <Show when={hit.homepage}>
              <ui.Tooltip value="主页">
                <ui.IconButton icon="globe" size="small" label="主页" onClick={() => void openUrl(hit.homepage)} />
              </ui.Tooltip>
            </Show>
            <Show when={hit.repo}>
              <ui.Tooltip value="源码仓库">
                <ui.IconButton
                  icon="github"
                  size="small"
                  label="源码仓库"
                  onClick={() => void openUrl(hit.repo)}
                />
              </ui.Tooltip>
            </Show>
            <ui.Button variant="ghost" size="small" icon="eye" onClick={detail}>
              详情
            </ui.Button>
          </div>
          <div class="ph-actions-right">
            <Show when={hit.hasUpdate}>
              <ui.Button
                variant="neutral"
                size="small"
                icon="download"
                busy={isBusy(`install:${hit.name}`)}
                onClick={() => void updatePlugin(specFor(hit.name), hit.name)}
              >
                更新
              </ui.Button>
            </Show>
            <Show when={!hit.hasUpdate && !hit.installed}>
              <ui.Button
                variant="neutral"
                size="small"
                icon="download"
                busy={isBusy(`install:${hit.name}`)}
                onClick={() => void install(hit.name)}
              >
                安装
              </ui.Button>
            </Show>
          </div>
        </div>
      </article>
    )
  }

  const installedRow = (entry: PluginEntry) => {
    const info = () => bySpec(entry.spec)
    const busy = () => isBusy(`install:${entry.name}`)
    const control = () => entry.kind === "control"
    const rule = () => entry.kind === "enable-rule" || entry.rule === true
    const packageLike = () => !control() && !rule() && entry.kind !== "path"
    // 只有 npm 包才谈得上「有更新」：目录插件外部维护，规则条目根本不是插件。
    const stale = () => packageLike() && info()?.hasUpdate === true
    const current = () => info()?.current || entry.version
    const unchecked = () => packageLike() && (info()?.official === "failed" || info()?.official === "unknown")
    /**
     * 概述先取快照里的本地 package.json，registry 检查回来后用它的结果覆盖。
     * 只用 registry 会让整列描述在断网或检查未完成时集体变空——包明明就在磁盘上。
     */
    const summary = () => info()?.description || entry.description || ""
    const publisher = () => info()?.publisher || ""
    const runtimeInfo = () => runtime().get(entry.spec)
    const runtimeStatus = () => runtimeState(entry)
    /** 运行时 ID 与包名不一致时单独列出来：暂停/恢复用的就是这个 ID。 */
    const runtimeId = () => runtimeInfo()?.id || ""
    /** 徽章的语气与运行状态一一对应；暂停和规则用中性，不把用户的选择画成故障。 */
    const runtimeTone = () => {
      const status = runtimeStatus()
      if (status === "failed") return "danger"
      if (status === "unknown") return "warning"
      if (status === "pending") return "accent"
      if (status === "loaded") return "success"
      return undefined
    }
    const runtimeLabel = () =>
      runtimeStatus() === "loaded"
        ? "运行中"
        : runtimeStatus() === "failed"
          ? "加载失败"
          : runtimeStatus() === "paused"
            ? "已暂停"
            : runtimeStatus() === "control"
              ? "禁用规则"
              : runtimeStatus() === "rule"
                ? "启用规则"
                : runtimeStatus() === "pending"
                  ? "待加载"
                  : "未验证"
    const runtimeHint = () => {
      const status = runtimeStatus()
      if (status === "loaded") {
        const loaded = runtimeInfo()?.runtimeVersion
        return loaded ? `已加载 v${loaded}${runtimeId() ? `（ID ${runtimeId()}）` : ""}` : "宿主已报告加载成功"
      }
      if (status === "failed") return runtimeInfo()?.error || "宿主报告加载失败"
      if (status === "paused") {
        const rule = runtimeInfo()?.rule
        if (!rule) return "配置规则禁用了它"
        // 精确规则只针对这一个插件；通配规则是用户写来覆盖一批插件的，恢复方式不一样。
        return runtimeInfo()?.pausedBy === "wildcard"
          ? `通配规则 ${rule} 覆盖了它（可能同时禁用其他插件）；插件未被卸载，恢复会在末尾追加一条启用规则，通配规则本身不动`
          : `精确规则 ${rule} 禁用了它；插件未被卸载，移除这条规则即可恢复`
      }
      if (status === "control") return "配置里的禁用/通配规则，不是已安装的插件包"
      if (status === "rule") return "插件中心追加的启用规则（裸 ID），不是插件包"
      if (status === "pending") return "配置已写入，等待宿主重新加载（自动重载，或点「重载配置」）"
      return "没有取得宿主的加载证据，不当作已生效"
    }
    /** 无法暂停：运行时不报 ID 的待加载/未验证项，规则也就无从写起。 */
    const canPause = () =>
      !control() && !rule() && runtimeStatus() !== "paused" && runtimeStatus() !== "pending" && runtimeStatus() !== "unknown"
    return (
      <article
        class="ph-card"
        data-stale={stale() ? "true" : undefined}
        data-busy={busy() ? "true" : undefined}
        data-status={runtimeStatus()}
      >
        <div class="ph-card-main">
          <div class="ph-card-head">
            <div class="ph-tile" data-runtime={runtimeStatus()}>
              <Show when={control() || rule()} fallback={initial(entry.name)}>
                <ui.Icon name={control() ? "circle-ban-sign" : "check"} size="normal" />
              </Show>
            </div>
            <div class="ph-card-titles">
              <div class="ph-name-row">
                <span class="ph-name" title={entry.name}>
                  {entry.name}
                </span>
              </div>
              <div class="ph-installed-meta" title={entry.spec}>
                <Show when={!control() && !rule()} fallback={<span>禁用/通配规则</span>}>
                  <span>{current() ? `v${current()}` : "版本未知"}</span>
                </Show>
                <Show when={stale()}>
                  <span class="ph-version-arrow">→ v{info()!.latest}</span>
                </Show>
                <Show when={runtimeId() && runtimeId() !== entry.name}>
                  <span class="ph-dot" />
                  <span data-ellipsis title="宿主实际加载的插件 ID，暂停/恢复用的就是它">ID {runtimeId()}</span>
                </Show>
                <Show when={publisher()}>
                  <span class="ph-dot" />
                  <span>by {publisher()}</span>
                </Show>
              </div>
            </div>
          </div>
          <div class="ph-card-status">
            <span class="ph-badge" data-runtime={runtimeStatus()} data-tone={runtimeTone()} title={runtimeHint()}>
              {runtimeLabel()}
            </span>
            <Show when={entry.kind === "path"}>
              <span class="ph-badge" title="本地目录插件由外部维护：目录里可能有你的改动，插件中心不会覆盖它">
                本地目录
              </span>
            </Show>
            <Show when={stale()}>
              <span class="ph-badge" data-tone="accent">
                可更新 → v{info()!.latest}
              </span>
            </Show>
            <Show when={unchecked()}>
              <span class="ph-badge" data-tone="warning" title={info()!.reason || info()!.error}>
                未能检查
              </span>
            </Show>
            {/* 目录插件的「跳过更新」已由上面那条徽章说清，规则条目更谈不上更新，不重复。 */}
            <Show when={packageLike() && info()?.official === "skipped" && !stale()}>
              <span class="ph-badge" data-tone="warning" title={info()!.reason}>
                跳过更新
              </span>
            </Show>
            <Show when={packageLike() && info()?.pinned && !stale()}>
              <span class="ph-badge" title="配置写的是精确版本，官方更新会跳过它">
                精确锁定
              </span>
            </Show>
          </div>
          <div class="ph-card-body">
            {/* 失败原因占用描述的两行位置，而不是把卡片撑高、让同排卡片留白。 */}
            <Show
              when={runtimeInfo()?.error}
              fallback={
                <div class="ph-desc ph-clamp" title={summary() || entry.spec}>
                  {summary() || entry.spec}
                </div>
              }
            >
              <div class="ph-runtime-error ph-clamp" title={`${entry.spec}\n${runtimeInfo()!.error}`}>
                加载失败：{runtimeInfo()!.error}
              </div>
            </Show>
          </div>
        </div>
        <div class="ph-actions">
          <div class="ph-actions-left">
            <Show when={packageLike() && NPM_LIKE.test(entry.name)}>
              <ui.Button
                variant="ghost"
                size="small"
                icon="eye"
                onClick={() => openDetail(entry.name, { version: current() })}
              >
                详情
              </ui.Button>
            </Show>
          </div>
          <div class="ph-actions-right">
            <Show when={stale()}>
              <ui.Button
                variant="neutral"
                size="small"
                icon="download"
                busy={busy()}
                onClick={() => void updatePlugin(entry.spec, entry.name)}
              >
                更新
              </ui.Button>
            </Show>
            <Show when={canPause()}>
              <ui.Button
                variant="ghost-muted"
                size="small"
                icon="circle-ban-sign"
                busy={busy()}
                onClick={() => void pausePlugin(entry)}
              >
                暂停
              </ui.Button>
            </Show>
            <Show when={runtimeStatus() === "paused"}>
              <ui.Button
                variant="ghost"
                size="small"
                icon="check"
                busy={busy()}
                onClick={() => void resumePlugin(entry)}
              >
                恢复
              </ui.Button>
            </Show>
            <Show when={entry.removable}>
              <ui.Button
                variant="ghost-muted"
                size="small"
                icon="trash"
                busy={busy()}
                onClick={() => void uninstall(entry)}
              >
                移除
              </ui.Button>
            </Show>
          </div>
        </div>
      </article>
    )
  }

  const installedFilterButton = (id: InstalledFilter, label: string) => (
    <button
      class="ph-chip"
      data-active={installedFilter() === id}
      title={`${label}：${filterCounts()[id]} 个`}
      onClick={() => setInstalledFilter(id)}
    >
      {label}
      <span class="ph-chip-count">{filterCounts()[id]}</span>
    </button>
  )

  return (
    <div class="ph-root" data-embedded={props.embedded ? "true" : undefined}>
      <style>{CSS}</style>

      <section class="ph-hero">
        <div class="ph-hero-copy">
          <Show when={!props.embedded}>
            <h2 class="ph-title">
              <span class="ph-title-icon">
                <ui.Icon name="extensions" size="small" />
              </span>
              插件中心
            </h2>
          </Show>
          <p class="ph-sub">
            浏览{" "}
            <button
              type="button"
              class="ph-inline-source"
              title={CATALOG_SOURCE_TITLE}
              onClick={() => void openUrl(registryUrl())}
            >
              awesome-opencode
            </button>{" "}
            社区维护的精选目录与 npm 上的 OpenCode 插件。安装前先看 README 与来源。
          </p>
        </div>
        <div class="ph-path" title={state()?.configPath}>
          <span class="ph-path-key">配置</span>
          <code>{state()?.configPath ?? "读取中…"}</code>
          <span class="ph-dot" />
          <code>{state()?.configKey ?? "plugins"}[]</code>
        </div>
      </section>

      <Show when={visibleNote() || state()?.error || runtimeError()}>
        <div class="ph-notices">
          <Show when={visibleNote()}>
            <div class="ph-notice" data-tone={visibleNote()!.tone}>
              <ui.Icon name={noteIcon(visibleNote()!.tone)} size="small" />
              <span class="ph-notice-text">{visibleNote()!.text}</span>
              <button type="button" class="ph-notice-close" aria-label="关闭提示" onClick={() => setNote(undefined)}>
                <ui.Icon name="close" size="small" />
              </button>
            </div>
          </Show>

          <Show when={state()?.error}>
            <div class="ph-notice" data-tone="error">
              <ui.Icon name="circle-exclamation" size="small" />
              <span class="ph-notice-text">{state()!.error}</span>
            </div>
          </Show>

          {/* 运行时读取失败不是一次弹完就忘的提示：留在页面上，直到重试成功或用户处理。 */}
          <Show when={runtimeError()}>
            <div class="ph-notice" data-tone="warning">
              <ui.Icon name="circle-exclamation" size="small" />
              <span class="ph-notice-body">{runtimeError()}。配置操作不受影响，可重试读取。</span>
              <div class="ph-notice-action">
                <ui.Button size="small" variant="ghost" icon="outline-rotate-clockwise" onClick={() => void loadRuntime()}>
                  重试
                </ui.Button>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <div class="ph-head">
        {/* 待生效变更常驻在工具栏，不占用正文高度；点击即可重载。 */}
        <Show when={hasPendingChanges()}>
          <div
            class="ph-pending"
            title="受监控的配置由 OpenCode 自动重新加载。需要立刻确认时点「立即重载」；插件中心只写配置，不接管宿主进程。"
          >
            <ui.Icon name="outline-rotate-clockwise" size="small" />
            <span>{pendingChangesCount()} 项配置变更等待宿主加载</span>
            <button type="button" class="ph-link" onClick={() => void reload()}>
              立即重载
            </button>
          </div>
        </Show>

        <div class="ph-toolbar">
          <div class="ph-tabs" role="tablist">
            {tabButton("catalog", "精选目录", "extensions", meta() ? catalog().length : undefined)}
            {tabButton("search", "npm 搜索", "magnifying-glass", searched() ? hits().length : undefined)}
            {tabButton("installed", "已安装", "checklist", state()?.plugins.length ?? 0, outdated())}
          </div>
          <span class="ph-spacer" />
          <Show when={tab() === "catalog"}>
            <ui.Button
              variant="ghost"
              size="small"
              icon="refresh"
              busy={isBusy("catalog")}
              onClick={() => void loadCatalog(true)}
            >
              更新目录
            </ui.Button>
          </Show>
          <Show when={tab() === "search"}>
            <Show when={searched()}>
              <ui.Button
                variant="ghost"
                size="small"
                icon="close"
                onClick={() => {
                  if (searchTimer) window.clearTimeout(searchTimer)
                  lastSearch = ""
                  searchSeq += 1 // 丢弃仍在路上的搜索结果
                  setHits([])
                  setSearched(false)
                  setQuery("")
                  setResultQuery("")
                  setSearchError("")
                  setNote(undefined)
                }}
              >
                清空
              </ui.Button>
            </Show>
          </Show>
          <Show when={tab() === "installed"}>
            <ui.Button
              variant="ghost"
              size="small"
              icon="refresh"
              busy={isBusy("updates")}
              onClick={() => void checkUpdates()}
            >
              检查更新
            </ui.Button>
          </Show>
          {/* 低频管理操作收进溢出菜单，工具栏只留当前任务需要的动作 */}
          <ui.Menu
            label="更多操作"
            icon="outline-dots"
            placement="bottom-end"
            items={[
              {
                type: "group",
                label: "配置",
                items: [
                  { label: "打开配置文件", icon: "open-file", onSelect: () => void openConfig() },
                  { label: "重载配置", icon: "refresh", onSelect: () => void reload() },
                ],
              },
            ]}
          />
        </div>
      </div>

      <Switch>
        <Match when={tab() === "catalog"}>
          <section class="ph-panel" role="tabpanel" id="ph-tabpanel" aria-labelledby={`ph-tab-${tab()}`}>
            <div class="ph-filters">
              <div class="ph-filter-row">
                <div class="ph-grow">
                  <ui.TextInput
                    label="筛选 awesome-opencode 精选插件"
                    placeholder="按名称、描述或标签筛选，例如 memory / auth / token"
                    type="search"
                    value={filter()}
                    onInput={(value) => {
                      setFilter(value)
                      setLimit(PAGE)
                    }}
                  />
                </div>
                <div class="ph-chips">
                  <For each={TYPE_FILTERS}>
                    {(item) => (
                      <button
                        class="ph-chip"
                        data-active={typeFilter() === item.value}
                        onClick={() => {
                          setTypeFilter(item.value)
                          setLimit(PAGE)
                        }}
                      >
                        {item.label}
                        <span class="ph-chip-count">{typeCounts()[item.value]}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <Show when={catalog().length > 0 || filter() !== "" || typeFilter() !== "all"}>
              <div class="ph-resultline">
                <span>
                  共 <strong>{catalog().length}</strong> 个精选
                </span>
                <Show when={filter() !== "" || typeFilter() !== "all"}>
                  <span>
                    · 匹配 <strong>{visible().length}</strong> 个
                  </span>
                  <button
                    class="ph-clear"
                    onClick={() => {
                      setFilter("")
                      setTypeFilter("all")
                      setLimit(PAGE)
                    }}
                  >
                    清除筛选
                  </button>
                </Show>
              </div>
            </Show>

            <Show when={isBusy("catalog") && catalog().length === 0}>
              <div class="ph-list">
                <For each={[0, 1, 2, 3]}>{() => <div class="ph-skeleton" />}</For>
              </div>
            </Show>

            <Show when={!isBusy("catalog") || catalog().length > 0}>
              <Show
                when={visible().length > 0}
                fallback={
                  /* 目录整个没拿到时不能报成「没有匹配」：那不是筛选的结果，是失败。
                     只有拿到内置快照（列表非空）时才退回关键词空态。 */
                  <Show
                    when={meta()?.error && catalog().length === 0}
                    fallback={
                      <div class="ph-empty">
                        <div class="ph-empty-icon">
                          <ui.Icon name="magnifying-glass" size="large" />
                        </div>
                        <strong>没有匹配的插件</strong>
                        <span>试试别的关键词，或者清除筛选条件。</span>
                        <ui.Button
                          variant="ghost"
                          size="small"
                          onClick={() => {
                            setFilter("")
                            setTypeFilter("all")
                            setLimit(PAGE)
                          }}
                        >
                          清除筛选
                        </ui.Button>
                      </div>
                    }
                  >
                    <div class="ph-empty">
                      <div class="ph-empty-icon">
                        <ui.Icon name="circle-exclamation" size="large" />
                      </div>
                      <strong>插件目录没能加载</strong>
                      <span>{meta()!.error}</span>
                      <ui.Button
                        variant="ghost"
                        size="small"
                        busy={isBusy("catalog")}
                        onClick={() => void loadCatalog(true)}
                      >
                        重新加载
                      </ui.Button>
                    </div>
                  </Show>
                }
              >
                <div class="ph-list">
                  <For each={visible().slice(0, limit())}>{(entry) => catalogRow(entry)}</For>
                </div>
                <Show when={visible().length > limit()}>
                  <div class="ph-more">
                    <ui.Button variant="ghost" size="small" onClick={() => setLimit((n) => n + PAGE)}>
                      显示更多（还有 {visible().length - limit()} 个）
                    </ui.Button>
                  </div>
                </Show>
              </Show>
            </Show>
          </section>
        </Match>

        <Match when={tab() === "search"}>
          <section class="ph-panel" role="tabpanel" id="ph-tabpanel" aria-labelledby={`ph-tab-${tab()}`}>
            <div class="ph-searchbar">
              <div class="ph-grow">
                <ui.TextInput
                  label="搜索 npm 上的 OpenCode 插件"
                  placeholder="搜索插件，例如 qoder / notify / usage（输入后自动搜索）"
                  type="search"
                  value={query()}
                  onInput={scheduleSearch}
                  onSubmit={(value) => {
                    if (searchTimer) window.clearTimeout(searchTimer)
                    lastSearch = value.trim()
                    void runSearch(value)
                  }}
                />
              </div>
              <ui.Button
                variant="contrast"
                icon="magnifying-glass"
                busy={isBusy("search")}
                onClick={() => void runSearch(query())}
              >
                搜索
              </ui.Button>
            </div>

            <div class="ph-meta">
              <span>按 opencode-plugin 搜索 npm，覆盖精选目录之外的长尾；结果未经人工筛选。</span>
            </div>

            <Show when={!searched()}>
              <div class="ph-empty">
                <div class="ph-empty-icon">
                  <ui.Icon name="magnifying-glass" size="large" />
                </div>
                <strong>搜索 npm 上的 OpenCode 插件</strong>
                <span>按名称或用途搜索，例如 auth、notify、memory。点开任意结果可以看 README、下载量和主页。</span>
                <div class="ph-chips">
                  <For each={SUGGESTIONS}>
                    {(text) => (
                      <button class="ph-chip" onClick={() => void runSearch(text)}>
                        {text}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={searched()}>
              <div class="ph-resultbar">
                <div class="ph-resultline">
                  <Show when={resultQuery()} fallback={<span>搜索结果</span>}>
                    <span>
                      “<strong>{resultQuery()}</strong>” 的结果
                    </span>
                  </Show>
                  <span>
                    · 共 <strong>{sortedHits().length}</strong> 个
                  </span>
                  <Show when={searchInstalledCount() > 0}>
                    <span>· {searchInstalledCount()} 个已安装</span>
                  </Show>
                  <Show when={searchUpdateCount() > 0}>
                    <span>· {searchUpdateCount()} 个可更新</span>
                  </Show>
                </div>
                <div class="ph-sort">
                  <For each={SORTS}>
                    {(item) => (
                      <button data-active={sort() === item.value} onClick={() => setSort(item.value)}>
                        {item.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <Show when={isBusy("search") && hits().length === 0}>
                <div class="ph-list">
                  <For each={[0, 1, 2, 3]}>{() => <div class="ph-skeleton" />}</For>
                </div>
              </Show>

              <Show when={!isBusy("search") || hits().length > 0}>
                <Show
                  when={sortedHits().length > 0}
                  fallback={
                    <Show
                      when={searchError()}
                      fallback={
                        <div class="ph-empty">
                          <div class="ph-empty-icon">
                            <ui.Icon name="magnifying-glass" size="large" />
                          </div>
                          <strong>没有找到匹配的插件</strong>
                          <span>换个关键词试试，或者清空搜索查看建议。</span>
                        </div>
                      }
                    >
                      <div class="ph-empty">
                        <div class="ph-empty-icon">
                          <ui.Icon name="circle-exclamation" size="large" />
                        </div>
                        <strong>搜索没有完成</strong>
                        <span>{searchError()}</span>
                        <ui.Button
                          variant="ghost"
                          size="small"
                          busy={isBusy("search")}
                          onClick={() => void runSearch(resultQuery() || query())}
                        >
                          重试
                        </ui.Button>
                      </div>
                    </Show>
                  }
                >
                  <div class="ph-list">
                    <For each={visibleHits()}>{(hit) => searchRow(hit)}</For>
                  </div>
                  <Show when={sortedHits().length > visibleHits().length}>
                    <div class="ph-more">
                      <ui.Button
                        variant="ghost"
                        size="small"
                        onClick={() => setHitLimit((n) => n + 12)}
                      >
                        显示更多（还有 {sortedHits().length - visibleHits().length} 个）
                      </ui.Button>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </section>
        </Match>

        <Match when={tab() === "installed"}>
          <section class="ph-panel" role="tabpanel" id="ph-tabpanel" aria-labelledby={`ph-tab-${tab()}`}>
            <Show when={attentionItems().length > 0}>
              <div class="ph-attention">
                <span class="ph-attention-lead">
                  <ui.Icon name="circle-exclamation" size="small" />
                  需要关注
                </span>
                <div class="ph-attention-items">
                  <For each={attentionItems()}>
                    {(item) => (
                      <button
                        class="ph-attention-chip"
                        data-tone={item.tone}
                        onClick={() => setInstalledFilter(item.id)}
                      >
                        {item.count} {item.label}
                      </button>
                    )}
                  </For>
                </div>
                <span class="ph-attention-hint">点击按状态筛选</span>
              </div>
            </Show>

            <div class="ph-installed-bar">
              <div class="ph-installed-search">
                <ui.TextInput
                  label="搜索已安装插件"
                  placeholder="搜索名称、来源或描述"
                  type="search"
                  value={installedQuery()}
                  onInput={setInstalledQuery}
                />
              </div>
              <div class="ph-chips">
                {installedFilterButton("all", "全部")}
                {installedFilterButton("update", "可更新")}
                {installedFilterButton("paused", "已暂停")}
                {installedFilterButton("failed", "加载失败")}
                {installedFilterButton("pending", "待加载")}
                {installedFilterButton("unknown", "未验证")}
              </div>
              <Show when={installedQuery() !== "" || installedFilter() !== "all"}>
                <button
                  class="ph-clear"
                  onClick={() => {
                    setInstalledFilter("all")
                    setInstalledQuery("")
                  }}
                >
                  清除筛选
                </button>
              </Show>
            </div>

            <div class="ph-resultline">
              <span>
                显示 <strong>{visiblePlugins().length}</strong> / {state()?.plugins.length ?? 0} 个
              </span>
              <Show when={checked()}>
                <span>
                  ·{" "}
                  {uncheckedCount() > 0
                    ? `已检查 ${Math.max(0, (state()?.plugins.length ?? 0) - uncheckedCount())} 个，${uncheckedCount()} 个未能检查${outdated() > 0 ? `，${outdated()} 个可更新` : ""}`
                    : outdated() > 0
                      ? `检查过 npm registry，${outdated()} 个可更新`
                      : "检查过 npm registry，已检查的插件均为最新"}
                </span>
              </Show>
              <span class="ph-spacer" />
              <span title="同级条目保持配置里的原始顺序">按严重程度排序</span>
            </div>

            <Show
              when={(state()?.plugins.length ?? 0) > 0}
              fallback={
                <div class="ph-empty">
                  <div class="ph-empty-icon">
                    <ui.Icon name="extensions" size="large" />
                  </div>
                  <strong>还没有安装插件</strong>
                  <span>去「精选目录」看看 awesome-opencode 的推荐，或者在「npm 搜索」里找长尾插件。</span>
                </div>
              }
            >
              <Show
                when={visiblePlugins().length > 0}
                fallback={
                  <div class="ph-empty">
                    <div class="ph-empty-icon">
                      <ui.Icon name={installedQuery().trim() ? "magnifying-glass" : "checklist"} size="large" />
                    </div>
                    <Show
                      when={installedQuery().trim()}
                      fallback={
                        <>
                          <strong>当前筛选下没有插件</strong>
                          <span>已安装的插件没有符合这个状态的条目。可以切回「全部」，或点「检查更新」刷新状态。</span>
                        </>
                      }
                    >
                      <strong>没有匹配“{installedQuery().trim()}”的插件</strong>
                      <span>已安装插件的名称、来源和描述里都没有这个关键词。</span>
                    </Show>
                    <ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() => {
                        setInstalledFilter("all")
                        setInstalledQuery("")
                      }}
                    >
                      清除筛选
                    </ui.Button>
                  </div>
                }
              >
                <div class="ph-list">
                  <For each={visiblePlugins()}>{(entry) => installedRow(entry)}</For>
                </div>
                {/* 运行时里存在、但全局配置没列出的插件：来自发现目录或项目配置，只做告知。 */}
                <Show when={discovered().length > 0}>
                  <div
                    class="ph-meta"
                    title={discovered()
                      .map((item) => `${item.id || "(无 ID)"} ${item.version || ""} ${item.source}`)
                      .join("\n")}
                  >
                    <ui.Icon name="info" size="small" />
                    运行时还报告了 {discovered().length} 个不在全局配置里的插件（发现目录或项目配置）：
                    {discovered()
                      .slice(0, 4)
                      .map((item) => item.id || item.source)
                      .join("、")}
                    {discovered().length > 4 ? " …" : ""}。它们不在这里管理。
                  </div>
                </Show>
              </Show>
            </Show>
          </section>
        </Match>
      </Switch>

      <footer class="ph-footer">
        <div class="ph-footer-note">
          安装、更新、移除都走官方 CLI（<code>opencode plugin add/update/remove</code>），暂停与恢复只改全局配置里的规则：暂停写入 <code>-&lt;插件ID&gt;</code>，恢复删掉这条精确规则、必要时追加裸 ID 启用规则。生效由 OpenCode 负责（受监控的配置会自动重载，也可点「重载配置」）。插件中心不重启宿主、不删除本地目录、不把「配置写入成功」当作「已经加载」。
        </div>
      </footer>
    </div>
  )
}

/** The standalone x-large dialog opened from the titlebar pill and the ⌘⌥P shortcut. */
export function PluginHubDialog(props: { ctx: Context; admin: AdminClient; onClose: () => void }) {
  const ui = props.ctx.ui
  const openSettings = () => {
    props.onClose()
    // Let the dialog unmount before the host swaps in the Settings view.
    setTimeout(() => props.ctx.layout.settings("hub"), 0)
  }
  return (
    <ui.Dialog
      title="插件中心"
      size="x-large"
      footer={
        <div class="ph-dialog-footer">
          <span class="ph-footer-note">拖动右下角可调整大小</span>
          <ui.Button size="small" variant="ghost" icon="settings-gear" onClick={openSettings}>
            在设置中打开
          </ui.Button>
          <ui.Button size="small" onClick={props.onClose}>关闭</ui.Button>
        </div>
      }
    >
      <PluginHubPage ctx={props.ctx} admin={props.admin} embedded />
    </ui.Dialog>
  )
}
