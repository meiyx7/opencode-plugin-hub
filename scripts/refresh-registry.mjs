#!/usr/bin/env node
/**
 * Rebuilds src/gui/registry-snapshot.json from the community curated list, verifying every
 * candidate package name against the npm registry so the bundled snapshot never points at a
 * package that does not exist.
 *
 * Run with: npm run refresh
 */
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const SOURCE = "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json"
const FALLBACK = "https://raw.githubusercontent.com/Gracdjd/awesome-opencode/main/dist/registry.json"
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "gui", "registry-snapshot.json")

const installPattern = /"plugin"\s*:\s*\[\s*"([^"]+)"/
const packagePattern = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const KEEP = new Set(["plugins", "mcp", "themes"])
const CONCURRENCY = 8

async function getJson(url, timeout = 20_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}

/**
 * The official registry is blackholed on some networks, so package verification probes the same
 * mirror the runtime uses. Verification is a best-effort part of this script: a name that cannot
 * be checked is left without a version rather than guessed.
 */
const REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"]
let registry

async function pickRegistry() {
  if (registry) return registry
  const answers = await Promise.all(
    REGISTRIES.map(async (base) => {
      try {
        const response = await fetch(`${base}/-/ping`, { signal: AbortSignal.timeout(1_500) })
        return response.ok ? base : undefined
      } catch {
        return undefined
      }
    }),
  )
  registry = answers.find((base) => base !== undefined)
  if (!registry) throw new Error(`无法连接 npm registry（已尝试 ${REGISTRIES.join("、")}）`)
  return registry
}

function candidates(entry) {
  const parts = (entry.repoUrl ?? "").replace(/\/+$/, "").split("/")
  const repo = (parts.pop() ?? "").replace(/\.git$/, "")
  const owner = parts.pop() ?? ""
  const raw = [...installPattern.exec(entry.installation ?? "")?.slice(1) ?? []]
  const display = (entry.displayName ?? "").trim()
  if (packagePattern.test(display) && !display.includes(" ")) raw.push(display)
  raw.push(repo)
  if (owner) raw.push(`@${owner}/${repo}`, `@${owner.toLowerCase()}/${repo}`, `@${owner.toLowerCase()}/${repo.toLowerCase()}`)
  const seen = new Set()
  const out = []
  for (const name of raw) {
    const trimmed = name.trim()
    if (!trimmed || !packagePattern.test(trimmed)) continue
    for (const variant of [trimmed, trimmed.toLowerCase()]) {
      if (!seen.has(variant)) {
        seen.add(variant)
        out.push(variant)
      }
    }
  }
  return out
}

/**
 * A package can exist with no `latest` tag (published once and abandoned), so presence is judged
 * by a successful lookup, while preference goes to the candidate that did publish a `latest`.
 */
async function npmLookup(name) {
  try {
    const base = await pickRegistry()
    const body = await getJson(`${base}/${encodeURIComponent(name)}`, 10_000)
    const tagged = body["dist-tags"]?.latest
    if (tagged) return { name, version: tagged, released: true }
    const versions = Object.keys(body.versions ?? {})
    return versions.length > 0 ? { name, version: versions[versions.length - 1], released: false } : undefined
  } catch {
    return undefined
  }
}

async function resolve(entry) {
  let fallback
  for (const name of candidates(entry)) {
    const hit = await npmLookup(name)
    if (!hit) continue
    if (hit.released) return hit
    fallback ??= hit
  }
  return fallback
}

async function mapLimit(items, limit, work) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await work(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

async function main() {
  let list
  try {
    list = await getJson(SOURCE)
  } catch (error) {
    console.warn(`upstream unavailable (${error.message}), trying the fork`)
    list = await getJson(FALLBACK)
  }
  const targets = list.filter((entry) => KEEP.has(entry.type))
  console.log(`catalog: ${list.length} entries, ${targets.length} keepable`)

  let done = 0
  const resolved = await mapLimit(targets, CONCURRENCY, async (entry) => {
    const hit = await resolve(entry)
    done += 1
    if (done % 20 === 0) process.stdout.write(`  ${done}/${targets.length}\r`)
    return hit
  })

  const out = targets.map((entry, index) => {
    const hit = resolved[index]
    return {
      name: entry.displayName ?? hit?.name ?? entry.repoUrl,
      pkg: hit?.name ?? "",
      ver: hit?.version ?? "",
      type: entry.type,
      desc: (entry.tagline ?? "").trim(),
      long: (entry.description ?? "").trim().slice(0, 300),
      repo: entry.repoUrl,
      tags: (entry.tags ?? []).slice(0, 6),
    }
  })

  const installable = out.filter((entry) => entry.pkg).length
  await writeFile(OUT, JSON.stringify(out), "utf8")
  console.log(`\nwrote ${out.length} entries (${installable} installable from npm) -> src/gui/registry-snapshot.json`)
}

await main()
