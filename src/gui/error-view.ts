/**
 * 操作异常的可读分类（TASK-06，纯函数）。
 *
 * 把底层错误翻译成用户能理解的一句话，但**保留**底层原因（附在括号里），
 * 不把不同异常都压成同一个「操作失败」。分类只影响文案，不改变任何状态或配置。
 *
 * 注意：这里只处理“前端 catch 到的异常文本”。后端已经返回结构化 stages 的失败
 * 由 feedback.explainMutation 负责，二者不重复。
 */

export type ErrorKind =
  | "schema-mismatch"
  | "ipc-unavailable"
  | "network"
  | "permission"
  | "config"
  | "version"
  | "unknown"

export interface ClassifiedError {
  kind: ErrorKind
  text: string
}

/** 分类并给出可读文案；底层原文附在括号里，不丢诊断信息。 */
export function classifyError(error: unknown): ClassifiedError {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.trim()

  // 解码失败：返回的数据结构与插件期望的不一致。这只能证明「结构对不上」，
  // 不能证明一定存在版本不一致，官方也没有给出「必须重载」的结论。
  // 因此如实说明结构不兼容、保留原始错误，把重新加载作为人工排查建议。
  if (/SchemaError|Missing key at/i.test(text)) {
    return {
      kind: "schema-mismatch",
      text: `接口返回的数据结构与插件期望的不一致（${text}）。可尝试重新加载 OpenCode 插件；如果仍然出现，请重新启动 OpenCode。这只是人工排查建议，不代表已确认版本不一致，也不代表必须重载。`,
    }
  }
  // 官方 IPC 契约自己返回的故障：Provider 未注册 / 方法不存在（含
  // `Ipc "..." is unavailable: no method "..."`）。只陈述官方返回的真实错误并给出
  // 人工恢复选项，不推断「必须重启客户端」、不归咎 npm Registry、也不自动重载。
  if (/is unavailable|no method\b|no such method|unknown method|method.*not.*found|not implemented|no provider\b/i.test(text)) {
    return {
      kind: "ipc-unavailable",
      text: `插件接口暂不可用：当前客户端未能找到插件所需的 IPC 方法（${text}）。请尝试重新加载 OpenCode 插件；如果仍然出现，请重新启动 OpenCode。这只是故障恢复建议，不代表系统已经确认必须重启。`,
    }
  }
  // 网络 / registry 不可达。
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|Unable to connect|network/i.test(text)) {
    return { kind: "network", text: `网络或 npm registry 无法访问，未能完成操作（${text}）。可检查网络或设置 OPENCODE_PLUGIN_HUB_REGISTRY 指向可用镜像。` }
  }
  // 权限不足。
  if (/EACCES|EPERM|permission denied|read-only file system|EROFS/i.test(text)) {
    return { kind: "permission", text: `没有权限写入配置或缓存，操作未完成（${text}）。请检查文件权限后重试。` }
  }
  // 配置解析/写入异常。
  if (/配置.*(解析|无法解析|写入|被改动|并发)|parse error|unexpected token|jsonc/i.test(text)) {
    return { kind: "config", text: `配置文件异常，为避免损坏配置未做修改（${text}）。` }
  }
  // 版本解析/不存在。
  if (/No matching version|版本.*(无效|不存在|无法)|invalid version/i.test(text)) {
    return { kind: "version", text: `版本信息不可用或版本不存在（${text}）。请换一个版本重试。` }
  }
  return { kind: "unknown", text }
}

/** 兼容原 page.tsx 的调用：只要可读文案。 */
export function readableErrorText(error: unknown): string {
  return classifyError(error).text
}
