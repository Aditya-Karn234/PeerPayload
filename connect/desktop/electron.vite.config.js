import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // main and preload: electron-vite keeps dependencies out of the bundle
  // by default (build.externalizeDeps), so they need no config.
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      // @peerpayload/ui is a symlinked local file: dependency (packages/ui) —
      // preserveSymlinks + fs.allow keep Vite from treating its real path
      // (outside desktop/) as off-limits to serve during dev.
      preserveSymlinks: true,
    },
    server: {
      fs: {
        allow: [resolve("../..")],
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
