import { createMemo, createSignal, For, onMount, Show, Switch, Match } from "solid-js"
import type { Context, IconName, IpcClient } from "@opencode/plugin/gui"
import type { Admin } from "../contract"

type AdminClient = IpcClient<typeof Admin.spec>
type HubState = Awaited<ReturnType<AdminClient["snapshot"]>>
type PluginEntry = HubState["plugins"][number]
type SearchHit = Awaited<ReturnType<AdminClient["search"]>>["hits"][number]
type CatalogEntry = Awaited<ReturnType<AdminClient["browse"]>>["entries"][number]
type CatalogResult = Awaited<ReturnType<AdminClient["browse"]>>
type UpdateInfo = Awaited<ReturnType<AdminClient["updates"]>>["items"][number]
type PackageDetail = Awaited<ReturnType<AdminClient["detail"]>>

type Tab = "catalog" | "search" | "installed"
type Tone = "info" | "success" | "warning" | "error"
type Note = { text: string; tone: Tone }

const PAGE = 24

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

const COMPACT = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 })

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  return COMPACT.format(value)
}

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
    return "插件窗口与后台服务版本不一致。点工具栏的「彻底重启」让两边换成同一版本。"
  }
  if (/unknown method|not implemented|no such method|method.*not.*found/i.test(text)) {
    return "后台服务还是旧版本，暂时没有「彻底重启」能力。请先手动完全退出 OpenCode（并结束 serve --service）再打开一次。"
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

const CSS = `
:root {
  --ph-strong: var(--color-v2-text-text-contrast, var(--color-text-strong, currentColor));
  --ph-muted: var(--color-v2-text-text-muted, var(--color-text-weak, color-mix(in srgb, currentColor 58%, transparent)));
  --ph-faint: var(--color-v2-text-text-faint, color-mix(in srgb, currentColor 42%, transparent));
  --ph-border: var(--color-v2-border-border-base, var(--color-border-weak-base, color-mix(in srgb, currentColor 12%, transparent)));
  --ph-border-strong: var(--color-v2-border-border-strong, color-mix(in srgb, currentColor 24%, transparent));
  --ph-layer: var(--color-v2-background-bg-layer-01, var(--color-surface-base, color-mix(in srgb, currentColor 3%, transparent)));
  --ph-layer-2: var(--color-v2-background-bg-layer-02, var(--color-surface-raised-base, color-mix(in srgb, currentColor 6%, transparent)));
  --ph-layer-3: var(--color-v2-background-bg-layer-03, color-mix(in srgb, currentColor 10%, transparent));
  --ph-accent: var(--color-v2-text-text-accent, var(--color-text-interactive-base, var(--color-blue-primary, #4f8cff)));
  --ph-success: var(--color-v2-state-fg-success, var(--color-green, #2f9e5f));
  --ph-danger: var(--color-v2-state-fg-danger, var(--color-red, #d9534f));
  --ph-warning: var(--color-v2-state-fg-warning, var(--color-orange, #c98a16));
  --ph-hover: var(--color-v2-overlay-simple-overlay-hover, color-mix(in srgb, currentColor 6%, transparent));
}
.ph-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 920px;
  padding: 4px 0 40px;
  color: var(--color-v2-text-text-base, var(--color-text-base, inherit));
}
.ph-root *, .ph-detail * { box-sizing: border-box; }
.ph-spacer { flex: 1; }

/* hero */
.ph-hero {
  display: flex;
  gap: 22px;
  justify-content: space-between;
  align-items: stretch;
  padding: 20px 22px;
  border: 1px solid var(--ph-border);
  border-radius: 14px;
  background:
    radial-gradient(120% 160% at 0% 0%, color-mix(in srgb, var(--ph-accent) 13%, transparent) 0%, transparent 52%),
    var(--ph-layer);
}
.ph-hero-copy { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 0; }
.ph-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--ph-accent);
}
.ph-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--ph-strong);
}
.ph-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ph-muted);
  max-width: 72ch;
}
.ph-inline-source {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ph-accent);
  font: inherit;
  line-height: inherit;
  cursor: pointer;
}
.ph-inline-source:hover { text-decoration: underline; }
.ph-inline-source:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ph-accent) 55%, transparent);
  outline-offset: 2px;
  border-radius: 2px;
}
.ph-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.ph-path code {
  font-size: 10.5px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--ph-layer-2);
}

/* notice */
.ph-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ph-border);
  border-radius: 10px;
  background: var(--ph-layer);
  color: var(--ph-muted);
  font-size: 12px;
  line-height: 1.55;
}
.ph-notice[data-tone="error"] {
  color: var(--ph-danger);
  border-color: color-mix(in srgb, var(--ph-danger) 28%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 7%, transparent);
}
.ph-notice[data-tone="success"] {
  color: var(--ph-success);
  border-color: color-mix(in srgb, var(--ph-success) 28%, transparent);
  background: color-mix(in srgb, var(--ph-success) 7%, transparent);
}
.ph-notice[data-tone="warning"] {
  color: var(--ph-warning);
  border-color: color-mix(in srgb, var(--ph-warning) 28%, transparent);
  background: color-mix(in srgb, var(--ph-warning) 7%, transparent);
}
.ph-notice span { flex: 1; min-width: 0; }

/* toolbar and tabs */
.ph-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ph-tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--ph-border);
  border-radius: 10px;
  background: var(--ph-layer);
}
.ph-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ph-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ph-tab:hover { color: var(--ph-strong); background: var(--ph-hover); }
.ph-tab[data-active="true"] {
  color: var(--ph-strong);
  background: var(--ph-layer-3);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.ph-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 99px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: var(--ph-muted);
  font-size: 9.5px;
  font-weight: 600;
}
.ph-count-alert {
  background: color-mix(in srgb, var(--ph-accent) 14%, transparent);
  color: var(--ph-accent);
  white-space: nowrap;
}
.ph-tab[data-active="true"] .ph-count {
  background: color-mix(in srgb, var(--ph-accent) 16%, transparent);
  color: var(--ph-accent);
}

/* panels, filters */
.ph-panel { display: flex; flex-direction: column; gap: 12px; }
.ph-filters { display: flex; flex-direction: column; gap: 10px; }
.ph-filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ph-grow { flex: 1; min-width: 220px; }
.ph-searchbar { display: flex; align-items: flex-end; gap: 8px; }
.ph-searchbar .ph-grow { min-width: 200px; }
.ph-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--ph-muted);
  line-height: 1.5;
}
.ph-meta > span { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.ph-dot { flex: 0 0 auto; width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.4; }
.ph-resultbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ph-h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ph-muted);
}
.ph-sort {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ph-border);
  border-radius: 8px;
  background: var(--ph-layer);
}
.ph-sort button {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ph-muted);
  font-family: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ph-sort button:hover { color: var(--ph-strong); background: var(--ph-hover); }
.ph-sort button[data-active="true"] {
  color: var(--ph-accent);
  background: color-mix(in srgb, var(--ph-accent) 11%, transparent);
}

/* cards */
.ph-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 10px;
  align-items: stretch;
}
.ph-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--ph-border);
  border-radius: 12px;
  background: var(--ph-layer);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.ph-card:hover {
  border-color: var(--ph-border-strong);
  background: var(--ph-layer-2);
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.05);
}
/* Highlight cards whose plugin has a pending update. */
.ph-card[data-stale="true"] {
  border-color: color-mix(in srgb, var(--ph-accent) 36%, transparent);
  background: color-mix(in srgb, var(--ph-accent) 5%, transparent);
}
/* While an install or update runs, pulse and sweep the card. */
.ph-card[data-busy="true"] {
  border-color: color-mix(in srgb, var(--ph-accent) 45%, transparent);
  animation: ph-busy-pulse 1.1s ease-in-out infinite;
}
.ph-card[data-busy="true"]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    100deg,
    transparent 32%,
    color-mix(in srgb, var(--ph-accent) 12%, transparent) 50%,
    transparent 68%
  );
  background-size: 220% 100%;
  animation: ph-shimmer 1.1s linear infinite;
  pointer-events: none;
}
@keyframes ph-busy-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ph-accent) 20%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--ph-accent) 8%, transparent);
  }
}
.ph-card-main { display: flex; flex: 1; flex-direction: column; gap: 8px; min-width: 0; }
.ph-card-body { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 0; }
.ph-card-body[role="button"] { cursor: pointer; border-radius: 6px; }
.ph-card-head { display: flex; align-items: flex-start; gap: 9px; }
.ph-card-titles { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.ph-tile {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid color-mix(in srgb, var(--ph-accent) 20%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ph-accent) 10%, transparent);
  color: var(--ph-accent);
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
}
.ph-name-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ph-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ph-strong);
  overflow-wrap: anywhere;
}
.ph-pkg {
  font-size: 10.5px;
  color: var(--ph-faint);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow-wrap: anywhere;
}
.ph-version { font-size: 10.5px; font-weight: 400; color: var(--ph-muted); }
.ph-version-arrow { color: var(--ph-accent); }
.ph-desc { font-size: 12px; line-height: 1.55; color: var(--ph-muted); }
.ph-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ph-type {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ph-faint);
}
.ph-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--ph-border);
}

/* badges and chips */
.ph-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border: 1px solid var(--ph-border);
  border-radius: 99px;
  background: var(--ph-layer-2);
  color: var(--ph-muted);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}
.ph-badge[data-tone="accent"] {
  color: var(--ph-accent);
  border-color: color-mix(in srgb, var(--ph-accent) 30%, transparent);
  background: color-mix(in srgb, var(--ph-accent) 9%, transparent);
}
.ph-badge[data-tone="success"] {
  color: var(--ph-success);
  border-color: color-mix(in srgb, var(--ph-success) 30%, transparent);
  background: color-mix(in srgb, var(--ph-success) 9%, transparent);
}
.ph-badge[data-tone="warning"] {
  color: var(--ph-warning);
  border-color: color-mix(in srgb, var(--ph-warning) 30%, transparent);
  background: color-mix(in srgb, var(--ph-warning) 9%, transparent);
}
.ph-badge[data-tone="danger"] {
  color: var(--ph-danger);
  border-color: color-mix(in srgb, var(--ph-danger) 30%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 9%, transparent);
}
.ph-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ph-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--ph-border);
  border-radius: 99px;
  background: var(--ph-layer-2);
  color: var(--ph-muted);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 1.5;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
button.ph-chip { cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s; }
button.ph-chip:hover { color: var(--ph-strong); border-color: var(--ph-border-strong); }
button.ph-chip[data-active="true"] {
  color: var(--ph-accent);
  border-color: color-mix(in srgb, var(--ph-accent) 32%, transparent);
  background: color-mix(in srgb, var(--ph-accent) 10%, transparent);
}
.ph-chip[data-disabled="true"] { opacity: 0.45; cursor: default; }
.ph-chip-count { font-size: 9px; opacity: 0.7; }

/* empty and loading */
.ph-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 38px 18px;
  border: 1px dashed var(--ph-border);
  border-radius: 12px;
  color: var(--ph-muted);
  text-align: center;
}
.ph-empty strong { font-size: 13px; font-weight: 600; color: var(--ph-strong); }
.ph-empty span { font-size: 12px; line-height: 1.55; max-width: 48ch; }
.ph-empty .ph-chips { justify-content: center; margin-top: 2px; }
.ph-skeleton {
  height: 70px;
  border: 1px solid var(--ph-border);
  border-radius: 12px;
  background: linear-gradient(90deg, var(--ph-layer) 0%, var(--ph-layer-2) 50%, var(--ph-layer) 100%);
  background-size: 200% 100%;
  animation: ph-shimmer 1.4s ease-in-out infinite;
}
@keyframes ph-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* detail dialog */
.ph-detail { display: flex; flex-direction: column; gap: 14px; }
.ph-detail-head { display: flex; flex-direction: column; gap: 5px; }
.ph-detail-title { font-size: 16px; font-weight: 650; color: var(--ph-strong); overflow-wrap: anywhere; }
.ph-detail-desc { font-size: 12.5px; line-height: 1.6; color: var(--ph-muted); }
.ph-detail-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ph-detail-stat {
  padding: 9px 10px;
  border: 1px solid var(--ph-border);
  border-radius: 10px;
  background: var(--ph-layer);
}
.ph-detail-stat b { display: block; font-size: 15px; font-weight: 650; line-height: 1.25; color: var(--ph-strong); }
.ph-detail-stat span { display: block; margin-top: 1px; font-size: 10px; color: var(--ph-muted); }
.ph-detail-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ph-detail-links { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ph-dialog-footer { display: flex; align-items: center; gap: 6px; width: 100%; flex-wrap: wrap; }
.ph-detail-error {
  max-width: 34ch;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--ph-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-detail-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 220px;
  font-size: 12px;
  color: var(--ph-muted);
}
.ph-warning {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--ph-warning) 28%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ph-warning) 7%, transparent);
  color: var(--ph-warning);
  font-size: 11.5px;
  line-height: 1.5;
}
.ph-warning[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--ph-danger) 28%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 7%, transparent);
  color: var(--ph-danger);
}
.ph-section { display: flex; flex-direction: column; gap: 8px; }
.ph-section-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ph-faint);
}
.ph-details {
  padding: 8px 10px;
  border: 1px solid var(--ph-border);
  border-radius: 10px;
  background: var(--ph-layer);
}
.ph-details summary { cursor: pointer; font-size: 11.5px; color: var(--ph-muted); }
.ph-details .ph-chips { margin-top: 8px; }
.ph-readme { font-size: 12.5px; line-height: 1.65; }
.ph-readme img { max-width: 100%; height: auto; }
.ph-readme pre { overflow: auto; }
.ph-readme table { display: block; max-width: 100%; overflow: auto; }
.ph-readme-empty {
  padding: 16px;
  border: 1px dashed var(--ph-border);
  border-radius: 10px;
  color: var(--ph-muted);
  font-size: 12px;
  line-height: 1.55;
}
.ph-readme-note { font-size: 10.5px; color: var(--ph-faint); }

.ph-tab:focus-visible,
.ph-sort button:focus-visible,
button.ph-chip:focus-visible,
.ph-card-body[role="button"]:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ph-accent) 55%, transparent);
  outline-offset: 2px;
}

/* embedded in the standalone dialog */
.ph-root[data-embedded="true"] {
  max-width: none;
  padding: 0 0 8px;
}
/* The host caps "x-large" at 980x600. Give the standalone hub more room and
   let the dialog be resized from its bottom-right corner, within the window. */
[data-component="dialog-v2"][data-size="x-large"]:has(.ph-root[data-embedded="true"]) [data-slot="dialog-container"] {
  width: min(100vw - 48px, 1180px);
  height: min(100vh - 88px, 780px);
  min-width: min(100vw - 48px, 720px);
  min-height: min(100vh - 88px, 480px);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  resize: both;
}
[data-component="dialog-v2"][data-size="x-large"]:has(.ph-detail) [data-slot="dialog-container"] {
  width: min(100vw - 48px, 1180px);
  height: min(100vh - 88px, 780px);
  min-width: min(100vw - 48px, 720px);
  min-height: min(100vh - 88px, 480px);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  resize: both;
}
/* Notices and the toolbar share one sticky head, so a note raised after an
   action (e.g. updating a plugin near the bottom of the list) is always on
   screen instead of appearing far above the current scroll position. */
.ph-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 6px 0;
  margin: -6px 0;
  background: color-mix(in srgb, var(--color-v2-background-bg-base, Canvas) 92%, transparent);
  backdrop-filter: blur(8px);
}

/* footer */
.ph-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--ph-border);
}
.ph-footer-note { flex: 1; font-size: 11px; line-height: 1.55; color: var(--ph-muted); }

@media (max-width: 760px) {
  .ph-hero { flex-direction: column; }
  .ph-list { grid-template-columns: 1fr; }
  .ph-detail-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`

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
  const description = () => data()?.description || props.fallback?.description || ""
  const homepage = () => data()?.homepage || props.fallback?.homepage || ""
  const repo = () => data()?.repo || props.fallback?.repo || ""
  const npm = () => data()?.npm || props.fallback?.npm || `https://www.npmjs.com/package/${props.name}`
  const canInstall = () => !loading() && data() !== undefined && !failure() && (data()?.version ?? "") !== ""
  const update = () => data()?.hasUpdate === true
  const installed = () => data()?.installed === true

  return (
    <ui.Dialog
      title={props.name}
      size="x-large"
      footer={
        <div class="ph-dialog-footer">
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
          <span class="ph-spacer" />
          <Show when={failure()}>
            <span class="ph-detail-error" title={failure()}>
              {failure()}
            </span>
          </Show>
          <ui.Button size="small" onClick={props.onClose}>
            关闭
          </ui.Button>
          <Show when={canInstall()}>
            <Show
              when={update() || !installed()}
              fallback={
                <ui.Button size="small" disabled>
                  已安装
                </ui.Button>
              }
            >
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
          </Show>
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
            <div class="ph-name-row">
              <Show when={version()}>
                <span class="ph-badge" data-tone="accent">
                  v{version()}
                </span>
              </Show>
              <Show when={installed()}>
                <span class="ph-badge" data-tone="success">
                  已安装{data()!.current ? ` v${data()!.current}` : ""}
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

          <Show when={data()!.version}>
            <div class="ph-detail-stats">
              <div class="ph-detail-stat">
                <b title={`${data()!.weekly.toLocaleString()} 次`}>{formatCount(data()!.weekly)}</b>
                <span>周下载</span>
              </div>
              <div class="ph-detail-stat">
                <b title={`${data()!.monthly.toLocaleString()} 次`}>{formatCount(data()!.monthly)}</b>
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

          <div class="ph-detail-meta">
            <Show when={data()!.license}>
              <span class="ph-chip">许可证 {data()!.license}</span>
            </Show>
            <Show when={data()!.published}>
              <span class="ph-chip">发布于 {relativeDate(data()!.published)}</span>
            </Show>
            <Show when={data()!.created}>
              <span class="ph-chip">首次发布 {relativeDate(data()!.created)}</span>
            </Show>
            <Show when={data()!.maintainers.length > 0}>
              <span class="ph-chip">维护者 {data()!.maintainers.join(", ")}</span>
            </Show>
          </div>

          <Show when={data()!.keywords.length > 0}>
            <div class="ph-chips">
              <For each={data()!.keywords}>{(keyword) => <span class="ph-chip">{keyword}</span>}</For>
            </div>
          </Show>

          <Show when={data()!.bugs}>
            <div class="ph-detail-links">
              <ui.Button
                size="small"
                variant="ghost-muted"
                icon="bubble-5"
                onClick={() => open(data()!.bugs)}
              >
                问题反馈
              </ui.Button>
            </div>
          </Show>

          <Show when={data()!.dependencies.length > 0}>
            <details class="ph-details">
              <summary>依赖 {data()!.dependencies.length} 个</summary>
              <div class="ph-chips">
                <For each={data()!.dependencies}>{(dep) => <span class="ph-chip">{dep}</span>}</For>
              </div>
            </details>
          </Show>

          <section class="ph-section">
            <div class="ph-section-title">README</div>
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
  const [sort, setSort] = createSignal<Sort>("relevance")

  const [updates, setUpdates] = createSignal<Map<string, UpdateInfo>>(new Map())
  const [checked, setChecked] = createSignal(false)
  const [staleOnly, setStaleOnly] = createSignal(false)

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
  const track = async <T,>(key: string, task: () => Promise<T>): Promise<T> => {
    begin(key)
    try {
      return await task()
    } finally {
      end(key)
    }
  }
  const notify = (text: string, tone: Tone = "info") => setNote(text ? { text, tone } : undefined)

  const refresh = async () => {
    try {
      setState(await props.admin.snapshot())
    } catch (error) {
      notify(readableError(error), "error")
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
        setChecked(true)
        if (silent) return
        const stale = result.items.filter((item) => item.hasUpdate).length
        const failed = result.items.filter((item) => item.error).length
        // Never report "up to date" for packages the registry could not be asked about.
        const message = result.error
          ? result.error
          : failed > 0
            ? `${failed} 个插件未能检查（registry 连接失败），其余${stale > 0 ? `有 ${stale} 个可更新` : "已是最新"}`
            : stale > 0
              ? `发现 ${stale} 个可更新的插件`
              : "全部已是最新版本"
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
        if (result.error) notify(result.error, "error")
        // Keep the installed view in sync with what the catalog just reported.
        await refresh()
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const runSearch = async (text: string) => {
    setQuery(text)
    await track("search", async () => {
      try {
        const result = await props.admin.search({ query: text })
        setHits(result.hits)
        setSearched(true)
        if (result.error) notify(result.error, "error")
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const install = async (name: string, version = "") => {
    await track(`install:${name}`, async () => {
      try {
        const result = await props.admin.install({ spec: name, version })
        setState(result.state)
        if (!result.ok) {
          notify(result.message, "error")
          return
        }
        notify(`${result.message}。点工具栏的「彻底重启」后生效`, "success")
        const latest = version || hits().find((hit) => hit.name === name)?.version || ""
        setCatalog((prev) => prev.map((entry) => (entry.pkg === name ? { ...entry, installed: true } : entry)))
        setHits((prev) =>
          prev.map((hit) =>
            hit.name === name ? { ...hit, installed: true, current: latest, hasUpdate: false } : hit,
          ),
        )
        await checkUpdates(true)
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  const uninstall = async (entry: PluginEntry) => {
    const ok = await props.ctx.dialogs.confirm({
      title: `移除 ${entry.name}？`,
      description: "只从 opencode.json 里删掉这一项，已安装的文件不会删除。",
      confirm: "移除",
      danger: true,
    })
    if (!ok) return
    await track(`install:${entry.name}`, async () => {
      try {
        const result = await props.admin.remove({ spec: entry.spec, version: "" })
        setState(result.state)
        if (!result.ok) {
          notify(result.message, "error")
          return
        }
        notify(`${result.message}。点工具栏的「彻底重启」后生效`, "success")
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
      } catch (error) {
        notify(readableError(error), "error")
      }
    })
  }

  /** Quits the app, clears a stale service and opens the app again. The session is restored by OpenCode. */
  const restartApp = async () => {
    const ok = await props.ctx.dialogs.confirm({
      title: "彻底重启 OpenCode？",
      description:
        "应用会退出并自动重新打开，让插件代码和后台 serve --service 一起换成最新版本。当前会话通常会自动恢复。",
      confirm: "重启",
    })
    if (!ok) return
    await track("restart", async () => {
      try {
        const result = await props.admin.restart()
        if (!result.ok) {
          notify("无法自动重启，请手动完全退出 OpenCode 再打开。", "error")
          return
        }
        notify("正在重启 OpenCode…如果没有自动打开，请手动启动。", "info")
      } catch {
        notify(
          "自动重启调用失败，后台服务可能还是旧版本。请先手动完全退出 OpenCode（并结束 serve --service）再打开一次。",
          "error",
        )
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
    if (sort() === "downloads") list.sort((a, b) => b.weekly - a.weekly)
    else if (sort() === "recent") list.sort((a, b) => (b.published || "").localeCompare(a.published || ""))
    return list
  })

  const registryUrl = () => meta()?.registry || CATALOG_SOURCE_FALLBACK
  const outdated = createMemo(() => [...updates().values()].filter((item) => item.hasUpdate).length)
  const visiblePlugins = createMemo(() => {
    const plugins = state()?.plugins ?? []
    if (!staleOnly()) return plugins
    return plugins.filter((entry) => updates().get(entry.spec)?.hasUpdate === true)
  })
  const bySpec = (spec: string) => updates().get(spec)
  const byPackage = createMemo(() => {
    const map = new Map<string, UpdateInfo>()
    for (const item of updates().values()) map.set(item.name, item)
    return map
  })

  const switchTab = (next: Tab) => {
    setTab(next)
    // Leaving the installed view resets its "updatable only" filter.
    if (next !== "installed") setStaleOnly(false)
    // The first look at the installed list also checks the registry, once.
    if (next !== "catalog" && !checked() && !isBusy("updates")) void checkUpdates(true)
  }

  onMount(() => {
    void refresh()
    void loadCatalog(false)
    void checkUpdates(true)
  })

  const tabButton = (id: Tab, label: string, icon: IconName, count?: number | string, alert?: number) => (
    <button class="ph-tab" data-active={tab() === id} onClick={() => switchTab(id)}>
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
                <span class="ph-name">{entry.name}</span>
              </div>
              <Show when={entry.pkg}>
                <span class="ph-pkg">{entry.pkg}</span>
              </Show>
            </div>
            <div class="ph-chips">
              <Show when={entry.installed}>
                <span class="ph-badge" data-tone="success">
                  已安装
                </span>
              </Show>
              <Show when={stale()}>
                <span class="ph-badge" data-tone="accent">
                  可更新 → v{info()!.latest}
                </span>
              </Show>
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
              <Show when={entry.version}>
                <span class="ph-dot" />
                <span>v{entry.version}</span>
              </Show>
              <Show when={!entry.pkg}>
                <span class="ph-dot" />
                <span>仅 GitHub 发布</span>
              </Show>
              <Show when={entry.tags.length > 0}>
                <span class="ph-dot" />
                <span>{entry.tags.slice(0, 4).join(" / ")}</span>
              </Show>
            </div>
          </div>
        </div>
        <div class="ph-actions">
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
          <Show when={stale()}>
            <ui.Button
              variant="ghost"
              size="small"
              icon="download"
              busy={busy()}
              onClick={() => void install(entry.pkg, info()!.latest)}
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
          <Show when={!stale() && !entry.installed && !entry.pkg}>
            <span class="ph-badge">需手动</span>
          </Show>
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
      <article class="ph-card" data-busy={isBusy(`install:${hit.name}`) ? "true" : undefined}>
        <div class="ph-card-main">
          <div class="ph-card-head">
            <div class="ph-tile">{initial(hit.name)}</div>
            <div class="ph-card-titles">
              <div class="ph-name-row">
                <span class="ph-name">{hit.name}</span>
              </div>
              <span class="ph-pkg">v{hit.version}</span>
            </div>
            <div class="ph-chips">
              <Show when={hit.installed}>
                <span class="ph-badge" data-tone="success">
                  已安装{hit.current ? ` v${hit.current}` : ""}
                </span>
              </Show>
              <Show when={hit.hasUpdate}>
                <span class="ph-badge" data-tone="accent">
                  可更新 → v{hit.version}
                </span>
              </Show>
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
              <span title={`周下载 ${hit.weekly.toLocaleString()} 次`}>
                <ui.Icon name="download" size="small" />
                {formatCount(hit.weekly)}/周
              </span>
              <span class="ph-dot" />
              <span title={`月下载 ${hit.monthly.toLocaleString()} 次`}>{formatCount(hit.monthly)}/月</span>
              <Show when={hit.publisher}>
                <span class="ph-dot" />
                <span>by {hit.publisher}</span>
              </Show>
              <Show when={hit.published}>
                <span class="ph-dot" />
                <span>{relativeDate(hit.published)}更新</span>
              </Show>
            </div>
            <Show when={hit.keywords.length > 0}>
              <div class="ph-chips">
                <For each={hit.keywords.slice(0, 3)}>{(keyword) => <span class="ph-chip">{keyword}</span>}</For>
              </div>
            </Show>
          </div>
        </div>
        <div class="ph-actions">
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
          <Show when={hit.hasUpdate}>
            <ui.Button
              variant="ghost"
              size="small"
              icon="download"
              busy={isBusy(`install:${hit.name}`)}
              onClick={() => void install(hit.name, hit.version)}
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
      </article>
    )
  }

  const installedRow = (entry: PluginEntry) => {
    const info = () => bySpec(entry.spec)
    const stale = () => info()?.hasUpdate === true
    const busy = () => isBusy(`install:${entry.name}`)
    const current = () => info()?.current || entry.version
    const unchecked = () => (info()?.error ?? "") !== ""
    return (
      <article class="ph-card" data-stale={stale() ? "true" : undefined} data-busy={busy() ? "true" : undefined}>
        <div class="ph-card-main">
          <div class="ph-card-head">
            <div class="ph-tile">{initial(entry.name)}</div>
            <div class="ph-card-titles">
              <div class="ph-name-row">
                <span class="ph-name">{entry.name}</span>
              </div>
              <span class="ph-pkg">{entry.spec}</span>
            </div>
            <div class="ph-chips">
              <Show when={stale()}>
                <span class="ph-badge" data-tone="accent">
                  可更新 → v{info()!.latest}
                </span>
              </Show>
              <Show when={unchecked()}>
                <span class="ph-badge" data-tone="warning">
                  未能检查
                </span>
              </Show>
              <Show when={entry.kind === "path"}>
                <span class="ph-badge">本地目录</span>
              </Show>
            </div>
          </div>
          <div class="ph-card-body">
            <div class="ph-meta">
              {versionLabel(current(), info()?.latest ?? "", stale())}
              <Show when={stale() && entry.kind === "path"}>
                <span class="ph-dot" />
                <span>更新会覆盖目录内容，原文件自动备份</span>
              </Show>
            </div>
          </div>
        </div>
        <div class="ph-actions">
          <Show when={NPM_LIKE.test(entry.name)}>
            <ui.Button
              variant="ghost"
              size="small"
              icon="eye"
              onClick={() => openDetail(entry.name, { version: current() })}
            >
              详情
            </ui.Button>
          </Show>
          <Show when={stale()}>
            <ui.Button
              variant="ghost"
              size="small"
              icon="download"
              busy={busy()}
              onClick={() => void install(info()!.name, info()!.latest)}
            >
              更新
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
      </article>
    )
  }

  return (
    <div class="ph-root" data-embedded={props.embedded ? "true" : undefined}>
      <style>{CSS}</style>

      <section class="ph-hero">
        <div class="ph-hero-copy">
          <div class="ph-kicker">
            <ui.Icon name="extensions" size="small" />
            PLUGIN HUB
          </div>
          <Show when={!props.embedded}>
            <h2 class="ph-title">插件中心</h2>
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
            社区维护的精选目录、搜索 npm 上的 OpenCode 插件。安装前先看下载量、README 和主页，确认它到底能做什么。
          </p>
          <div class="ph-path" title={state()?.configPath}>
            配置：<code>{state()?.configPath ?? "读取中…"}</code> · <code>{state()?.configKey ?? "plugins"}[]</code>
          </div>
        </div>
      </section>

      <div class="ph-head">
        <Show when={note()}>
          <div class="ph-notice" data-tone={note()!.tone}>
            <ui.Icon name={noteIcon(note()!.tone)} size="small" />
            <span>{note()!.text}</span>
          </div>
        </Show>

        <Show when={state()?.error}>
          <div class="ph-notice" data-tone="error">
            <ui.Icon name="circle-exclamation" size="small" />
            <span>{state()!.error}</span>
          </div>
        </Show>

        <div class="ph-toolbar">
        <div class="ph-tabs" role="tablist">
          {tabButton("catalog", "精选目录", "extensions", meta() ? catalog().length : undefined)}
          {tabButton("search", "npm 搜索", "magnifying-glass", searched() ? hits().length : undefined)}
          {tabButton("installed", "已安装", "checklist", state()?.plugins.length ?? 0, outdated())}
        </div>
        <span class="ph-spacer" />
        <ui.Button
          variant="ghost"
          size="small"
          icon="open-file"
          busy={isBusy("config")}
          onClick={() => void openConfig()}
        >
          打开配置
        </ui.Button>
        <ui.Button
          variant="ghost"
          size="small"
          icon="refresh"
          busy={isBusy("reload")}
          onClick={() => void reload()}
        >
          重载配置
        </ui.Button>
        <ui.Button
          variant="neutral"
          size="small"
          icon="outline-rotate-clockwise"
          busy={isBusy("restart")}
          onClick={() => void restartApp()}
        >
          彻底重启
        </ui.Button>
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
                setHits([])
                setSearched(false)
                setQuery("")
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
        </div>
      </div>

      <Switch>
        <Match when={tab() === "catalog"}>
          <section class="ph-panel">
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

            <Show when={isBusy("catalog") && catalog().length === 0}>
              <div class="ph-list">
                <For each={[0, 1, 2, 3]}>{() => <div class="ph-skeleton" />}</For>
              </div>
            </Show>

            <Show when={!isBusy("catalog") || catalog().length > 0}>
              <Show
                when={visible().length > 0}
                fallback={
                  <div class="ph-empty">
                    <ui.Icon name="magnifying-glass" size="large" />
                    <strong>没有匹配的插件</strong>
                    <span>试试别的关键词，或者清除筛选条件。</span>
                    <ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() => {
                        setFilter("")
                        setTypeFilter("all")
                      }}
                    >
                      清除筛选
                    </ui.Button>
                  </div>
                }
              >
                <div class="ph-list">
                  <For each={visible().slice(0, limit())}>{(entry) => catalogRow(entry)}</For>
                </div>
                <Show when={visible().length > limit()}>
                  <ui.Button variant="ghost" size="small" onClick={() => setLimit((n) => n + PAGE)}>
                    显示更多（还有 {visible().length - limit()} 个）
                  </ui.Button>
                </Show>
              </Show>
            </Show>
          </section>
        </Match>

        <Match when={tab() === "search"}>
          <section class="ph-panel">
            <div class="ph-searchbar">
              <div class="ph-grow">
                <ui.TextInput
                  label="搜索 npm 上的 OpenCode 插件"
                  placeholder="搜索插件，例如 qoder / notify / usage"
                  type="search"
                  value={query()}
                  onInput={setQuery}
                  onSubmit={(value) => void runSearch(value)}
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
              <span>直查 npm 上带 opencode-plugin 标签的包，覆盖精选目录之外的长尾；结果未经人工筛选。</span>
            </div>

            <Show when={!searched()}>
              <div class="ph-empty">
                <ui.Icon name="magnifying-glass" size="large" />
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
                <h3 class="ph-h3">
                  搜索结果 <span class="ph-count">{sortedHits().length}</span>
                </h3>
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
                    <div class="ph-empty">
                      <ui.Icon name="magnifying-glass" size="large" />
                      <strong>没有找到匹配的插件</strong>
                      <span>换个关键词试试，或者清空搜索查看建议。</span>
                    </div>
                  }
                >
                  <div class="ph-list">
                    <For each={sortedHits()}>{(hit) => searchRow(hit)}</For>
                  </div>
                </Show>
              </Show>
            </Show>
          </section>
        </Match>

        <Match when={tab() === "installed"}>
          <section class="ph-panel">
            <div class="ph-resultbar">
              <h3 class="ph-h3">
                已安装 <span class="ph-count">{state()?.plugins.length ?? 0}</span>
              </h3>
              <div class="ph-chips">
                <button
                  class="ph-chip"
                  data-active={staleOnly()}
                  data-disabled={outdated() === 0 ? "true" : undefined}
                  title={outdated() === 0 ? "检查更新后再来看可更新的插件" : "只显示有新版本的插件"}
                  onClick={() => {
                    if (outdated() > 0) setStaleOnly(!staleOnly())
                  }}
                >
                  可更新
                  <span class="ph-chip-count">{outdated()}</span>
                </button>
              </div>
              <span class="ph-spacer" />
              <Show when={checked()}>
                <span class="ph-meta">
                  检查过 npm registry{outdated() > 0 ? ` · ${outdated()} 个可更新` : " · 全部已是最新"}
                </span>
              </Show>
            </div>
            <Show
              when={(state()?.plugins.length ?? 0) > 0}
              fallback={
                <div class="ph-empty">
                  <ui.Icon name="extensions" size="large" />
                  <strong>还没有安装插件</strong>
                  <span>去「精选目录」看看 awesome-opencode 的推荐，或者在「npm 搜索」里找长尾插件。</span>
                </div>
              }
            >
              <Show
                when={visiblePlugins().length > 0}
                fallback={
                  <div class="ph-empty">
                    <ui.Icon name="checklist" size="large" />
                    <strong>没有可更新的插件</strong>
                    <span>已安装的插件都已是最新版本。点工具栏的「检查更新」可以再查一次。</span>
                    <ui.Button variant="ghost" size="small" onClick={() => setStaleOnly(false)}>
                      显示全部
                    </ui.Button>
                  </div>
                }
              >
                <div class="ph-list">
                  <For each={visiblePlugins()}>{(entry) => installedRow(entry)}</For>
                </div>
              </Show>
            </Show>
          </section>
        </Match>
      </Switch>

      <footer class="ph-footer">
        <div class="ph-footer-note">
          安装和移除只改配置，不会立即生效：插件与模型目录都是启动时快照的。改完点工具栏的「彻底重启」，应用会自动退出并重新打开。
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
