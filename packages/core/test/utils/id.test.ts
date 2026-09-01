import { describe, expect, it, vi } from "vitest";

describe("id generation", () => {
  it("orders identifiers generated within the same millisecond", async () => {
    vi.resetModules();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    try {
      const { generateTransactionId } = await import("../../src/utils/id.js");
      const ids = Array.from({ length: 100 }, generateTransactionId);

      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(ids);
    } finally {
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});
