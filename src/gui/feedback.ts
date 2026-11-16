/**
 * 把一次生命周期操作的结果翻译成「一句话 + 一种语气」。
 *
 * 抽出来单独放，是因为五个入口（安装、更新、暂停、恢复、移除）必须用同一套解释：
 * 以前语气由 ok 决定，于是「配置改了、运行时挂了」会走到成功色上 —— 那是最糟的一种谎。
 * 现在以服务端返回的 stages 为准，ok 只用来区分 config=unchanged 是「本来就不用改」
 * 还是「该改但没改成」。
 */
export type Tone = "info" | "success" | "warning" | "error"

/** Only the fields this module reads; the real IPC result is structurally compatible. */
export interface MutationShape {
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

export interface MutationReport {
  text: string
  tone: Tone
}

/** ok < warn < bad：只有回滚能改写最终结论，别的阶段各自给自己那一级。 */
type Severity = "ok" | "warn" | "bad"

/**
 * 配置阶段 × 运行时阶段的结论。
 *
 * `config=updated` 只说明文件写成功了，`runtime` 才是插件到底有没有跑起来：
 * loaded 才算确认，failed 是明确失败，unknown / unchanged / skipped 都不能报成功。
 */
function judgement(result: MutationShape): { tail: string; severity: Severity } {
  const stages = result.stages
  if (!stages) {
    // 旧版服务端不带 stages：只能说它自己的结论，必要时附上它的复核说明。
    return { tail: result.verification ?? "", severity: result.ok ? "ok" : "bad" }
  }

  const runtime = stages.runtime ?? "skipped"
  switch (stages.config) {
    case "failed":
      return { tail: "配置写入未完成", severity: "bad" }
    case "unchanged":
      // ok=true 时这是「没什么要改」（已装同版本、已经暂停过、本来就未禁用…），不是失败。
      return { tail: "配置未改动", severity: result.ok ? "ok" : "bad" }
    case "updated":
      switch (runtime) {
        case "loaded":
          return { tail: "配置已切换，运行时已确认", severity: "ok" }
        case "failed":
          // 最容易被误报成升级成功的一种：配置对了，插件没起来。
          return { tail: "配置已切换，但插件加载失败", severity: "bad" }
        case "unchanged":
          return { tail: "配置已切换，但运行时仍是旧状态", severity: "warn" }
        case "unknown":
          return { tail: "配置已切换，运行时未确认", severity: "warn" }
        default:
          return { tail: "配置已切换，运行时尚未验证", severity: "warn" }
      }
    default:
      return { tail: result.verification ?? "", severity: result.ok ? "ok" : "bad" }
  }
}

/**
 * 回滚是独立的一段：它的成败决定「用户现在的状态安不安全」，优先级高于上面任何一句。
 *
 * 回滚成功不等于操作成功（目标版本没跑起来），但也不该是错误——状态已经回到旧版本了，
 * 所以把语气封在 warning；回滚失败则是实打实的错误，必须让用户看见。
 */
function rollbackNote(stages: MutationShape["stages"]): { tail: string; severity: Severity | "" } {
  switch (stages?.rollback) {
    case "failed":
      return { tail: "回滚未成功，配置与运行时可能不一致，需要手动处理", severity: "bad" }
    case "succeeded":
      return { tail: "已回滚到原版本", severity: "warn" }
    default:
      return { tail: "", severity: "" }
  }
}

export function explainMutation(result: MutationShape, successTone: Tone = "success"): MutationReport {
  const verdict = judgement(result)
  const rollback = rollbackNote(result.stages)
  // 回滚一旦发生，它就是最终结论：成功封顶为 warning，失败直接盖成 error。
  const severity = rollback.severity === "" ? verdict.severity : rollback.severity
  const tail = [verdict.tail, rollback.tail].filter((part) => part.length > 0).join("；")

  const tone: Tone =
    severity === "bad"
      ? "error"
      : severity === "warn"
        ? "warning"
        : // 自升级配置已生效且运行时确认了，但这个窗口跑的还是旧构建：不能报「完成」。
          result.selfUpdated
          ? "warning"
          : successTone

  return { text: tail ? `${result.message}（${tail}）` : result.message, tone }
}
