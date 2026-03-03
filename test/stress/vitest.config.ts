import { defineConfig } from "vitest/config";

const parseTimeout = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    // Allow override for long-running stress runs (e.g. 100k+ employees)
    testTimeout: parseTimeout(process.env["STRESS_TEST_TIMEOUT"], 600000),
    hookTimeout: parseTimeout(process.env["STRESS_TEST_TIMEOUT"], 600000),
    disableConsoleIntercept: true, // Real-time console output
  },
});
