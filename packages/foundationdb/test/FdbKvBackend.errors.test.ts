import { describe, expect, it } from "vitest";
import {
  FdbKvBackendError,
  assertFdbSubspaceConfigured,
  classifyFdbError,
} from "../src/FdbKvBackend.js";

describe("FdbKvBackend error classification", () => {
  it("classifies conflict errors as retryable", () => {
    const error = classifyFdbError("setAll", {
      code: 1020,
      message: "not_committed",
    });

    expect(error).toBeInstanceOf(FdbKvBackendError);
    expect(error.operation).toBe("setAll");
    expect(error.kind).toBe("retryable");
    expect(error.retryable).toBe(true);
    expect(error.code).toBe(1020);
  });

  it("classifies transaction timeouts separately from retryable errors", () => {
    const error = classifyFdbError("transaction", {
      code: 1031,
      message: "transaction_timed_out",
    });

    expect(error.kind).toBe("timeout");
    expect(error.retryable).toBe(false);
    expect(error.code).toBe(1031);
  });

  it("classifies FDB size limits as constraints", () => {
    const error = classifyFdbError("setAll", {
      code: 2101,
      message: "transaction_too_large",
    });

    expect(error.kind).toBe("constraint");
    expect(error.retryable).toBe(false);
    expect(error.code).toBe(2101);
  });

  it("preserves existing classified errors", () => {
    const original = new FdbKvBackendError({
      operation: "set",
      kind: "constraint",
      retryable: false,
      message: "value too large",
    });

    expect(classifyFdbError("ignored", original)).toBe(original);
  });

  it("classifies unrecognized FDB codes as non-retryable permanent errors", () => {
    const error = classifyFdbError("get", {
      code: 2203,
      message: "api_version_not_supported",
    });

    expect(error.kind).toBe("permanent");
    expect(error.retryable).toBe(false);
    expect(error.code).toBe(2203);
  });

  it("requires a non-empty subspace when configured", () => {
    expect(() =>
      assertFdbSubspaceConfigured({ requireSubspace: true }, "subscriptions.open"),
    ).toThrow(/requires a non-empty subspace/);

    expect(() =>
      assertFdbSubspaceConfigured(
        { requireSubspace: true, subspace: Buffer.alloc(0) },
        "subscriptions.open",
      ),
    ).toThrow(/requires a non-empty subspace/);

    expect(() =>
      assertFdbSubspaceConfigured(
        { requireSubspace: true, subspace: Buffer.from("tenant-a/") },
        "subscriptions.open",
      ),
    ).not.toThrow();
  });
});
