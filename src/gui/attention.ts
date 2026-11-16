/**
 * 已安装页「需要关注」摘要的统计口径。
 *
 * 与 download-format / feedback 一样，是游离于 Solid/DOM 之外的纯函数：
 * 组件用它渲染，测试对同一份实现断言，避免「组件一套口径、测试另一套」。
 *
 * 规则（需求）：
 * - 只有当某个状态的数量 > 0 时才产出这一项；
 * - 全部为 0 时返回空数组，界面据此不渲染整个摘要；
 * - 顺序固定：加载失败 → 待加载 → 可更新 → 已暂停 → 未验证；
 * - 统计的是“全部已安装插件”，不是当前搜索/筛选后的列表。
 *
 * 数量一律由调用方传入已算好的计数，这里不重算，保证统计口径唯一。
 */

/** 已安装页的状态筛选；管理页先看问题项，而不是按配置顺序翻。 */
export type InstalledFilter = "all" | "update" | "paused" | "failed" | "pending" | "unknown"

/** 摘要只关心“有问题值得关注”的状态，不含「全部」。 */
export type AttentionFilter = Exclude<InstalledFilter, "all">

export type AttentionTone = "danger" | "accent" | "warning"

export interface AttentionCounts {
  failed: number
  pending: number
  update: number
  paused: number
  unknown: number
}

export interface AttentionItem {
  id: AttentionFilter
  label: string
  count: number
  tone: AttentionTone
}

/** 顺序即严重程度顺序；项与状态的唯一语义化语气来源。 */
const ORDER: { id: AttentionFilter; label: string; tone: AttentionTone }[] = [
  { id: "failed", label: "加载失败", tone: "danger" },
  { id: "pending", label: "待加载", tone: "accent" },
  { id: "update", label: "可更新", tone: "warning" },
  { id: "paused", label: "已暂停", tone: "accent" },
  { id: "unknown", label: "未验证", tone: "warning" },
]

/**
 * 按“数量 > 0 才展示”的原则，把各状态计数转成摘要项。
 * 数量为 0 的项不产出；全部为 0 时返回空数组。
 */
export function buildAttentionItems(counts: AttentionCounts): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const { id, label, tone } of ORDER) {
    if (counts[id] <= 0) continue
    items.push({ id, label, count: counts[id], tone })
  }
  return items
}