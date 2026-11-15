/**
 * Release guard for .github/workflows/publish.yml.
 *
 * Runs before `npm ci` and before `npm publish`. It is deliberately fail-closed:
 *   - workflow_dispatch is accepted only from refs/heads/main;
 *   - the release version must be a SemVer string and match package.json exactly,
 *     coming from the v* tag on a tag push or from the input on a manual run;
 *   - the registry must answer with a definite HTTP 404 (version not published).
 *
 * The previous check used `npm view` and treated ANY non-zero exit as "not published".
 * npm folds 404, 5xx, 401/403, timeouts and socket errors into the same exit code, so a
 * temporarily broken registry silently skipped the duplicate-version check. Here the HTTP
 * status is read directly: 404 allows, 200 blocks, everything else (including a network
 * failure or timeout) blocks with an explicit reason.
 *
 * No third-party dependencies: Node's built-in fetch and AbortSignal.timeout only.
 * NPM_REGISTRY_BASE and NPM_LOOKUP_TIMEOUT_MS exist so the guard can be pointed at a local
 * server in tests; production uses registry.npmjs.org with a 15s timeout.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const env = process.env

function fail(message) {
  console.error(`Release guard FAILED: ${message}`)
  process.exit(1)
}

function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function main() {
  const event = env.GITHUB_EVENT_NAME ?? ""
  const ref = env.GITHUB_REF ?? ""
  const refType = env.GITHUB_REF_TYPE ?? ""
  const refName = env.GITHUB_REF_NAME ?? ""
  const isDispatch = event === "workflow_dispatch"
  const isTagPush = event === "push" && refType === "tag"

  // Anything else (PR, schedule, an unexpected ref type) is refused rather than guessed at.
  if (!isDispatch && !isTagPush) {
    fail(`unsupported trigger: event=${event || "(empty)"}, refType=${refType || "(empty)"}. Only a v* tag push or workflow_dispatch is allowed.`)
  }

  // 1. Manual releases ship main and only main. Tag pushes keep their original path: the
  //    tag's own commit is checked out and published, whatever branch it happens to sit on.
  if (isDispatch && ref !== "refs/heads/main") {
    fail(`workflow_dispatch is only allowed from refs/heads/main, got ${ref || "(empty)"}. Re-run the workflow from the main branch.`)
  }

  // 2. Version source (tag name / manual input), SemVer shape, agreement with package.json.
  const expected = (isTagPush ? refName.replace(/^v/, "") : (env.INPUT_VERSION ?? "").trim()).trim()
  const source = isTagPush ? `tag ${refName}` : "workflow_dispatch input"
  if (!expected) fail(`no release version supplied (${source}); a manual run needs the version input.`)
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(expected)) {
    fail(`'${expected}' is not a valid SemVer version (from ${source}).`)
  }
  if (expected !== pkg.version) {
    fail(`${source} says ${expected} but package.json is ${pkg.version}.`)
  }

  // 3. Version occupancy. Only a definite 404 means "free to publish"; every other answer
  //    (200, 5xx, 401/403, 429, timeout, DNS/TLS/socket failure) is a hard stop.
  const base = (env.NPM_REGISTRY_BASE ?? "https://registry.npmjs.org").replace(/\/+$/, "")
  const timeoutMs = Number.parseInt(env.NPM_LOOKUP_TIMEOUT_MS ?? "15000", 10) || 15_000
  const url = `${base}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(expected)}`
  let status
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    })
    status = response.status
    // The body is irrelevant to the decision; close the socket promptly.
    await response.body?.cancel().catch(() => undefined)
  } catch (error) {
    fail(`cannot confirm whether ${pkg.name}@${expected} is published: registry lookup failed (${describe(error)}). Refusing to publish rather than skipping the check.`)
  }
  if (status === 404) {
    console.log(`Version ${expected} is not on npm (HTTP 404) - safe to publish.`)
  } else if (status === 200) {
    fail(`${pkg.name}@${expected} is already published (HTTP 200); refusing to republish.`)
  } else {
    fail(`cannot confirm whether ${pkg.name}@${expected} is published: registry returned HTTP ${status}. Timeouts, 5xx, auth errors and other anomalies all block the release.`)
  }
  console.log(`Release version verified: ${expected} (from ${source}, ref ${ref || "(empty)"}).`)
}

await main().catch((error) => fail(`unexpected error during release verification: ${describe(error)}`))
