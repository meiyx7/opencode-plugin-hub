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
  | "version-mismatch"
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

  // 窗口 bundle 与后台 service 版本不一致：说清要重载，而不是甩 SchemaError 给用户。
  if (/SchemaError|Missing key at/i.test(text)) {
    return { kind: "version-mismatch", text: "插件窗口与后台服务版本不一致，需要 OpenCode 重新加载（插件中心不重启宿主）。" }
  }
  if (/unknown method|not implemented|no such method|method.*not.*found/i.test(text)) {
    return { kind: "version-mismatch", text: "后台服务还在跑旧版本，没有这个接口。请让 OpenCode 重新加载插件后重试。" }
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
