import { defineConfig } from "vite";

// On GitHub Pages this is served from https://<user>.github.io/virtual-cog-pilot/,
// so the production build needs a matching base path. Dev stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/virtual-cog-pilot/" : "/",
  server: {
    port: 3000,
    open: true,
  },
}));
