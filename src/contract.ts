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
  /** Downloads in the last week. */
  weekly: Schema.Number,
  /** Downloads in the last month. */
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
  weekly: Schema.Number,
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

/** One row of the update check performed against the npm registry. */
export const UpdateInfo = Schema.Struct({
  spec: Schema.String,
  /** Real package name; for a directory plugin this comes from its package.json. */
  name: Schema.String,
  kind: Schema.String,
  current: Schema.String,
  latest: Schema.String,
  hasUpdate: Schema.Boolean,
  /** False for directory plugins, whose files are replaced instead of re-resolved from the registry. */
  managed: Schema.Boolean,
  error: Schema.String,
})

export const UpdatesResult = Schema.Struct({
  items: Schema.Array(UpdateInfo),
  error: Schema.String,
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

export const Mutation = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  state: HubState,
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
    remove: { input: Target, output: Mutation },
    reload: { output: Mutation },
    restart: { output: Opened },
  },
})
