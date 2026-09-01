import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["app.ts"],
  outDir: "build",
  format: ["esm"],
  platform: "browser",
  dts: false,
  noExternal: [/.*/],
  outputOptions: { entryFileNames: "app.js" },
});
