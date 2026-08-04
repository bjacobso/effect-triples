import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  target: "esnext",
  unbundle: true,
  fixedExtension: false,
  dts: { sourcemap: true },
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
