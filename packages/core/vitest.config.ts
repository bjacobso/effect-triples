import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceAliases(),
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
