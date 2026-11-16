import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [solid()],
  server: { port: 5199 },
})
