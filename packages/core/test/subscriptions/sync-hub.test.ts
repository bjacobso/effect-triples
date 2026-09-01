import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicFilteredSyncHub } from "../../src/subscriptions/SyncHub.js";
import type { DatalogQuery } from "../../src/datalog/schema.js";
import type { ChangeEvent } from "../../src/store/ChangeEmitter.js";
import type { SyncServerMessage } from "../../src/subscriptions/types.js";

const employeeNameQuery: DatalogQuery = {
  find: ["?name"],
  where: [["?emp", ":employee/name", "?name"]],
};

const departmentNameQuery: DatalogQuery = {
  find: ["?name"],
  where: [["?dept", ":department/name", "?name"]],
};

const mixedEvent: ChangeEvent = {
  txId: "tx:1",
  timestamp: 1,
  changes: [
    { entityId: "emp:alice", attribute: ":employee/name", operation: "assert" },
    { entityId: "dept:eng", attribute: ":department/name", operation: "assert" },
  ],
};

const collect = () => {
  const messages: SyncServerMessage[] = [];
  return {
    messages,
    send: (message: SyncServerMessage) => messages.push(message),
  };
};

describe("TopicFilteredSyncHub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends only matching changes to subscribed connections", () => {
    const hub = new TopicFilteredSyncHub();
    const employees = collect();
    const departments = collect();

    const employeeConn = hub.connect("demo", employees.send);
    const departmentConn = hub.connect("demo", departments.send);

    hub.receive(
      employeeConn,
      JSON.stringify({
        type: "subscribe",
        queryId: "employees",
        query: employeeNameQuery,
      }),
    );
    hub.receive(
      departmentConn,
      JSON.stringify({
        type: "subscribe",
        queryId: "departments",
        query: departmentNameQuery,
      }),
    );

    hub.emitForDatabase("demo", mixedEvent);
    vi.advanceTimersByTime(50);

    expect(employees.messages.at(-1)).toEqual({
      type: "changes",
      events: [
        {
          ...mixedEvent,
          changes: [{ entityId: "emp:alice", attribute: ":employee/name", operation: "assert" }],
        },
      ],
    });
    expect(departments.messages.at(-1)).toEqual({
      type: "changes",
      events: [
        {
          ...mixedEvent,
          changes: [{ entityId: "dept:eng", attribute: ":department/name", operation: "assert" }],
        },
      ],
    });
  });

  it("keeps full-broadcast behavior for connections without subscriptions", () => {
    const hub = new TopicFilteredSyncHub();
    const legacy = collect();

    hub.connect("demo", legacy.send);
    hub.emitForDatabase("demo", mixedEvent);
    vi.advanceTimersByTime(50);

    expect(legacy.messages.at(-1)).toEqual({
      type: "changes",
      events: [mixedEvent],
    });
  });
});
