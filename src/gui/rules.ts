/**
 * OpenCode's plugin control rules, as configured in the `plugins` array.
 *
 * From the official documentation: "Plugin entries are processed in order. Prefix an ID or wildcard
 * with `-` to disable it, use `*` for every plugin, and use `.*` to match an ID prefix. A later ID
 * re-enables a plugin."
 *
 *     ["*", "-opencode.provider.*", "opencode.provider.openai", "-acme.reviewer"]
 *
 * The hub only ever *appends* rules, so the user's own ordering and precedence stay intact, and it
 * never removes a wildcard: those are the user's, not ours.
 */

/** One dot-separated part of a plugin id: `acme`, `reviewer`, `opencode-notify`. */
const ID_PART = /^[a-z0-9_-]+$/i

/**
 * Drops a leading `@scope/` from a plugin id. Returns `null` when the entry carries an npm version
 * suffix (`foo@*`, `@scope/foo@1.2.3`): there the text after `@` is a version range, so the entry
 * installs a package instead of being a rule.
 */
function stripScope(id: string): string | null {
  if (!id.startsWith("@")) return id.includes("@") ? null : id
  const slash = id.indexOf("/")
  if (slash < 0) return null
  const rest = id.slice(slash + 1)
  return rest.includes("@") ? null : rest
}

/** A bare plugin id with no version: `acme`, `acme.reviewer`, `@scope/foo`. */
export function isBarePluginId(id: string): boolean {
  const unscoped = stripScope(id)
  if (unscoped === null || unscoped.length === 0) return false
  return unscoped.split(".").every((part) => ID_PART.test(part))
}

/** A wildcard plugin id: `*`, `.*`, `acme.*`, `acme.reviewer.*`, `@scope/acme.*`. */
export function isWildcardPluginId(id: string): boolean {
  const unscoped = stripScope(id)
  if (unscoped === null) return false
  if (unscoped === "*" || unscoped === ".*") return true
  if (!unscoped.endsWith(".*")) return false
  const prefix = unscoped.slice(0, -2)
  return prefix.length > 0 && prefix.split(".").every((part) => ID_PART.test(part))
}

/**
 * A config control entry instead of a plugin, using OpenCode's own syntax: `-id` disables a plugin,
 * while `*`, `.*`, `acme.*` and `-acme.*` are wildcards. These are user rules, not installable
 * packages, so they are shown as rules and are never resolved, updated or sent to the registry.
 *
 * `foo@*` and `@scope/foo@*` are deliberately *not* control entries: `@` starts a version range
 * there, so they install (or pin) a package and their `*` has nothing to do with wildcards.
 */
export function isControlSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed.length === 0) return false
  const negated = trimmed.startsWith("-")
  const body = negated ? trimmed.slice(1) : trimmed
  if (body.length === 0) return false
  return negated ? isBarePluginId(body) || isWildcardPluginId(body) : isWildcardPluginId(body)
}

export type RuleScope = "all" | "prefix" | "exact"

export interface ControlRule {
  /** Position in the `plugins` array; later positions win. */
  index: number
  /** The entry exactly as written. */
  raw: string
  /** True when the rule disables (`-`), false when it enables. */
  negate: boolean
  /** The id or prefix the rule targets, with the leading `-` removed. */
  target: string
  scope: RuleScope
}

function ruleScope(body: string): RuleScope {
  if (body === "*" || body === ".*") return "all"
  if (body.endsWith(".*")) return "prefix"
  return "exact"
}

/** Parses one config entry as a control rule, or returns undefined when it is not one. */
export function parseControl(entry: string, index: number): ControlRule | undefined {
  if (!isControlSpec(entry)) return undefined
  const trimmed = entry.trim()
  const negate = trimmed.startsWith("-")
  const body = negate ? trimmed.slice(1) : trimmed
  return { index, raw: entry, negate, target: body, scope: ruleScope(body) }
}

/**
 * Whether a rule covers a plugin id. Prefix wildcards match the id itself and everything below it
 * (`opencode.provider.*` covers `opencode.provider.openai`), which is how the docs describe them.
 */
export function ruleMatches(rule: ControlRule, id: string): boolean {
  const wanted = id.trim().toLowerCase()
  if (wanted.length === 0) return false
  const target = rule.target.toLowerCase()
  if (rule.scope === "all") return true
  if (rule.scope === "prefix") {
    const prefix = target.slice(0, -2)
    return wanted === prefix || wanted.startsWith(`${prefix}.`)
  }
  return wanted === target
}

export interface RuleVerdict {
  /** True when the last matching rule disables the plugin. */
  disabled: boolean
  /** The rule that decided it; undefined when no rule mentions the plugin at all. */
  rule?: ControlRule
  /** Every rule that mentions the plugin, in config order. */
  matches: ControlRule[]
}

/** The package name (or path) an entry installs, without its version range. */
function entryName(entry: string): string {
  const trimmed = entry.trim()
  const scoped = trimmed.startsWith("@")
  const at = trimmed.indexOf("@", scoped ? 1 : 0)
  return at > 0 ? trimmed.slice(0, at) : trimmed
}

/**
 * Runs the rules over one plugin id. Absence of a match means "no rule speaks about this plugin",
 * which is reported as such instead of being folded into "enabled".
 *
 * A plain entry that names this very ID counts too: the docs call it the "a later ID re-enables a
 * plugin" form, and it is also what a configured package entry does for its own plugin. Without
 * this, a plugin re-enabled by naming it again would still read as disabled.
 */
export function evaluateRules(entries: readonly unknown[], id: string): RuleVerdict {
  const wanted = id.trim().toLowerCase()
  const matches: ControlRule[] = []
  if (wanted.length === 0) return { disabled: false, rule: undefined, matches }
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string") continue
    const rule = parseControl(entry, index)
    if (rule) {
      if (ruleMatches(rule, id)) matches.push(rule)
      continue
    }
    if (entryName(entry).toLowerCase() === wanted) {
      matches.push({ index, raw: entry, negate: false, target: id.trim(), scope: "exact" })
    }
  }
  const deciding = matches[matches.length - 1]
  return { disabled: deciding ? deciding.negate : false, rule: deciding, matches }
}

/**
 * Exact *disabling* rules naming one of the given ids — the only rules a resume may delete.
 * Positive entries are deliberately excluded: removing one would delete the plugin itself.
 */
export function exactRulesFor(entries: readonly unknown[], ids: readonly string[]): ControlRule[] {
  const wanted = new Set(ids.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0))
  if (wanted.size === 0) return []
  const out: ControlRule[] = []
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string") continue
    const rule = parseControl(entry, index)
    if (!rule || rule.scope !== "exact" || !rule.negate) continue
    if (wanted.has(rule.target.toLowerCase())) out.push(rule)
  }
  return out
}

/** The rule the hub appends to disable a plugin. Appended last so it wins over earlier rules. */
export function disableRule(id: string): string {
  return `-${id}`
}

/** The rule the hub appends to re-enable a plugin a wildcard still disables. */
export function enableRule(id: string): string {
  return id
}
