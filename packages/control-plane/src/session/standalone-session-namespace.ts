import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Env } from "../types";
import { SessionDO } from "./durable-object";
import { BetterSqlStorage } from "./sqlite-storage";
import { createLogger } from "../logger";

const log = createLogger("standalone-session-namespace");

interface AlarmState {
  deadline: number | null;
  timer: NodeJS.Timeout | null;
}

export class StandaloneDurableObjectState {
  public readonly sockets = new Map<WebSocket, string[]>();
  public readonly id: DurableObjectId;
  public readonly storage: DurableObjectStorage;
  private readonly alarmState: AlarmState = { deadline: null, timer: null };

  constructor(
    public readonly sessionId: string,
    public readonly rawDb: Database.Database,
    private readonly onAlarm: () => Promise<void>
  ) {
    this.id = {
      toString: () => sessionId,
      equals: (other: DurableObjectId) => other.toString() === sessionId,
      name: sessionId,
    };

    const sqlStorage = new BetterSqlStorage(rawDb);

    this.storage = {
      sql: sqlStorage,
      transactionSync: <T>(closure: () => T): T => {
        return rawDb.transaction(closure)();
      },
      getAlarm: async (): Promise<number | null> => {
        return this.alarmState.deadline;
      },
      setAlarm: async (scheduledTime: number | Date): Promise<void> => {
        const deadline =
          typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        this.alarmState.deadline = deadline;
        if (this.alarmState.timer) {
          clearTimeout(this.alarmState.timer);
          this.alarmState.timer = null;
        }
        const delay = Math.max(0, deadline - Date.now());
        this.alarmState.timer = setTimeout(async () => {
          this.alarmState.deadline = null;
          this.alarmState.timer = null;
          try {
            await this.onAlarm();
          } catch (err) {
            log.error("Alarm delivery failed", {
              session_id: sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, delay);
      },
      deleteAlarm: async (): Promise<void> => {
        this.alarmState.deadline = null;
        if (this.alarmState.timer) {
          clearTimeout(this.alarmState.timer);
          this.alarmState.timer = null;
        }
      },
    } as unknown as DurableObjectStorage;
  }

  acceptWebSocket(ws: WebSocket, tags: string[] = []): void {
    this.sockets.set(ws, tags);
  }

  getTags(ws: WebSocket): string[] {
    return this.sockets.get(ws) ?? [];
  }

  getWebSockets(tag?: string): WebSocket[] {
    if (!tag) {
      return Array.from(this.sockets.keys());
    }
    const matching: WebSocket[] = [];
    for (const [ws, tags] of this.sockets.entries()) {
      if (tags.includes(tag)) {
        matching.push(ws);
      }
    }
    return matching;
  }

  setWebSocketAutoResponse(
    _pair: unknown
  ): void {
    // Handled in websocket message routing
  }

  waitUntil(promise: Promise<unknown>): void {
    promise.catch((error) => {
      log.error("Background task in DurableObject failed", {
        session_id: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  dispose(): void {
    if (this.alarmState.timer) {
      clearTimeout(this.alarmState.timer);
    }
    this.rawDb.close();
  }
}

interface ActiveSessionEntry {
  instance: SessionDO;
  state: StandaloneDurableObjectState;
}

export class StandaloneSessionNamespace {
  private readonly activeSessions = new Map<string, ActiveSessionEntry>();

  constructor(
    private readonly getEnv: () => Env,
    private readonly sessionsDir: string
  ) {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  idFromName(name: string): DurableObjectId {
    return {
      toString: () => name,
      equals: (other: DurableObjectId) => other.toString() === name,
      name,
    };
  }

  newUniqueId(): DurableObjectId {
    const id = crypto.randomUUID().replace(/-/g, "");
    return this.idFromName(id);
  }

  idFromString(idString: string): DurableObjectId {
    return this.idFromName(idString);
  }

  getByName(name: string): DurableObjectStub {
    return this.get(this.idFromName(name));
  }

  jurisdiction(_location: string): DurableObjectNamespace {
    return this as unknown as DurableObjectNamespace;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const sessionId = id.toString();
    return {
      id,
      name: sessionId,
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const session = this.getOrCreateSession(sessionId);
        const req = input instanceof Request ? input : new Request(input, init);
        return session.instance.fetch(req);
      },
    } as unknown as DurableObjectStub;
  }

  getOrCreateSession(sessionId: string): ActiveSessionEntry {
    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dbPath = path.join(this.sessionsDir, `${sanitizedId}.db`);
    const rawDb = new Database(dbPath);
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    let instance: SessionDO;
    const state = new StandaloneDurableObjectState(sessionId, rawDb, async () => {
      if (instance) {
        await instance.alarm();
      }
    });

    const env = this.getEnv();
    instance = new SessionDO(state as unknown as DurableObjectState, env);

    const entry: ActiveSessionEntry = { instance, state };
    this.activeSessions.set(sessionId, entry);
    return entry;
  }

  dispose(): void {
    for (const entry of this.activeSessions.values()) {
      entry.state.dispose();
    }
    this.activeSessions.clear();
  }
}
