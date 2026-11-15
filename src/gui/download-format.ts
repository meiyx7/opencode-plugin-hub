/**
 * Rendering of download counts. Kept free of Solid/GUI imports so the "unknown, not zero"
 * contract can be tested on its own; the page and its tests share this one implementation.
 */

const COMPACT = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 })

/** `-1` marks "the download API could not be asked": unknown, never rendered as 0. */
export function formatCount(value: number): string {
  if (value < 0) return "暂不可用"
  if (!Number.isFinite(value) || value <= 0) return "0"
  return COMPACT.format(value)
}

/** Card text: an unknown count says so outright instead of reading like "0/周". */
export function countWithUnit(value: number, unit: "周" | "月"): string {
  if (value < 0) return "暂不可用"
  return `${formatCount(value)}/${unit}`
}

/** The count is genuinely unknown (API failed), so the tooltip must not claim a number. */
export function countTitle(value: number, kind: string): string | undefined {
  if (value < 0) return `${kind}暂不可用`
  return `${kind} ${value.toLocaleString()} 次`
}
