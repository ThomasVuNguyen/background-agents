import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { createLogger } from "../logger";

const log = createLogger("sqlite-adapter");

interface SqliteInternalStatement {
  readonly query: string;
  readonly params: unknown[];
  executeRun(): SqlResult;
  executeAll(): SqlResult;
  executeFirst(): Record<string, unknown> | null;
}

class BetterSqlStatement implements SqlStatement, SqliteInternalStatement {
  constructor(
    private readonly db: Database.Database,
    readonly query: string,
    readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new BetterSqlStatement(this.db, this.query, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.executeFirst() as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.executeRun() as SqlResult<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.executeAll() as SqlResult<T>;
  }

  executeFirst(): Record<string, unknown> | null {
    const stmt = this.db.prepare(this.query);
    const row = stmt.get(...this.params);
    return (row as Record<string, unknown>) ?? null;
  }

  executeRun(): SqlResult {
    const stmt = this.db.prepare(this.query);
    const info = stmt.run(...this.params);
    return {
      results: [],
      meta: {
        changes: info.changes,
      },
    };
  }

  executeAll(): SqlResult {
    const stmt = this.db.prepare(this.query);
    const rows = stmt.all(...this.params);
    return {
      results: rows,
      meta: {
        changes: 0,
      },
    };
  }
}

export class BetterSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: Database.Database) {}

  get rawDb(): Database.Database {
    return this.db;
  }

  prepare(query: string): SqlStatement {
    return new BetterSqlStatement(this.db, query);
  }

  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    const runBatch = this.db.transaction(() => {
      const results: SqlResult<T>[] = [];
      for (const stmt of statements) {
        // Handle statements or wrapped statements
        const internal = stmt as unknown as SqliteInternalStatement;
        if (typeof internal.executeAll === "function") {
          const trimmed = internal.query.trim().toUpperCase();
          if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN")) {
            results.push(internal.executeAll() as SqlResult<T>);
          } else {
            results.push(internal.executeRun() as SqlResult<T>);
          }
        } else {
          // Fallback if not our statement type
          throw new Error("Cannot batch statement from different database origin");
        }
      }
      return results;
    });

    return runBatch();
  }
}

/**
 * Apply all D1 SQL migrations in order from the migrations directory.
 */
export function applySqliteMigrations(
  rawDb: Database.Database,
  migrationsDir: string
): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  if (!fs.existsSync(migrationsDir)) {
    log.warn("Migrations directory not found", { path: migrationsDir });
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = rawDb.prepare("SELECT name FROM d1_migrations").all() as { name: string }[];
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const insertStmt = rawDb.prepare("INSERT INTO d1_migrations (name) VALUES (?)");

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const fullPath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(fullPath, "utf-8");

    log.info("Applying migration", { file });

    const applyMigration = rawDb.transaction(() => {
      rawDb.exec(sqlContent);
      insertStmt.run(file);
    });

    applyMigration();
  }
}

export function createSqliteDatabase(
  dbPath: string,
  migrationsDir?: string
): BetterSqliteDatabase {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const rawDb = new Database(dbPath);
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("foreign_keys = ON");

  if (migrationsDir) {
    applySqliteMigrations(rawDb, migrationsDir);
  }

  return new BetterSqliteDatabase(rawDb);
}
