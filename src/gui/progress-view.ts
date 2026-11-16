/**
 * 安装 / 更新进度 Dialog 的“阶段与结果”映射，纯函数、不依赖 Solid 或宿主组件。
 *
 * 诚实原则（任务硬约束）：
 * - 官方 CLI 的下载/解包没有实时事件，所以执行期间只展示一个“正在执行官方命令”的
 *   进行中状态，绝不按定时器推进、绝不显示百分比或剩余时间。
 * - 阶段状态只来自后端最终返回的 result.stages（命令 / 配置 / 运行 / 回滚），
 *   这些是唯一能确认的事实；不在结果回来前宣称任何阶段“已完成”。
 * - 配置成功 ≠ 运行成功：runtime=unknown/failed 分别映射到“未确认/失败”，不冒报成功。
 *
 * 本模块刻意不调用 explainMutation：语气与文案由 page.tsx 的统一出口传入，
 * 保证全仓库只有一处解释 mutation 结果（feedback.test.ts 的源码断言）。
 */

export type StepState = "pending" | "running" | "done" | "failed" | "skipped" | "unknown"
export type ResultTone = "success" | "failed" | "attention"
export type MutationTone = "info" | "success" | "warning" | "error"

export interface ProgressStep {
  title: string
  state: StepState
  desc: string
}

export interface ProgressRow {
  key: string
  value: string
  tone?: "ok" | "bad" | "warn"
}

export interface ProgressReport {
  tone: ResultTone
  headline: string
  summary: string
  steps: ProgressStep[]
  rows: ProgressRow[]
}

/** 只需要后端结果里与阶段判定有关的字段（与 MutationShape 结构兼容）。 */
export interface ProgressMutation {
  ok: boolean
  message: string
  selfUpdated?: boolean
  verification?: string
  stages?: {
    command?: string
    config?: string
    runtime?: string
    rollback?: string
    version?: string
  }
}

export interface ProgressInput {
  kind: "install" | "update"
  name: string
  from: string
  to: string
  selfUpdate: boolean
  /** 来自 reportMutation 的统一结论，不在这里重复解释。 */
  mutationTone: MutationTone
  mutationText: string
}

/**
 * Dialog 关闭时是否应清理当前的进度状态。
 *
 * 用于修复「详情 Dialog 关闭后进度残留」：关闭详情时要清掉它对应的 progress，
 * 但必须满足——该进度确实属于这个包（不误清其它插件）、且操作已结束（phase=done）。
 * 执行中（running）不允许关闭，更不允许提前清理阶段信息；清理只作用于界面状态，
 * 不触碰正在执行的 Promise。
 */
export function shouldClearProgress(
  current: { op: { name: string }; phase: "running" | "done" } | undefined,
  dialogName: string,
): boolean {
  if (!current) return false
  if (current.op.name !== dialogName) return false
  return current.phase === "done"
}

function commandStep(command: string | undefined, install: boolean): ProgressStep {
  const title = install ? "执行安装命令" : "执行更新命令"
  switch (command) {
    case "succeeded":
      return { title, state: "done", desc: "官方命令执行成功" }
    case "failed":
      return { title, state: "failed", desc: "官方命令执行失败" }
    case "skipped":
      return { title, state: "skipped", desc: "官方命令跳过了这一步" }
    default:
      return { title, state: "unknown", desc: "未取得命令执行结果" }
  }
}

function configStep(config: string | undefined, ok: boolean): ProgressStep {
  const title = "核验插件配置"
  switch (config) {
    case "updated":
      return { title, state: "done", desc: "配置读取和校验完成" }
    case "failed":
      return { title, state: "failed", desc: "配置写入未完成" }
    case "unchanged":
      return ok
        ? { title, state: "done", desc: "配置无需改动，已是目标状态" }
        : { title, state: "skipped", desc: "配置未改动" }
    default:
      return { title, state: "unknown", desc: "未取得配置核验结果" }
  }
}

function runtimeStep(runtime: string | undefined): ProgressStep {
  const title = "确认运行状态"
  switch (runtime) {
    case "loaded":
      return { title, state: "done", desc: "插件已正常加载" }
    case "failed":
      return { title, state: "failed", desc: "宿主报告插件加载失败" }
    case "unknown":
      return { title, state: "unknown", desc: "宿主未确认插件运行状态" }
    case "unchanged":
      return { title, state: "unknown", desc: "配置已切换，但运行时仍是旧状态" }
    case "skipped":
      return { title, state: "skipped", desc: "这一步未执行" }
    default:
      return { title, state: "unknown", desc: "未取得运行状态" }
  }
}

/** 进行中：只把“正在执行官方命令”标为进行中，其余全部待确认。无百分比、无定时器推进。 */
export function runningSteps(input: Pick<ProgressInput, "kind" | "selfUpdate">): ProgressStep[] {
  const first = input.selfUpdate
    ? { title: "准备并校验目标版本", state: "running" as const, desc: "正在执行官方命令，请稍候…" }
    : {
        title: input.kind === "install" ? "执行安装命令" : "执行更新命令",
        state: "running" as const,
        desc: "正在执行官方命令，请稍候…",
      }
  const rest: ProgressStep[] = input.selfUpdate
    ? [
        { title: "切换配置", state: "pending", desc: "等待执行" },
        { title: "加载确认", state: "pending", desc: "等待执行" },
      ]
    : [
        { title: "核验插件配置", state: "pending", desc: "等待执行" },
        { title: "确认运行状态", state: "pending", desc: "等待执行" },
      ]
  return [first, ...rest]
}

/** 把后端最终结果映射成阶段时间线与结论。 */
export function buildProgressReport(input: ProgressInput, result: ProgressMutation): ProgressReport {
  const stages = result.stages
  const install = input.kind === "install"

  const steps: ProgressStep[] = []
  if (input.selfUpdate) {
    steps.push({
      title: "准备并校验目标版本",
      state: stages?.command ? "done" : "unknown",
      desc: stages?.command ? "目标版本已在隔离目录准备并校验" : "未取得准备结果",
    })
  } else {
    steps.push(commandStep(stages?.command, install))
  }
  steps.push(configStep(stages?.config, result.ok))
  steps.push(runtimeStep(stages?.runtime))
  // 回滚只在后端确实报告时出现；none / 缺失都不展示，避免虚构必经步骤。
  if (stages?.rollback === "succeeded") {
    steps.push({ title: "回滚处理", state: "done", desc: "已回滚到原版本" })
  } else if (stages?.rollback === "failed") {
    steps.push({ title: "回滚处理", state: "failed", desc: "回滚未成功" })
  }

  const tone: ResultTone =
    input.mutationTone === "error"
      ? "failed"
      : input.mutationTone === "warning"
        ? "attention"
        : "success"
  const headline =
    tone === "failed"
      ? "操作失败"
      : tone === "attention"
        ? "需关注"
        : install
          ? "安装完成"
          : "更新完成"

  const after = stages?.version || input.to || "未变更"
  const rows: ProgressRow[] = [
    { key: install ? "安装前版本" : "更新前版本", value: input.from || "未知" },
    { key: install ? "安装后版本" : "更新后版本", value: after, tone: after === "未变更" ? undefined : "ok" },
    {
      key: "命令执行",
      value: stages?.command === "succeeded" ? "成功" : stages?.command === "failed" ? "失败" : "未确认",
      tone: stages?.command === "succeeded" ? "ok" : stages?.command === "failed" ? "bad" : "warn",
    },
    {
      key: "配置核验",
      value: stages?.config === "updated" ? "通过" : stages?.config === "failed" ? "未完成" : "未改动",
      tone: stages?.config === "updated" ? "ok" : stages?.config === "failed" ? "bad" : undefined,
    },
  ]
  const rt = stages?.runtime
  rows.push({
    key: "运行状态",
    value:
      rt === "loaded"
        ? "已加载"
        : rt === "failed"
          ? "加载失败"
          : rt === "unknown" || rt === "unchanged"
            ? "未确认"
            : "未核验",
    tone: rt === "loaded" ? "ok" : rt === "failed" ? "bad" : "warn",
  })
  if (stages?.rollback === "succeeded" || stages?.rollback === "failed") {
    rows.push({
      key: "回滚",
      value: stages.rollback === "succeeded" ? "已回滚" : "未成功",
      tone: stages.rollback === "succeeded" ? "ok" : "bad",
    })
  }

  return { tone, headline, summary: input.mutationText, steps, rows }
}
