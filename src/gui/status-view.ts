/**
 * 已安装插件的状态判定（纯函数，无 Solid/DOM 依赖）。
 *
 * TASK-05：列表与摘要共用同一套状态判断逻辑。把原先埋在 page.tsx 组件里的
 * runtimeState 判定抽成纯函数，列表徽章、排序、摘要、详情都从这里取，并对每种
 * 状态构造数据做单元测试，避免「列表说已暂停、详情说未验证」这类漂移。
 *
 * 判定只依赖服务端的运行事实（runtime info）+ 配置条目类型 + 读取运行状态是否出错，
 * 不引入新的数据来源，也不改变任何现有状态含义：
 * - failed  / loaded / paused 由 runtime 明确给出；
 * - control / rule 是配置规则，不是插件包；
 * - pending 是「配置已写入但宿主还没在列表里报告」，unknown 是「宿主应答不可用或未验证」。
 */

export type RowState = "loaded" | "failed" | "paused" | "pending" | "unknown" | "control" | "rule"

/** 只需要这些字段；与 page.tsx 的 PluginEntry / RuntimeInfo 结构兼容。 */
export interface StatusEntry {
  kind: string
  rule?: boolean
  spec: string
}

export interface StatusRuntime {
  paused?: boolean
  status?: "loaded" | "failed" | "unknown" | "control"
  available: boolean
}

export interface StatusInput {
  /** 读取运行状态时是否出错；出错则「没有 runtime 记录」不能被当作「待加载」。 */
  runtimeError: string
  runtime?: StatusRuntime
}

/**
 * 统一状态判定。优先级：配置规则 > 明确暂停 > 运行事实 > 无记录时的诚实未知。
 */
export function classifyState(entry: StatusEntry, input: StatusInput): RowState {
  if (entry.kind === "control") return "control"
  if (entry.kind === "enable-rule" || entry.rule) return "rule"
  const info = input.runtime
  // 规则明确禁用时，运行时不报告它是正常现象 —— 先表达“已暂停”，不当作未验证。
  if (info?.paused) return "paused"
  if (!info) return input.runtimeError ? "unknown" : "pending"
  if (info.status === "failed") return "failed"
  if (info.status === "loaded") return "loaded"
  // 服务端已应答但列表里没有：配置已写入、尚未被加载；应答不可用才是真正的“未验证”。
  return info.available ? "pending" : "unknown"
}

/**
 * 严重程度排序值（问题在前）——严格保持现有排序语义，不改变行为：
 * 加载失败 → 待加载 → 可更新 → 未验证 → 已暂停 → 正常 → 配置规则。
 * 可更新(2)插在待加载(1)与未验证(3)之间；同级保持配置顺序（稳定排序）。
 */
const SEVERITY: Record<RowState, number> = {
  failed: 0,
  pending: 1,
  unknown: 3,
  paused: 4,
  loaded: 5,
  rule: 6,
  control: 6,
}

export function severityOf(state: RowState, hasUpdate: boolean): number {
  if (hasUpdate) return 2
  return SEVERITY[state]
}

/** 摘要是否应包含该状态（仅“需要关注”的问题项）。 */
export function needsAttention(state: RowState): boolean {
  return state === "failed" || state === "pending" || state === "unknown" || state === "paused"
}
