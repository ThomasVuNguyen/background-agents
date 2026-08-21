import type Database from "better-sqlite3";
import type { SqlResult, SqlStorage } from "./sql-storage";

export class BetterSqlStorage implements SqlStorage {
  constructor(private readonly db: Database.Database) {}

  exec(query: string, ...params: unknown[]): SqlResult {
    const trimmed = query.trim().toUpperCase();
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN")
    ) {
      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params);
      return {
        toArray: () => rows,
        one: () => rows[0] ?? null,
      };
    } else {
      const stmt = this.db.prepare(query);
      const info = stmt.run(...params);
      return {
        toArray: () => [],
        one: () => null,
        rowsWritten: info.changes,
      };
    }
  }
}
