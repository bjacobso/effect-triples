import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceAliases(),
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
