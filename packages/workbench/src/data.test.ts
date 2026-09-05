import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyChange,
  createWorker,
  initialize,
  previewChange,
  readWorkbench,
  WorkbenchLayer,
} from "./data.js";

const makeRuntime = () => ManagedRuntime.make(WorkbenchLayer);
const withWorkspace = async (test: (runtime: ReturnType<typeof makeRuntime>) => Promise<void>) => {
  const runtime = ManagedRuntime.make(WorkbenchLayer);
  try {
    await runtime.runPromise(initialize);
    await test(runtime);
  } finally {
    await runtime.dispose();
  }
};

describe("Workbench operational data", () => {
  it("derives eligibility from stored facts and links worker tasks", async () => {
    await withWorkspace(async (runtime) => {
      const data = await runtime.runPromise(readWorkbench);
      expect(data.workers).toHaveLength(12);
      expect(data.evaluation.candidates).toHaveLength(7);
      const bob = data.workers.find((worker) => worker.name === "Bob Martinez")!;
      expect(bob.eligible).toBe(false);
      expect(bob.tasks).toBe(2);
      expect(data.evaluation.candidates[0]!.sources.length).toBe(4);
      expect(data.definition.configSnapshot).toBe(data.release);
    });
  });
  it("previews without writes, applies atomically, and rejects a stale preview", async () => {
    await withWorkspace(async (runtime) => {
      const before = await runtime.runPromise(readWorkbench);
      const bob = before.workers.find((worker) => worker.name === "Bob Martinez")!;
      const preview = await runtime.runPromise(previewChange(before, bob, "i9", "Complete"));
      expect(preview.eligible).toBe(true);
      const untouched = await runtime.runPromise(readWorkbench);
      expect(untouched.workers.find((worker) => worker.id === bob.id)!.i9).toBe("Missing");
      expect(untouched.journal).toHaveLength(before.journal.length);
      const receipt = await runtime.runPromise(applyChange(preview));
      const after = await runtime.runPromise(readWorkbench);
      expect(after.workers.find((worker) => worker.id === bob.id)!.eligible).toBe(true);
      expect(after.journal[0]!.txId).toBe(receipt.txId);
      expect(after.journal[0]!.changes.map((change) => change.op).sort()).toEqual([
        "assert",
        "retract",
      ]);
      expect(after.journal[0]!.configSnapshot).toBe(before.release);
      const stale = await runtime.runPromise(applyChange(preview).pipe(Effect.result));
      expect(stale._tag).toBe("Failure");
      expect((await runtime.runPromise(readWorkbench)).journal).toHaveLength(after.journal.length);
    });
  });
  it("creates a linked worker and validates input before writing", async () => {
    await withWorkspace(async (runtime) => {
      const id = await runtime.runPromise(createWorker("Alex Morgan", "Analyst", "org:acme", "CA"));
      const data = await runtime.runPromise(readWorkbench);
      expect(data.workers.find((worker) => worker.id === id)).toMatchObject({
        name: "Alex Morgan",
        employer: "org:acme",
        i9: "Missing",
        eligible: false,
      });
      const invalid = await runtime.runPromise(
        createWorker(" ", "Analyst", "org:acme", "CA").pipe(Effect.result),
      );
      expect(invalid._tag).toBe("Failure");
      expect((await runtime.runPromise(readWorkbench)).workers).toHaveLength(13);
    });
  });
});
