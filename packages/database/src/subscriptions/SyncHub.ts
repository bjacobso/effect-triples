import { Effect, Layer } from "effect";
import type { DatalogQuery } from "../Datalog.js";
import {
  ChangeEmitter,
  type ChangeEmitterService,
  type ChangeEvent,
  type TripleChange,
} from "../store/ChangeEmitter.js";
import { TopicTree } from "./TopicTree.js";
import { extractDependencies } from "./extract-dependencies.js";
import { hashQuery } from "./query-hash.js";
import type { SyncClientMessage, SyncServerMessage } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 50;

export interface SyncAttachedQuery {
  readonly queryId: string;
  readonly query: DatalogQuery;
}

export interface SyncConnection {
  readonly database: string;
  readonly connectionId: string;
}

export interface SyncHubMessageHooks {
  readonly onSubscribe?: (subscription: SyncAttachedQuery) => void;
  readonly onUnsubscribe?: (queryId: string) => void;
}

interface SyncClient {
  readonly send: (message: SyncServerMessage) => void;
}

interface DatabaseConnections {
  readonly clientsById: Map<string, SyncClient>;
  readonly topicTree: TopicTree;
  pendingChanges: ChangeEvent[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class TopicFilteredSyncHub {
  private readonly databases = new Map<string, DatabaseConnections>();
  private nextConnectionIndex = 0;

  constructor(private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS) {}

  connect(
    database: string,
    send: (message: SyncServerMessage) => void,
    options?: {
      readonly connectionId?: string;
      readonly sendConnected?: boolean;
      readonly subscriptions?: Iterable<SyncAttachedQuery>;
    },
  ): SyncConnection {
    const connectionId = options?.connectionId ?? this.nextConnectionId();
    const conn = this.getOrCreate(database);

    conn.topicTree.removeConnection(connectionId);
    conn.clientsById.set(connectionId, { send });

    for (const subscription of options?.subscriptions ?? []) {
      this.registerSubscription(conn, connectionId, subscription.queryId, subscription.query);
    }

    if (options?.sendConnected ?? true) {
      this.send(database, conn, connectionId, { type: "connected", database });
    }

    return { database, connectionId };
  }

  hasConnection(connection: SyncConnection): boolean {
    return (
      this.databases.get(connection.database)?.clientsById.has(connection.connectionId) ?? false
    );
  }

  disconnect(connection: SyncConnection): void {
    const conn = this.databases.get(connection.database);
    if (!conn) return;

    conn.topicTree.removeConnection(connection.connectionId);
    conn.clientsById.delete(connection.connectionId);

    if (conn.clientsById.size === 0 && conn.timer === null) {
      this.databases.delete(connection.database);
    }
  }

  receive(connection: SyncConnection, data: unknown, hooks: SyncHubMessageHooks = {}): void {
    const conn = this.databases.get(connection.database);
    if (!conn?.clientsById.has(connection.connectionId)) return;

    try {
      const msg = JSON.parse(this.decodeMessage(data)) as Partial<SyncClientMessage>;

      switch (msg?.type) {
        case "subscribe": {
          if (typeof msg.queryId !== "string" || !msg.query) {
            this.send(connection.database, conn, connection.connectionId, {
              type: "error",
              message: "Invalid subscribe message",
            });
            return;
          }

          this.registerSubscription(conn, connection.connectionId, msg.queryId, msg.query);
          this.send(connection.database, conn, connection.connectionId, {
            type: "subscribed",
            queryId: msg.queryId,
            queryHash: hashQuery(msg.query),
          });
          hooks.onSubscribe?.({ queryId: msg.queryId, query: msg.query });
          return;
        }

        case "unsubscribe": {
          if (typeof msg.queryId !== "string") {
            this.send(connection.database, conn, connection.connectionId, {
              type: "error",
              message: "Invalid unsubscribe message",
            });
            return;
          }

          conn.topicTree.unregister(connection.connectionId, msg.queryId);
          hooks.onUnsubscribe?.(msg.queryId);
          return;
        }

        case "ping": {
          this.send(connection.database, conn, connection.connectionId, { type: "pong" });
          return;
        }

        default:
          this.send(connection.database, conn, connection.connectionId, {
            type: "error",
            message: "Unknown message type",
          });
          return;
      }
    } catch {
      this.send(connection.database, conn, connection.connectionId, {
        type: "error",
        message: "Malformed message",
      });
    }
  }

  emitForDatabase(database: string, event: ChangeEvent): void {
    const conn = this.databases.get(database);
    if (!conn || conn.clientsById.size === 0) return;

    conn.pendingChanges.push(event);
    if (!conn.timer) {
      conn.timer = setTimeout(() => this.flush(database), this.debounceMs);
    }
  }

  emitToAllDatabases(event: ChangeEvent): void {
    for (const database of this.databases.keys()) {
      this.emitForDatabase(database, event);
    }
  }

  get service(): ChangeEmitterService {
    return {
      emit: (event: ChangeEvent) =>
        Effect.sync(() => {
          this.emitToAllDatabases(event);
        }),
    };
  }

  get layer(): Layer.Layer<ChangeEmitter> {
    return Layer.succeed(ChangeEmitter, this.service);
  }

  dispose(): void {
    for (const [, conn] of this.databases) {
      if (conn.timer) {
        clearTimeout(conn.timer);
      }
      conn.clientsById.clear();
    }
    this.databases.clear();
  }

  private getOrCreate(database: string): DatabaseConnections {
    let conn = this.databases.get(database);
    if (!conn) {
      conn = {
        clientsById: new Map(),
        topicTree: new TopicTree(),
        pendingChanges: [],
        timer: null,
      };
      this.databases.set(database, conn);
    }
    return conn;
  }

  private nextConnectionId(): string {
    this.nextConnectionIndex += 1;
    return `ws:${this.nextConnectionIndex}`;
  }

  private registerSubscription(
    conn: DatabaseConnections,
    connectionId: string,
    queryId: string,
    query: DatalogQuery,
  ): void {
    conn.topicTree.register(connectionId, queryId, extractDependencies(query));
  }

  private flush(database: string): void {
    const conn = this.databases.get(database);
    if (!conn || conn.pendingChanges.length === 0) return;

    const batch = conn.pendingChanges;
    conn.pendingChanges = [];
    conn.timer = null;

    const allChanges = batch.flatMap((event) => event.changes);
    const affectedConnections = conn.topicTree.findAffected(allChanges);

    for (const [connectionId, matchingChanges] of affectedConnections) {
      const filteredEvents = this.filterEventsToChanges(batch, matchingChanges);
      if (filteredEvents.length === 0) continue;

      this.send(database, conn, connectionId, {
        type: "changes",
        events: filteredEvents,
      });
    }

    for (const [connectionId] of conn.clientsById) {
      if (affectedConnections.has(connectionId) || conn.topicTree.hasSubscriptions(connectionId)) {
        continue;
      }

      this.send(database, conn, connectionId, {
        type: "changes",
        events: batch,
      });
    }

    if (conn.clientsById.size === 0) {
      this.databases.delete(database);
    }
  }

  private filterEventsToChanges(
    events: readonly ChangeEvent[],
    matchingChanges: readonly TripleChange[],
  ): readonly ChangeEvent[] {
    const changeKeys = new Set(matchingChanges.map((change) => this.changeKey(change)));

    return events.flatMap((event) => {
      const filteredChanges = event.changes.filter((change) =>
        changeKeys.has(this.changeKey(change)),
      );
      return filteredChanges.length > 0 ? [{ ...event, changes: filteredChanges }] : [];
    });
  }

  private changeKey(change: TripleChange): string {
    return `${change.operation}:${change.entityId}:${change.attribute}`;
  }

  private send(
    database: string,
    conn: DatabaseConnections,
    connectionId: string,
    message: SyncServerMessage,
  ): void {
    const client = conn.clientsById.get(connectionId);
    if (!client) return;

    try {
      client.send(message);
    } catch {
      this.disconnect({ database, connectionId });
    }
  }

  private decodeMessage(data: unknown): string {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(
        new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
      );
    }
    return String(data);
  }
}
