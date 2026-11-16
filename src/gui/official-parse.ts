/**
 * Parsing for the two official read commands. Kept pure so the formats can be tested without a
 * running OpenCode, and tolerant so a new column or an extra section header does not silently turn
 * "cannot update" into "up to date".
 *
 * `opencode plugin list` (the runtime view):
 *
 *     ID                          VERSION  SOURCE
 *     plugin-hub                  0.4.0    opencode-plugin-hub@0.4.0
 *     opencode-notify-callback    0.1.2    opencode-mobile-notifications
 *     opencode-trae-auth-multi    local    /home/me/.config/opencode/local-plugins/trae-auth-multi
 *     -                           -        some-plugin
 *
 * `opencode plugin check` (the update view), grouped by the kind of plugin:
 *
 *     Server
 *       usage-center 0.2.0 (current)
 *       opencode-notify (check failed)
 */

export type PluginSourceKind = "package" | "path" | "unknown"

export interface PluginListRow {
  /** The ID the plugin actually loaded under; "" when the CLI printed `-` (not loaded). */
  id: string
  /** Version the runtime reports; "" when unknown. Local directories report `local`. */
  version: string
  /** The configured target: `pkg@1.2.3`, `pkg`, or a directory path. */
  source: string
  kind: PluginSourceKind
  /** Section the row appeared under (`Server`, `GUI`, `TUI`, or ""). */
  section: string
}

const ANSI = /\u001b\[[0-9;]*m/g
const LIST_HEADER = /^ID\s+VERSION\s+SOURCE$/i
const COLUMN_GAP = /\s{2,}/

export function isPathSource(source: string): boolean {
  const text = source.trim()
  if (text.length === 0) return false
  return text.startsWith("/") || text.startsWith("~/") || text.startsWith("./") || text.startsWith("../") || text === "~" || text === "." || text === ".."
}

/** Splits `@scope/name@1.2.3` into its package name, ignoring `@` inside the scope. */
export function packageNameOf(source: string): string {
  const text = source.trim()
  const scoped = text.startsWith("@")
  const at = text.indexOf("@", scoped ? 1 : 0)
  return at > 0 ? text.slice(0, at) : text
}

export function parsePluginList(output: string): PluginListRow[] {
  const rows: PluginListRow[] = []
  let section = ""
  for (const rawLine of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "")
    if (line.trim().length === 0) continue
    const trimmed = line.trim()
    if (LIST_HEADER.test(trimmed)) continue
    if (/^No plugins found/i.test(trimmed)) continue
    if (/^(Error|Warning):/i.test(trimmed)) continue

    let parts = line.split(COLUMN_GAP).filter((part) => part.trim().length > 0)
    if (parts.length < 3) {
      // A row written with single spaces (narrow terminal, or a future format change) still has
      // three fields; only a lone word is treated as a section title.
      const tokens = trimmed.split(/\s+/)
      if (tokens.length >= 3) parts = [tokens[0]!, tokens[1]!, tokens.slice(2).join(" ")]
      else {
        if (tokens.length === 1 && /^[A-Za-z][\w -]*$/.test(tokens[0]!)) section = tokens[0]!
        continue
      }
    }

    const id = parts[0]!.trim()
    const version = parts[1]!.trim()
    const source = parts.slice(2).join("  ").trim()
    const kind: PluginSourceKind = isPathSource(source) ? "path" : source.length > 0 ? "package" : "unknown"
    rows.push({
      // `-` is the CLI's way of saying "this configured entry did not load", not an ID.
      id: id === "-" ? "" : id,
      version: version === "-" ? "" : version,
      source,
      kind,
      section,
    })
  }
  return rows
}

export type CheckStatus = "current" | "outdated" | "failed" | "skipped" | "unknown"

export interface CheckRow {
  id: string
  /** Version currently installed, as the CLI reports it; "" when it does not say. */
  version: string
  /** Version the CLI would update to; "" unless the row says there is one. */
  latest: string
  status: CheckStatus
  /** The CLI's own words for anything that is not a plain version row. */
  note: string
  section: string
}

const VERSION_TOKEN = /\d+\.\d+[\w.+-]*/g
const ARROW = /(?:→|->|⇒|=>|\u2192)/

function firstVersion(text: string): string {
  VERSION_TOKEN.lastIndex = 0
  const match = VERSION_TOKEN.exec(text)
  return match?.[0] ?? ""
}

function lastVersion(text: string): string {
  const matches = [...text.matchAll(VERSION_TOKEN)]
  return matches.length > 0 ? matches[matches.length - 1]![0] : ""
}

/**
 * Parses the update check. A row is only reported as `outdated` when the CLI itself shows a second
 * version or says so; anything else stays `unknown` with the CLI's words attached, because guessing
 * "up to date" from an unrecognised line is exactly the failure mode this hub must avoid.
 */
export function parsePluginCheck(output: string): CheckRow[] {
  const rows: CheckRow[] = []
  const failures = new Map<string, string>()
  let section = ""

  for (const rawLine of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "")
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (/^No plugin updates available/i.test(trimmed)) continue

    // `Failed to check Server plugin "id": reason` — a per-plugin failure announced out of band.
    const failure = /^Failed to check\s+\w+\s+plugin\s+"([^"]+)":\s*(.*)$/i.exec(trimmed)
    if (failure) {
      failures.set(failure[1]!, failure[2]?.trim() ?? "")
      continue
    }

    if (!/^\s/.test(line)) {
      // Unindented, no failure prefix: a section title such as `Server`.
      if (/^[A-Za-z][\w -]*$/.test(trimmed)) section = trimmed
      continue
    }

    const tokens = trimmed.split(/\s+/)
    if (tokens.length < 2) continue
    const id = tokens[0]!
    const rest = tokens.slice(1).join(" ")

    if (/\(check failed\)/i.test(rest)) {
      rows.push({ id, version: "", latest: "", status: "failed", note: failures.get(id) ?? "", section })
      continue
    }
    if (/\(skipped/i.test(rest) || /skipp(ed|ing)/i.test(rest)) {
      rows.push({ id, version: firstVersion(rest), latest: "", status: "skipped", note: rest, section })
      continue
    }
    if (ARROW.test(rest)) {
      const [before, after] = rest.split(ARROW)
      rows.push({
        id,
        version: firstVersion(before ?? ""),
        latest: firstVersion(after ?? "") || lastVersion(rest),
        status: "outdated",
        note: rest,
        section,
      })
      continue
    }
    if (/\(current\)/i.test(rest)) {
      rows.push({ id, version: firstVersion(rest), latest: "", status: "current", note: "", section })
      continue
    }
    if (/\(outdated\b/i.test(rest) || /update available/i.test(rest)) {
      rows.push({ id, version: firstVersion(rest), latest: lastVersion(rest), status: "outdated", note: rest, section })
      continue
    }
    rows.push({ id, version: firstVersion(rest), latest: "", status: "unknown", note: rest, section })
  }

  // A failure line can come after its row (`(check failed)` first, reason later, or the other way
  // round), so the reason is attached at the end rather than only when the row is created.
  for (const [id, note] of failures) {
    const row = rows.find((item) => item.id === id)
    if (row) {
      if (!row.note) row.note = note
      if (row.status !== "failed" && note) {
        row.status = "failed"
        row.latest = ""
      }
      continue
    }
    rows.push({ id, version: "", latest: "", status: "failed", note, section })
  }
  return rows
}

/** `opencode plugin update` says what it updated, or that there was nothing to do. */
export interface UpdateReport {
  /** IDs or specs the CLI said it updated. */
  updated: string[]
  /** Whether the CLI said there was nothing to update. */
  none: boolean
  /** Per-plugin failures the CLI printed. */
  failures: { id: string; reason: string }[]
}

export function parsePluginUpdate(output: string): UpdateReport {
  const updated: string[] = []
  const failures: { id: string; reason: string }[] = []
  let none = false
  for (const rawLine of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (/^No plugin updates available/i.test(line)) {
      none = true
      continue
    }
    const failure = /^Failed to (?:check|update)\s+\w+\s+plugin\s+"([^"]+)":\s*(.*)$/i.exec(line)
    if (failure) {
      failures.push({ id: failure[1]!, reason: failure[2]?.trim() ?? "" })
      continue
    }
    const done = /^(?:Updated|Updating)\s+(.+?)(?:\s+to\s+\S+)?$/i.exec(line)
    if (done) {
      updated.push(done[1]!.trim().replace(/^"|"$/g, ""))
      continue
    }
    const bare = /^([@\w][\w./@-]*)\s+(\d+\.\d+[\w.+-]*)\s*(?:→|->)\s*(\d+\.\d+[\w.+-]*)$/.exec(line)
    if (bare) updated.push(bare[1]!)
  }
  return { updated, none, failures }
}
