import { Command, Plugin, SettingsPage, TitlebarItem } from "@opencode/plugin/gui"
import { Admin } from "./contract"
import * as admin from "./gui/admin"
import * as catalog from "./gui/catalog"
import { PluginHubDialog, PluginHubPage } from "./gui/page"

export default Plugin.define({
  setup(ctx) {
    const bridge = ctx.main(Admin)

    // One entry point for the titlebar pill and the global shortcut: a standalone
    // x-large dialog, so the hub is not just a tab buried inside Settings.
    const openHub = () => {
      if (ctx.dialogs.active()) return
      ctx.dialogs.open((dialog) => (
        <PluginHubDialog ctx={ctx} admin={bridge} onClose={() => dialog.close()} />
      ))
    }

    ctx.add(SettingsPage, {
      id: "hub",
      title: "插件中心",
      icon: "extensions",
      entries: [
        {
          id: "hub",
          title: "插件中心",
          description: "浏览社区精选插件，按 npm 搜索，安装或移除",
          keywords: "plugin npm install remove hub catalog marketplace",
        },
      ],
      render: () => <PluginHubPage ctx={ctx} admin={bridge} />,
    })

    // The SDK has no left-sidebar navigation registry, so the closest always-visible
    // entry is a titlebar pill. The shortcut makes it reachable without leaving the keyboard.
    ctx.add(TitlebarItem, (): TitlebarItem => ({
      id: "hub",
      label: "插件中心",
      title: "打开插件中心",
      icon: "extensions",
      run: openHub,
    }))

    ctx.add(Command, (): Command => ({
      id: "open",
      title: "插件中心",
      description: "浏览、搜索、安装与更新 OpenCode 插件",
      keywords: "plugin hub install browse npm catalog marketplace",
      group: "设置",
      section: "navigation",
      bind: "mod+alt+p",
      featured: true,
      run: openHub,
    }))
  },

  main(ctx) {
    // Every package operation goes through the host's own CLI; the hub never shells out to npm.
    admin.useCli(ctx.cli.command)

    ctx.provide(Admin, {
      snapshot: () => admin.snapshot(),
      updates: () => admin.updates(),
      registryStatus: () => admin.registryStatus(),
      setRegistryMode: (input) => admin.changeRegistryMode(input.mode),
      search: (input) => admin.search(input.query),
      // The catalog marks entries that are already configured, so it needs the current list first.
      browse: async (input) => {
        const state = await admin.snapshot()
        return catalog.browse(new Set(state.plugins.map((entry) => entry.name)), input.force)
      },
      detail: (input) => admin.detail(input.name),
      openUrl: (input) => ({ ok: admin.openUrl(input.url) }),
      openConfig: async () => ({ ok: await admin.openConfig() }),
      // 运行事实来自应用自己的 sidecar 与官方 `plugin list`；读不到时页面如实显示“未知”。
      install: (input) => admin.install(input.spec, input.version, { endpoint: ctx.serverEndpoints.get("sidecar") }),
      update: (input) => admin.update(input.spec, { endpoint: ctx.serverEndpoints.get("sidecar") }),
      remove: (input) => admin.remove(input.spec),
      pause: (input) => admin.pause(input.spec, { endpoint: ctx.serverEndpoints.get("sidecar") }),
      resume: (input) => admin.resume(input.spec, { endpoint: ctx.serverEndpoints.get("sidecar") }),
      reload: () => admin.reload(),
      runtime: () => admin.runtime(ctx.serverEndpoints.get("sidecar")),
    })
  },
})
