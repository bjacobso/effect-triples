import { defineConfig } from "tsdown";

// Bundles the explorer for a browser: `effect` and the package itself are
// inlined so the page is a single file with no module resolution and no
// network. Note the outDir must not contain the entry - tsdown cleans it.
export default defineConfig({
  entry: ["explorer/app.ts"],
  outDir: "explorer/build",
  format: ["esm"],
  platform: "browser",
  dts: false,
  noExternal: [/.*/],
  outputOptions: { entryFileNames: "app.js" },
});
