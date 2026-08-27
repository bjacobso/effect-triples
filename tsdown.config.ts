import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  entry: ["src/index.ts"],
  splitting: false,
  format: ["esm"],
  dts: { sourcemap: true },
  platform: "node",
  target: "es2022",
  external: ["effect", "node:crypto"],
  ignoreWatch: [".turbo"],
  outputOptions: {
    chunkFileNames: "[name].js",
    entryFileNames: "[name].js",
  },
});
