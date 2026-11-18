/**
 * 插件中心的视觉基础。
 *
 * 颜色全部从宿主主题变量取，深色/浅色由宿主切换；这里只定义间距、圆角、
 * 字号和少量与颜色无关的层级。业务状态色统一走 --ph-success / --ph-warning /
 * --ph-danger / --ph-accent，保证三个页面和详情弹窗对同一状态说同一种话。
 */
export const CSS = `
/* 变量作用域必须覆盖每一个「弹框根」，而不只是页面根：宿主 ui.Dialog 把 children 与
   footer 渲染到各自独立的容器，它们都不在 .ph-root 之内。独立进度弹框的根是
   .ph-progress，footer 的根是 .ph-dialog-footer；漏掉任何一个，该子树里所有
   var(--ph-*) 都未定义，颜色/边框/背景整体失效，视觉上退化成纯文字。 */
.ph-root, .ph-detail, .ph-progress, .ph-dialog-footer {
  --ph-strong: var(--color-v2-text-text-contrast, var(--color-text-strong, currentColor));
  --ph-text: var(--color-v2-text-text-base, var(--color-text-base, inherit));
  --ph-muted: var(--color-v2-text-text-muted, var(--color-text-weak, color-mix(in srgb, currentColor 58%, transparent)));
  --ph-faint: var(--color-v2-text-text-faint, color-mix(in srgb, currentColor 42%, transparent));
  --ph-border: var(--color-v2-border-border-base, var(--color-border-weak-base, color-mix(in srgb, currentColor 12%, transparent)));
  --ph-border-strong: var(--color-v2-border-border-strong, color-mix(in srgb, currentColor 24%, transparent));
  --ph-layer: var(--color-v2-background-bg-layer-01, var(--color-surface-base, color-mix(in srgb, currentColor 3%, transparent)));
  --ph-layer-2: var(--color-v2-background-bg-layer-02, var(--color-surface-raised-base, color-mix(in srgb, currentColor 6%, transparent)));
  --ph-layer-3: var(--color-v2-background-bg-layer-03, color-mix(in srgb, currentColor 10%, transparent));
  --ph-base: var(--color-v2-background-bg-base, var(--color-background-base, Canvas));
  --ph-accent: var(--color-v2-text-text-accent, var(--color-text-interactive-base, var(--color-blue-primary, #4f8cff)));
  --ph-success: var(--color-v2-state-fg-success, var(--color-green, #2f9e5f));
  --ph-danger: var(--color-v2-state-fg-danger, var(--color-red, #d9534f));
  --ph-warning: var(--color-v2-state-fg-warning, var(--color-orange, #c98a16));
  --ph-hover: var(--color-v2-overlay-simple-overlay-hover, color-mix(in srgb, currentColor 6%, transparent));
  --ph-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  --ph-r-sm: 6px;
  --ph-r-md: 9px;
  --ph-r-lg: 12px;
  --ph-shadow: 0 1px 2px color-mix(in srgb, black 6%, transparent);
}

.ph-root {
  container: ph-root / inline-size;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 1120px;
  min-width: 0;
  padding: 2px 0 32px;
  color: var(--ph-text);
  font-size: 12px;
  line-height: 1.5;
}
.ph-root *, .ph-detail * { box-sizing: border-box; }
.ph-spacer { flex: 1; min-width: 0; }

/* ---------- 品牌 Hero ---------- */
/* 深蓝渐变是品牌固定色，不随宿主明暗主题翻转——这是刻意的品牌识别，与参考设计一致。
   文字用固定浅色保证在渐变上的对比度；装饰仅在 Hero 内，pointer-events:none 不挡点击。 */
.ph-hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  min-height: 132px;
  padding: 19px 20px;
  border-radius: var(--ph-r-lg);
  background:
    radial-gradient(ellipse at 88% 5%, rgba(91,151,231,.24), transparent 38%),
    linear-gradient(112deg,#172e4c 0%,#203d62 58%,#244b76 100%);
  color: #fff;
}
.ph-hero::after {
  content: "";
  position: absolute;
  width: 250px;
  height: 250px;
  right: 46px;
  top: -158px;
  border: 1px solid rgba(180,213,255,.17);
  border-radius: 50%;
  box-shadow:
    0 0 0 21px rgba(180,213,255,.035),
    0 0 0 45px rgba(180,213,255,.03),
    0 0 0 72px rgba(180,213,255,.02);
  pointer-events: none;
}
.ph-hero::before {
  content: "";
  position: absolute;
  width: 150px;
  height: 150px;
  right: 56px;
  bottom: -120px;
  border: 1px solid rgba(180,213,255,.16);
  border-radius: 50%;
  pointer-events: none;
}
.ph-hero-deco {
  position: absolute;
  right: 12%;
  top: 30px;
  width: 118px;
  height: 84px;
  color: #b7d7ff;
  opacity: .2;
  pointer-events: none;
}
.ph-hero-deco svg { width: 100%; height: 100%; display: block; }
.ph-hero-inner {
  position: relative;
  z-index: 1;
  min-width: 0;
}
.ph-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ph-brand-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: rgba(255,255,255,.12);
  border: 1px solid rgba(255,255,255,.15);
  box-shadow: inset 0 1px rgba(255,255,255,.10);
}
.ph-brand-mark svg { width: 22px; height: 22px; display: block; }
.ph-brand-words { display: flex; flex-direction: column; justify-content: center; min-width: 0; }
.ph-brand-en {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2.2px;
  color: #dce9f8;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.ph-hero-main { margin-top: 13px; }
.ph-hero-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -.4px;
  line-height: 1.3;
  color: #fff;
}
.ph-hero-desc {
  margin: 7px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: #c0d1e5;
  letter-spacing: .1px;
  overflow-wrap: anywhere;
}

/* 来源说明与配置路径：保留原有入口与内容，位置仍在 Hero 之外。 */
.ph-source {
  margin: -4px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--ph-faint);
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  max-width: 100%;
  font-size: 10px;
  line-height: 1.6;
  color: var(--ph-faint);
}
.ph-path code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ph-mono);
  font-size: 9.5px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--ph-layer-2);
}
.ph-path .ph-path-key { flex: 0 0 auto; opacity: 0.8; }

/* ---------- 通知 ---------- */
.ph-notices { display: flex; flex-direction: column; gap: 7px; }
.ph-notice {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 10px;
  border: 1px solid var(--ph-border);
  border-left-width: 3px;
  border-radius: 8px;
  background: var(--ph-layer);
  color: var(--ph-muted);
  font-size: 11.5px;
  line-height: 1.55;
}
.ph-notice-text, .ph-notice-body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  max-height: 104px;
  overflow-y: auto;
}
.ph-notice[data-tone="error"] {
  color: var(--ph-danger);
  border-color: color-mix(in srgb, var(--ph-danger) 24%, transparent);
  border-left-color: var(--ph-danger);
  background: color-mix(in srgb, var(--ph-danger) 6%, transparent);
}
.ph-notice[data-tone="success"] {
  color: var(--ph-success);
  border-color: color-mix(in srgb, var(--ph-success) 24%, transparent);
  border-left-color: var(--ph-success);
  background: color-mix(in srgb, var(--ph-success) 6%, transparent);
}
.ph-notice[data-tone="warning"] {
  color: var(--ph-warning);
  border-color: color-mix(in srgb, var(--ph-warning) 24%, transparent);
  border-left-color: var(--ph-warning);
  background: color-mix(in srgb, var(--ph-warning) 6%, transparent);
}
.ph-notice[data-tone="info"] { border-left-color: var(--ph-accent); }
.ph-notice > svg { flex: 0 0 auto; margin-top: 1px; }
.ph-notice-close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
}
.ph-notice-close:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
.ph-notice .ph-notice-action { flex: 0 0 auto; align-self: center; }

/* 待生效变更常驻工具栏，不占用正文高度。 */
.ph-pending {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--ph-accent) 22%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--ph-accent) 5%, transparent);
  color: var(--ph-muted);
  font-size: 10.5px;
  line-height: 1.45;
}
.ph-pending .ph-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ph-accent);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ph-pending .ph-link:hover { text-decoration: underline; }

/* ---------- 工具栏和页签 ---------- */
.ph-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 6px 0;
  margin: -6px 0;
  background: color-mix(in srgb, var(--ph-base) 92%, transparent);
  backdrop-filter: blur(8px);
}
.ph-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ph-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ph-border);
  border-radius: 8px;
  background: var(--ph-layer);
}
.ph-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ph-muted);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ph-tab:hover { color: var(--ph-strong); background: var(--ph-hover); }
.ph-tab[data-active="true"] {
  color: var(--ph-strong);
  background: var(--ph-layer-3);
  box-shadow: var(--ph-shadow);
}
.ph-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  padding: 1px 4px;
  border-radius: 99px;
  background: color-mix(in srgb, currentColor 9%, transparent);
  color: var(--ph-muted);
  font-size: 9px;
  font-weight: 600;
}
.ph-count-alert {
  background: color-mix(in srgb, var(--ph-warning) 14%, transparent);
  color: var(--ph-warning);
  white-space: nowrap;
}
.ph-tab[data-active="true"] .ph-count {
  background: color-mix(in srgb, var(--ph-accent) 14%, transparent);
  color: var(--ph-accent);
}
.ph-toolbar-action { margin-left: auto; }

/* ---------- 面板、筛选和结果摘要 ---------- */
.ph-panel { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ph-filters { display: flex; flex-direction: column; gap: 7px; }
.ph-filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ph-grow { flex: 1 1 280px; min-width: 0; }
.ph-searchbar { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.ph-searchbar .ph-grow { flex: 1 1 320px; }
.ph-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--ph-faint);
  line-height: 1.5;
}
.ph-meta > span { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.ph-meta strong, .ph-meta-strong { font-weight: 600; color: var(--ph-muted); }
.ph-dot { flex: 0 0 auto; width: 2.5px; height: 2.5px; border-radius: 50%; background: currentColor; opacity: 0.45; }
.ph-resultbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; min-height: 24px; }
.ph-resultline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 22px;
  font-size: 10.5px;
  color: var(--ph-faint);
}
.ph-resultline strong { color: var(--ph-muted); font-weight: 600; }
.ph-check-summary { color: var(--ph-muted); }
.ph-registry-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 4px 0 2px;
  font-size: 10.5px;
  color: var(--ph-faint);
}
.ph-registry-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--ph-ok, var(--ph-accent)); opacity: 0.85; }
.ph-registry-line[data-fallback="true"] .ph-registry-dot { background: var(--ph-warning); }
.ph-registry-line[data-failed="true"] .ph-registry-dot { background: var(--ph-danger); }
.ph-registry-line[data-failed="true"] { color: var(--ph-danger); }
.ph-registry-settings {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 6px;
}
.ph-registry-settings-label { font-size: 10.5px; font-weight: 600; color: var(--ph-muted); }
.ph-registry-settings-note { font-size: 10px; color: var(--ph-faint); }
.ph-registry-settings-note[data-env="true"] { color: var(--ph-warning); }
.ph-clear {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ph-accent);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ph-clear:hover { text-decoration: underline; }
.ph-h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ph-muted);
}
.ph-sort {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ph-border);
  border-radius: 7px;
  background: var(--ph-layer);
}
.ph-sort button {
  height: 22px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ph-muted);
  font-family: inherit;
  font-size: 10px;
  cursor: pointer;
}
.ph-sort button:hover { color: var(--ph-strong); background: var(--ph-hover); }
.ph-sort button[data-active="true"] {
  color: var(--ph-accent);
  background: color-mix(in srgb, var(--ph-accent) 10%, transparent);
}
.ph-installed-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ph-installed-search { flex: 0 1 300px; min-width: 180px; }
.ph-installed-bar .ph-chips { flex: 1 1 auto; }

/* ---------- 卡片 ---------- */
.ph-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 10px;
  align-items: stretch;
}
.ph-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-r-lg);
  background: var(--ph-layer);
  transition: border-color 0.15s, background 0.15s;
}
.ph-card:hover { border-color: var(--ph-border-strong); background: var(--ph-layer-2); }
.ph-card[data-stale="true"] { border-color: color-mix(in srgb, var(--ph-accent) 30%, var(--ph-border)); }
.ph-card[data-status="failed"] {
  border-color: color-mix(in srgb, var(--ph-danger) 38%, var(--ph-border));
  background: color-mix(in srgb, var(--ph-danger) 3%, var(--ph-layer));
}
.ph-card[data-status="pending"] { border-color: color-mix(in srgb, var(--ph-accent) 24%, var(--ph-border)); }
.ph-card[data-status="unknown"] { border-color: color-mix(in srgb, var(--ph-warning) 26%, var(--ph-border)); }
.ph-card[data-status="paused"] { border-style: dashed; }
.ph-card[data-busy="true"] { border-color: var(--ph-accent); }
.ph-card[data-busy="true"]::before {
  content: "";
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  height: 2px;
  border-radius: 99px;
  background: linear-gradient(90deg, transparent, var(--ph-accent), transparent);
  background-size: 200% 100%;
  animation: ph-sweep 1.2s linear infinite;
  pointer-events: none;
}
@keyframes ph-sweep {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.ph-card-main { display: flex; flex: 1; flex-direction: column; gap: 7px; min-width: 0; }
.ph-card-head { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.ph-card-titles { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.ph-tile {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ph-accent) 18%, transparent);
  border-radius: var(--ph-r-md);
  background: color-mix(in srgb, var(--ph-accent) 8%, transparent);
  color: var(--ph-accent);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}
.ph-tile[data-runtime="failed"] {
  color: var(--ph-danger);
  border-color: color-mix(in srgb, var(--ph-danger) 26%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 8%, transparent);
}
.ph-tile[data-runtime="paused"] { opacity: 0.55; }
.ph-tile[data-runtime="pending"] { opacity: 0.8; }
.ph-tile[data-runtime="unknown"] { opacity: 0.62; }
.ph-tile[data-runtime="rule"], .ph-tile[data-runtime="control"] { opacity: 0.55; }
.ph-name-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.ph-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--ph-strong);
}
.ph-card-sub { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; }
.ph-pkg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--ph-mono);
  font-size: 10px;
  color: var(--ph-faint);
}
.ph-version { flex: 0 0 auto; font-size: 10px; font-weight: 400; color: var(--ph-muted); }
.ph-version-arrow { color: var(--ph-accent); }
.ph-card-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  border-radius: 5px;
  outline-offset: 3px;
}
.ph-card-body[role="button"] { cursor: pointer; }
.ph-desc {
  min-height: calc(1.55em * 2);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ph-muted);
}
.ph-card-body[role="button"]:hover .ph-desc { color: var(--ph-text); }
.ph-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ph-installed-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 10px;
  line-height: 1.45;
  color: var(--ph-faint);
}
.ph-installed-meta > span { flex: 0 0 auto; min-width: 0; }
.ph-installed-meta > span[data-ellipsis] { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.ph-installed-meta > .ph-dot { flex: 0 0 auto; overflow: visible; }
.ph-card-status { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-height: 20px; }
.ph-runtime-error {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  color: var(--ph-danger);
  font-size: 10.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
/* 插件中心自升级说明：轻量提示，不抢状态徽章的注意力。 */
.ph-self-update-hint {
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--ph-accent);
  overflow-wrap: anywhere;
}
.ph-type {
  font-size: 9.5px;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ph-faint);
}
.ph-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  flex-wrap: wrap;
  min-height: 34px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--ph-border);
}
.ph-actions-left, .ph-actions-right { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.ph-actions-right { margin-left: auto; justify-content: flex-end; }

/* ---------- 徽章和筛选片 ---------- */
.ph-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--ph-border);
  border-radius: 5px;
  background: var(--ph-layer-2);
  color: var(--ph-muted);
  font-size: 9px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}
.ph-badge[data-tone]::before,
.ph-badge[data-runtime]::before {
  content: "";
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.8;
}
.ph-badge[data-tone="accent"] {
  color: var(--ph-accent);
  border-color: color-mix(in srgb, var(--ph-accent) 26%, transparent);
  background: color-mix(in srgb, var(--ph-accent) 8%, transparent);
}
.ph-badge[data-tone="success"] {
  color: var(--ph-success);
  border-color: color-mix(in srgb, var(--ph-success) 26%, transparent);
  background: color-mix(in srgb, var(--ph-success) 8%, transparent);
}
.ph-badge[data-tone="warning"] {
  color: var(--ph-warning);
  border-color: color-mix(in srgb, var(--ph-warning) 28%, transparent);
  background: color-mix(in srgb, var(--ph-warning) 8%, transparent);
}
.ph-badge[data-tone="danger"] {
  color: var(--ph-danger);
  border-color: color-mix(in srgb, var(--ph-danger) 28%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 8%, transparent);
}
.ph-badge[data-runtime="loaded"] {
  color: var(--ph-success);
  border-color: color-mix(in srgb, var(--ph-success) 24%, transparent);
  background: color-mix(in srgb, var(--ph-success) 6%, transparent);
}
.ph-badge[data-runtime="failed"] {
  color: var(--ph-danger);
  border-color: color-mix(in srgb, var(--ph-danger) 28%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 8%, transparent);
}
.ph-badge[data-runtime="paused"] { color: var(--ph-muted); border-style: dashed; background: transparent; }
.ph-badge[data-runtime="pending"] {
  color: var(--ph-accent);
  border-color: color-mix(in srgb, var(--ph-accent) 24%, transparent);
  background: color-mix(in srgb, var(--ph-accent) 6%, transparent);
}
.ph-badge[data-runtime="unknown"] {
  color: var(--ph-warning);
  border-color: color-mix(in srgb, var(--ph-warning) 26%, transparent);
  background: color-mix(in srgb, var(--ph-warning) 7%, transparent);
}
.ph-badge[data-runtime="rule"], .ph-badge[data-runtime="control"] { color: var(--ph-faint); background: transparent; }
.ph-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ph-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 23px;
  max-width: 100%;
  overflow: hidden;
  padding: 0 7px;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-r-sm);
  background: var(--ph-layer);
  color: var(--ph-muted);
  font-family: inherit;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  text-overflow: ellipsis;
}
button.ph-chip { cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s; }
button.ph-chip:hover { color: var(--ph-strong); border-color: var(--ph-border-strong); }
button.ph-chip[data-active="true"] {
  color: var(--ph-accent);
  border-color: color-mix(in srgb, var(--ph-accent) 30%, transparent);
  background: color-mix(in srgb, var(--ph-accent) 8%, transparent);
}
.ph-chip[data-disabled="true"] { opacity: 0.45; cursor: default; }
.ph-chip-count { font-size: 8.5px; opacity: 0.7; }

/* ---------- 空状态和加载 ---------- */
.ph-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 38px 18px;
  border: 1px dashed var(--ph-border);
  border-radius: var(--ph-r-lg);
  color: var(--ph-muted);
  text-align: center;
}
.ph-empty-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 2px;
  border-radius: 10px;
  background: var(--ph-layer-2);
  color: var(--ph-faint);
}
.ph-empty strong { font-size: 13px; font-weight: 600; color: var(--ph-strong); }
.ph-empty span { max-width: 52ch; font-size: 11.5px; line-height: 1.6; }
.ph-empty .ph-chips { justify-content: center; margin-top: 2px; }
.ph-skeleton {
  height: 158px;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-r-lg);
  background: linear-gradient(90deg, var(--ph-layer) 0%, var(--ph-layer-2) 50%, var(--ph-layer) 100%);
  background-size: 200% 100%;
  animation: ph-shimmer 1.4s ease-in-out infinite;
}
@keyframes ph-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.ph-more { display: flex; justify-content: center; padding: 2px 0; }

/* ---------- 详情弹窗 ---------- */
.ph-detail {
  container: ph-detail / inline-size;
  display: flex;
  flex-direction: column;
  gap: 11px;
  height: min(620px, calc(100vh - 240px));
  min-height: 360px;
}
.ph-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 14px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ph-border);
}
.ph-detail-identity { display: flex; flex: 1 1 360px; gap: 10px; min-width: 0; }
.ph-detail-avatar { width: 40px; height: 40px; font-size: 16px; }
.ph-detail-titles { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.ph-detail-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 15px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--ph-strong);
}
.ph-detail-pkg { font-family: var(--ph-mono); font-size: 10px; color: var(--ph-faint); overflow-wrap: anywhere; }
.ph-detail-badges { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ph-detail-desc { margin: 2px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--ph-muted); }
.ph-detail-primary { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; padding-top: 1px; }
.ph-detail .ph-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--ph-warning) 26%, transparent);
  border-left: 3px solid var(--ph-warning);
  border-radius: 7px;
  background: color-mix(in srgb, var(--ph-warning) 6%, transparent);
  color: var(--ph-warning);
  font-size: 11px;
  line-height: 1.5;
}
.ph-detail .ph-warning[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--ph-danger) 24%, transparent);
  border-left-color: var(--ph-danger);
  background: color-mix(in srgb, var(--ph-danger) 6%, transparent);
  color: var(--ph-danger);
}
.ph-detail .ph-warning span { min-width: 0; overflow-wrap: anywhere; }
.ph-detail-layout {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow: auto;
}
/* 纵向堆叠时让 README 按内容撑开、由外层滚动，侧栏不能收缩盖到正文上。 */
.ph-detail-main { flex: 0 0 auto; min-height: 0; }
.ph-detail-side { display: flex; flex: 0 0 auto; flex-direction: column; gap: 12px; min-height: 0; }
.ph-detail-loading {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 220px;
  font-size: 11.5px;
  color: var(--ph-muted);
}
.ph-detail-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.ph-detail-stat {
  padding: 7px 8px;
  border: 1px solid var(--ph-border);
  border-radius: 8px;
  background: var(--ph-layer);
}
.ph-detail-stat b { display: block; font-size: 14px; font-weight: 650; line-height: 1.25; color: var(--ph-strong); }
.ph-detail-stat span { display: block; margin-top: 1px; font-size: 9.5px; color: var(--ph-faint); }
.ph-side-block { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ph-side-title {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ph-faint);
}
.ph-meta-list { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ph-meta-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 10.5px; line-height: 1.45; }
.ph-meta-key { flex: 0 0 auto; color: var(--ph-faint); }
.ph-meta-value { min-width: 0; color: var(--ph-muted); text-align: right; overflow-wrap: anywhere; }
.ph-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ph-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ph-section-title {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ph-faint);
}
.ph-readme {
  max-width: 74ch;
  font-size: 12px;
  line-height: 1.65;
  color: var(--ph-text);
  overflow-wrap: anywhere;
}
.ph-readme > :first-child { margin-top: 0; }
.ph-readme > :last-child { margin-bottom: 0; }
.ph-readme h1, .ph-readme h2, .ph-readme h3, .ph-readme h4 { margin: 1.1em 0 0.45em; line-height: 1.35; color: var(--ph-strong); }
.ph-readme h1 { font-size: 17px; }
.ph-readme h2 { font-size: 15px; }
.ph-readme h3 { font-size: 13.5px; }
.ph-readme p { margin: 0 0 0.75em; }
.ph-readme ul, .ph-readme ol { margin: 0 0 0.75em; padding-left: 1.35em; }
.ph-readme li { margin: 0.12em 0; }
.ph-readme a { color: var(--ph-accent); text-decoration: none; }
.ph-readme a:hover { text-decoration: underline; }
.ph-readme img { max-width: 100%; height: auto; border-radius: 7px; }
.ph-readme pre {
  overflow: auto;
  padding: 9px 10px;
  border: 1px solid var(--ph-border);
  border-radius: 7px;
  background: var(--ph-layer-2);
  font-size: 10.5px;
  line-height: 1.5;
}
.ph-readme code { font-family: var(--ph-mono); font-size: 0.92em; }
.ph-readme :not(pre) > code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--ph-layer-2);
}
.ph-readme table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
.ph-readme th, .ph-readme td { padding: 4px 7px; border: 1px solid var(--ph-border); font-size: 10.5px; }
.ph-readme blockquote {
  margin: 0 0 0.75em;
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--ph-border-strong);
  color: var(--ph-muted);
}
.ph-readme-empty {
  padding: 16px;
  border: 1px dashed var(--ph-border);
  border-radius: 8px;
  color: var(--ph-muted);
  font-size: 11.5px;
  line-height: 1.55;
}
.ph-readme-note { font-size: 10px; color: var(--ph-faint); }
.ph-details {
  padding: 6px 8px;
  border: 1px solid var(--ph-border);
  border-radius: 7px;
  background: var(--ph-layer);
}
.ph-details summary { cursor: pointer; font-size: 10.5px; color: var(--ph-muted); }
.ph-details .ph-chips { margin-top: 6px; }
.ph-dialog-footer { display: flex; align-items: center; gap: 6px; width: 100%; flex-wrap: wrap; }
.ph-dialog-links { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.ph-detail-error {
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--ph-danger);
}

/* ---------- 页脚 ---------- */
.ph-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--ph-border);
}
.ph-footer-note { flex: 1; font-size: 10.5px; line-height: 1.6; color: var(--ph-faint); }
.ph-footer-note code { font-family: var(--ph-mono); font-size: 9.5px; }

/* ---------- 焦点 ---------- */
.ph-tab:focus-visible,
.ph-sort button:focus-visible,
button.ph-chip:focus-visible,
.ph-inline-source:focus-visible,
.ph-clear:focus-visible,
.ph-pending .ph-link:focus-visible,
.ph-card-body[role="button"]:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ph-accent) 55%, transparent);
  outline-offset: 2px;
}

/* ---------- 独立弹窗：不重复宿主的标题，尽量利用宽度 ---------- */
.ph-root[data-embedded="true"] {
  max-width: none;
  padding: 0 0 6px;
}
/* Hero 在 Dialog 与设置面板是同一套实现：不再按入口隐藏标题或抽掉内边距，
   窄宽度交给下面的容器查询统一处理，避免两份视觉定义漂移。 */

[data-component="dialog-v2"][data-size="x-large"]:has(.ph-root[data-embedded="true"]) [data-slot="dialog-container"],
[data-component="dialog-v2"][data-size="x-large"]:has(.ph-detail) [data-slot="dialog-container"] {
  width: min(100vw - 48px, 1180px);
  height: min(100vh - 88px, 780px);
  min-width: min(100vw - 48px, 720px);
  min-height: min(100vh - 88px, 480px);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  resize: both;
}

/* 宽详情：左边 README 独立滚动，右边元数据独立滚动。 */
@container ph-detail (min-width: 720px) {
  .ph-detail-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 18px;
    overflow: hidden;
  }
  .ph-detail-main { overflow-y: auto; padding-right: 5px; }
  .ph-detail-side {
    overflow-y: auto;
    padding-left: 15px;
    border-left: 1px solid var(--ph-border);
  }
}

/* SettingsPage 的窄内容区；按容器宽度而不是窗口宽度判断。 */
@container ph-root (max-width: 700px) {
  .ph-path { max-width: none; }
  .ph-hero { min-height: 120px; padding: 17px 18px; }
  .ph-hero-deco { right: 8%; opacity: .16; }
  .ph-toolbar-action { margin-left: 0; }
}
@container ph-root (max-width: 520px) {
  /* 窄宽度下收紧字号与装饰，但保留品牌行、标题、描述与配置的完整内容。 */
  .ph-hero { min-height: 0; padding: 15px 16px; }
  .ph-hero-deco { right: -18px; top: 26px; opacity: .11; }
  .ph-hero::after { right: -30px; }
  .ph-hero::before { display: none; }
  .ph-hero-main { margin-top: 13px; }
  .ph-hero-title { font-size: 18px; }
  .ph-hero-desc { font-size: 11px; }
  .ph-brand-en { letter-spacing: 1px; }
  .ph-list { grid-template-columns: 1fr; }
  .ph-actions { justify-content: flex-start; }
  .ph-actions-right { margin-left: 0; }
  .ph-tab { padding: 0 7px; }
  .ph-tab .ph-count-alert { display: none; }
}

@media (max-width: 760px) {
  .ph-root { padding-bottom: 24px; }
  .ph-detail { height: auto; min-height: 360px; }
  .ph-detail-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ---------- 安装 / 更新进度 Dialog ---------- */
.ph-progress { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ph-progress-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ph-progress-tile { width: 36px; height: 36px; font-size: 15px; }
.ph-progress-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ph-progress-name { font-size: 14px; font-weight: 650; color: var(--ph-strong); overflow-wrap: anywhere; }
.ph-progress-flow { font-size: 10.5px; color: var(--ph-muted); }
.ph-progress-versions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ph-steps { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; }
.ph-step { position: relative; display: flex; gap: 12px; padding: 0 0 15px; }
.ph-step:last-child { padding-bottom: 0; }
/* 连续竖向连接线：从当前节点圆心延伸到下一个节点；状态决定线的颜色与强弱。
   节点 20px、圆心 10px；线宽 2px，左偏移 9px 使线心正好落在圆心，不靠肉眼对。 */
.ph-step::before {
  content: ""; position: absolute; left: 9px; top: 21px; bottom: -1px; width: 2px;
  background: var(--ph-border); border-radius: 1px;
}
.ph-step:last-child::before { display: none; }
.ph-step[data-state="done"]::before { background: color-mix(in srgb, var(--ph-success) 55%, transparent); }
.ph-step[data-state="running"]::before { background: color-mix(in srgb, var(--ph-accent) 45%, transparent); }
.ph-step[data-state="failed"]::before { background: color-mix(in srgb, var(--ph-danger) 40%, transparent); }
.ph-step[data-state="skipped"]::before,
.ph-step[data-state="unknown"]::before { background: color-mix(in srgb, var(--ph-border-strong) 55%, transparent); }
.ph-step-ico {
  position: relative; z-index: 1; flex: 0 0 auto; width: 20px; height: 20px; margin-top: 0;
  border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; line-height: 1;
  background: var(--ph-base); color: transparent;
}
.ph-step[data-state="pending"] .ph-step-ico { border: 1.5px solid var(--ph-border-strong); }
.ph-step[data-state="running"] .ph-step-ico {
  border: 2px solid color-mix(in srgb, var(--ph-accent) 28%, transparent);
  border-top-color: var(--ph-accent);
  animation: ph-spin 0.8s linear infinite;
}
.ph-step[data-state="done"] .ph-step-ico { background: var(--ph-success); border-color: var(--ph-success); color: #fff; }
.ph-step[data-state="failed"] .ph-step-ico { background: var(--ph-danger); border-color: var(--ph-danger); color: #fff; }
.ph-step[data-state="skipped"] .ph-step-ico { border: 1.5px dashed var(--ph-border-strong); color: var(--ph-faint); }
.ph-step[data-state="unknown"] .ph-step-ico { background: var(--ph-warning); border-color: var(--ph-warning); color: #fff; }
.ph-step-copy { min-width: 0; flex: 1; }
.ph-step-title { font-size: 12px; font-weight: 600; color: var(--ph-text); }
.ph-step[data-state="pending"] .ph-step-title { color: var(--ph-faint); }
.ph-step-desc { margin-top: 2px; font-size: 10.5px; line-height: 1.5; color: var(--ph-muted); overflow-wrap: anywhere; }
.ph-step[data-state="running"] .ph-step-desc { color: var(--ph-accent); }
.ph-step[data-state="failed"] .ph-step-desc { color: var(--ph-danger); }
.ph-step[data-state="unknown"] .ph-step-desc { color: var(--ph-warning); }
.ph-step-error {
  margin-top: 5px; padding: 5px 7px; border-radius: var(--ph-r-sm);
  border: 1px solid color-mix(in srgb, var(--ph-danger) 30%, transparent);
  background: color-mix(in srgb, var(--ph-danger) 6%, var(--ph-layer));
  font-size: 10px; line-height: 1.5; color: var(--ph-danger); overflow-wrap: anywhere;
}
@keyframes ph-spin { to { transform: rotate(360deg); } }
.ph-progress-result {
  margin-top: 2px; padding: 9px 11px; border: 1px solid var(--ph-border); border-left-width: 3px;
  border-radius: var(--ph-r-sm); background: var(--ph-layer);
}
.ph-progress-result[data-tone="success"] { border-left-color: var(--ph-success); background: color-mix(in srgb, var(--ph-success) 5%, var(--ph-layer)); }
.ph-progress-result[data-tone="failed"] { border-left-color: var(--ph-danger); background: color-mix(in srgb, var(--ph-danger) 5%, var(--ph-layer)); }
.ph-progress-result[data-tone="attention"] { border-left-color: var(--ph-warning); background: color-mix(in srgb, var(--ph-warning) 5%, var(--ph-layer)); }
.ph-progress-result-head { font-size: 12.5px; font-weight: 650; }
.ph-progress-result[data-tone="success"] .ph-progress-result-head { color: var(--ph-success); }
.ph-progress-result[data-tone="failed"] .ph-progress-result-head { color: var(--ph-danger); }
.ph-progress-result[data-tone="attention"] .ph-progress-result-head { color: var(--ph-warning); }
.ph-progress-summary { margin: 4px 0 0; font-size: 10.5px; line-height: 1.6; color: var(--ph-text); overflow-wrap: anywhere; }
.ph-progress-rows { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--ph-border); display: grid; gap: 4px; }
.ph-progress-row { display: grid; grid-template-columns: 84px 1fr; gap: 8px; font-size: 10.5px; }
.ph-progress-key { color: var(--ph-faint); }
.ph-progress-val { color: var(--ph-text); overflow-wrap: anywhere; }
.ph-progress-val[data-tone="ok"] { color: var(--ph-success); }
.ph-progress-val[data-tone="bad"] { color: var(--ph-danger); }
.ph-progress-val[data-tone="warn"] { color: var(--ph-warning); }
.ph-progress-foot { margin: 0; font-size: 10.5px; line-height: 1.5; color: var(--ph-muted); overflow-wrap: anywhere; }
.ph-progress-foot[data-state="running"] { color: var(--ph-accent); }
.ph-progress-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border: 1px solid var(--ph-border); border-radius: 99px; background: var(--ph-layer);
  font-size: 10px; font-weight: 650; color: var(--ph-muted);
}
.ph-progress-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ph-progress-pill[data-state="running"] { color: var(--ph-accent); border-color: color-mix(in srgb, var(--ph-accent) 26%, transparent); }
.ph-progress-pill[data-state="running"]::before { animation: ph-pulse 1s ease-in-out infinite; }
.ph-progress-pill[data-tone="success"] { color: var(--ph-success); border-color: color-mix(in srgb, var(--ph-success) 26%, transparent); }
.ph-progress-pill[data-tone="failed"] { color: var(--ph-danger); border-color: color-mix(in srgb, var(--ph-danger) 26%, transparent); }
.ph-progress-pill[data-tone="attention"] { color: var(--ph-warning); border-color: color-mix(in srgb, var(--ph-warning) 26%, transparent); }
@keyframes ph-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .ph-step[data-state="running"] .ph-step-ico,
  .ph-progress-pill[data-state="running"]::before { animation: none; }
}
`
