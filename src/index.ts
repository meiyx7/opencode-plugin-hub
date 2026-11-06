import { Plugin } from "@opencode/plugin"

/**
 * Server half. It deliberately does nothing: installing and removing plugins is file work that the
 * desktop GUI's main process performs over IPC. Its only job is to give the package a plugin id
 * (`plugin-hub`), which the GUI inherits.
 */
export default Plugin.define({
  id: "plugin-hub",
  setup() {
    return
  },
})
