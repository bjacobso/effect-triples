import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 600000, // 10 minute timeout for stress tests
    disableConsoleIntercept: true, // Real-time console output
  },
});
