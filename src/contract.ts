import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

/** One entry of the `plugins` array in opencode.json. */
export const InstalledEntry = Schema.Struct({
  /** The raw string as written in the config, e.g. `opencode-qoder-bridge` or `/abs/path`. */
  spec: Schema.String,
  /** The package (or directory) name without a version range. */
  name: Schema.String,
  /** `package` for a registry package, `path` for a local directory. */
  kind: Schema.String,
  /** Installed version, or an empty string when it cannot be read. */
  version: Schema.String,
  /** False for the plugin that serves this page, which cannot remove itself. */
  removable: Schema.Boolean,
  /**
   * One-line summary from the installed package.json, empty when it cannot be read.
   * Optional so a window and a service built from different revisions still decode each other.
   */
  description: Schema.optional(Schema.String),
  /** SPDX license from the installed package.json; empty when unknown. */
  license: Schema.optional(Schema.String),
  homepage: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  /** Runtime plugin ID the host reports for this entry; empty when it is not loaded. */
  id: Schema.optional(Schema.String),
  /** True when the entry is a bare-ID rule this hub appended to re-enable a plugin. */
  rule: Schema.optional(Schema.Boolean),
  /** True when the entry is `{package, options}`; the options are preserved by every edit. */
  options: Schema.optional(Schema.Boolean),
})

export const HubState = Schema.Struct({
  configPath: Schema.String,
  configKey: Schema.String,
  plugins: Schema.Array(InstalledEntry),
  error: Schema.String,
})

export const SearchHit = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  /** Publish date of the latest version, ISO 8601. */
  published: Schema.String,
  /**
   * Legacy alias of `published`, kept on the wire so a window and a service running
   * different builds of this plugin can still decode each other's search results.
   */
  updated: Schema.String,
  installed: Schema.Boolean,
  /** Version on disk, empty when it cannot be read. */
  current: Schema.String,
  /** True when the registry has a newer version than the installed one. */
  hasUpdate: Schema.Boolean,
  /** Official npm downloads in the last week; `-1` when the point API could not be asked. */
  weekly: Schema.Number,
  /** Official npm downloads in the last month; `-1` when the point API could not be asked. */
  monthly: Schema.Number,
  publisher: Schema.String,
  license: Schema.String,
  keywords: Schema.Array(Schema.String),
  homepage: Schema.String,
  repo: Schema.String,
  npm: Schema.String,
})

/** Everything the detail dialog shows about one npm package. */
export const PackageDetail = Schema.Struct({
  name: Schema.String,
  /** Latest published version. */
  version: Schema.String,
  description: Schema.String,
  homepage: Schema.String,
  repo: Schema.String,
  /** Monorepo subdirectory, e.g. `packages/trae`. */
  repoDir: Schema.String,
  npm: Schema.String,
  bugs: Schema.String,
  license: Schema.String,
  keywords: Schema.Array(Schema.String),
  maintainers: Schema.Array(Schema.String),
  /** Weekly downloads; `-1` when the download API could not be asked. */
  weekly: Schema.Number,
  /** Monthly downloads; `-1` when the download API could not be asked. */
  monthly: Schema.Number,
  /** Publish date of the latest version, ISO 8601. */
  published: Schema.String,
  /** First publish date of the package, ISO 8601. */
  created: Schema.String,
  versions: Schema.Number,
  /** Unpacked size of the latest tarball, in bytes. */
  unpacked: Schema.Number,
  files: Schema.Number,
  /** Direct dependencies, as `name@range`. */
  dependencies: Schema.Array(Schema.String),
  /** Deprecation notice of the latest version; empty when it is not deprecated. */
  deprecated: Schema.String,
  readme: Schema.String,
  /** True when the README was cut because it was too long. */
  readmeTruncated: Schema.Boolean,
  installed: Schema.Boolean,
  current: Schema.String,
  hasUpdate: Schema.Boolean,
  /** Empty on success. */
  error: Schema.String,
})

/** One row of the update check performed by `opencode plugin check`. */
export const UpdateInfo = Schema.Struct({
  spec: Schema.String,
  /** Real package name; for a directory plugin this comes from its package.json. */
  name: Schema.String,
  /** Runtime plugin ID the CLI used in its own report; empty when the plugin is not loaded. */
  id: Schema.optional(Schema.String),
  kind: Schema.String,
  current: Schema.String,
  /** Newer version the CLI named; empty when it did not name one. */
  latest: Schema.String,
  /** True only when the official check reports an update; the registry never sets this. */
  hasUpdate: Schema.Boolean,
  /** What the official check said: current, outdated, failed, skipped or unknown. */
  official: Schema.optional(Schema.String),
  /** Why this row cannot be updated, in words; empty when it is current or updatable. */
  reason: Schema.optional(Schema.String),
  /** False for directory plugins, which the official npm flow never touches. */
  managed: Schema.Boolean,
  /** True when the config pins an exact version, which the CLI deliberately leaves alone. */
  pinned: Schema.optional(Schema.Boolean),
  /** One-line summary from the package manifest; empty when it cannot be read. */
  description: Schema.optional(Schema.String),
  /** SPDX license from the package manifest; empty when unknown. */
  license: Schema.optional(Schema.String),
  homepage: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  /** Publisher or first maintainer from the registry; empty for local directories. */
  publisher: Schema.optional(Schema.String),
  error: Schema.String,
})

export const UpdatesResult = Schema.Struct({
  items: Schema.Array(UpdateInfo),
  error: Schema.String,
  /** False when the check never ran; per-row results then carry no meaning. */
  checked: Schema.optional(Schema.Boolean),
  /** The CLI's own words when the whole check failed. */
  raw: Schema.optional(Schema.String),
})

export const SearchResult = Schema.Struct({
  hits: Schema.Array(SearchHit),
  error: Schema.String,
})

/** One row of the curated community catalog. */
export const CatalogEntry = Schema.Struct({
  name: Schema.String,
  /** Empty when the project is only distributed through GitHub, not npm. */
  pkg: Schema.String,
  version: Schema.String,
  type: Schema.String,
  desc: Schema.String,
  long: Schema.String,
  repo: Schema.String,
  tags: Schema.Array(Schema.String),
  installed: Schema.Boolean,
})

export const CatalogResult = Schema.Struct({
  entries: Schema.Array(CatalogEntry),
  /** `network`, `cache` or `builtin`. */
  source: Schema.String,
  /** The registry URL the entries came from. Optional for older cached results. */
  registry: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
  error: Schema.String,
})

export const Browse = Schema.Struct({
  /** Skip the on-disk cache and hit the network. */
  force: Schema.Boolean,
})

export const Url = Schema.Struct({
  url: Schema.String,
})

export const Opened = Schema.Struct({
  ok: Schema.Boolean,
})

/**
 * Every mutation answers four separate questions instead of one `ok`. A run can succeed at the
 * command, change the config, and still leave the runtime unconfirmed — collapsing that into a
 * single boolean is how "配置写入成功" ends up being displayed as "插件已加载".
 */
export const MutationStages = Schema.Struct({
  /** What the official CLI command itself did. */
  command: Schema.Union([Schema.Literal("succeeded"), Schema.Literal("failed"), Schema.Literal("skipped")]),
  /** Whether the configuration ended up the way the operation intended. */
  config: Schema.Union([Schema.Literal("updated"), Schema.Literal("unchanged"), Schema.Literal("failed")]),
  /** Whether the host confirmed it loaded the plugin. `unknown` is not a success. */
  runtime: Schema.Union([
    Schema.Literal("loaded"),
    Schema.Literal("failed"),
    Schema.Literal("unknown"),
    Schema.Literal("unchanged"),
    Schema.Literal("skipped"),
  ]),
  /** Only set when a failed operation tried to put the previous state back. */
  rollback: Schema.optional(
    Schema.Union([Schema.Literal("none"), Schema.Literal("succeeded"), Schema.Literal("failed")]),
  ),
  /** Version the config ended up naming; empty when it names none. */
  version: Schema.optional(Schema.String),
})

export const Mutation = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  state: HubState,
  /**
   * True when the mutation replaced this plugin itself (a self-update). This window still
   * renders the previous bundle, so the UI must say the running build is stale and leave
   * loading to OpenCode's own mechanism — the hub never restarts the host.
   * Optional so a window and a service built from different revisions still decode each other.
   */
  selfUpdated: Schema.optional(Schema.Boolean),
  /** What the config, the CLI and the runtime each reported after the operation. */
  verification: Schema.optional(Schema.String),
  /** 分阶段结论；optional，旧窗口与新服务混跑时仍能互相解码。 */
  stages: Schema.optional(MutationStages),
})

/** One configured plugin's runtime truth as the running server reports it. */
export const RuntimeInfo = Schema.Struct({
  spec: Schema.String,
  name: Schema.String,
  /** Runtime plugin ID; empty when the host did not load it (or printed `-`). */
  id: Schema.optional(Schema.String),
  /**
   * "loaded" (the host runs it), "failed" (it reports an error), "unknown" (no runtime answer),
   * or "control" (a config rule, not a plugin package).
   */
  status: Schema.Union([
    Schema.Literal("loaded"),
    Schema.Literal("failed"),
    Schema.Literal("unknown"),
    Schema.Literal("control"),
  ]),
  /** Version the running server loaded, empty when unknown. */
  runtimeVersion: Schema.String,
  /** The server's failure message for a plugin that failed to load. */
  error: Schema.String,
  /** True when a runtime source answered; false when none could be asked. */
  available: Schema.Boolean,
  /** True when config rules currently disable this plugin. */
  paused: Schema.optional(Schema.Boolean),
  /** The rule that decides the enabled/disabled verdict, as written in the config. */
  rule: Schema.optional(Schema.String),
  /** Whether an exact `-<id>` line or a wildcard decided it; empty when nothing disables it. */
  pausedBy: Schema.optional(
    Schema.Union([Schema.Literal("exact"), Schema.Literal("wildcard"), Schema.Literal("")]),
  ),
  /** Every rule that mentions this plugin, in config order. */
  rules: Schema.optional(Schema.Array(Schema.String)),
})

/** A plugin the runtime reports that the global config does not list (discovery directories). */
export const DiscoveredPlugin = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  source: Schema.String,
  section: Schema.String,
})

export const RuntimeResult = Schema.Struct({
  items: Schema.Array(RuntimeInfo),
  discovered: Schema.optional(Schema.Array(DiscoveredPlugin)),
  error: Schema.String,
})

export const Target = Schema.Struct({
  spec: Schema.String,
  version: Schema.String,
})

export const Query = Schema.Struct({
  query: Schema.String,
})

export const DetailQuery = Schema.Struct({
  name: Schema.String,
})

/** The bridge between this plugin's window page and its main-process file access. */
export const Admin = Ipc.define({
  id: "plugin-hub.admin",
  methods: {
    snapshot: { output: HubState },
    updates: { output: UpdatesResult },
    search: { input: Query, output: SearchResult },
    detail: { input: DetailQuery, output: PackageDetail },
    browse: { input: Browse, output: CatalogResult },
    openUrl: { input: Url, output: Opened },
    openConfig: { output: Opened },
    install: { input: Target, output: Mutation },
    update: { input: Target, output: Mutation },
    remove: { input: Target, output: Mutation },
    pause: { input: Target, output: Mutation },
    resume: { input: Target, output: Mutation },
    reload: { output: Mutation },
    runtime: { output: RuntimeResult },
  },
})
