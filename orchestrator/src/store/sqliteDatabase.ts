import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

// Vite 5 predates `node:sqlite` and otherwise rewrites the built-in specifier to
// a package named `sqlite` while collecting tests. A synchronous require keeps
// the runtime-owned module external in both Vitest and the compiled CLI.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface SqliteDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export interface TransactionInvoker<T> {
  (): T;
  immediate(): T;
}

/**
 * Small compatibility boundary around Node 24's built-in synchronous SQLite API.
 *
 * Keeping the two conveniences the store relies on (`pragma()` and
 * `transaction()`) here avoids coupling the durable-store contract to a native
 * npm addon while preserving the existing call sites and transaction semantics.
 */
export default class SqliteDatabase {
  private readonly database: NodeDatabaseSync;
  private closed = false;

  constructor(filePath: string, options: SqliteDatabaseOptions = {}) {
    if (options.fileMustExist && filePath !== ":memory:" && !fs.existsSync(filePath)) {
      throw new Error(`database file does not exist: ${filePath}`);
    }
    this.database = new DatabaseSync(filePath, { readOnly: options.readonly === true });
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): ReturnType<NodeDatabaseSync["prepare"]> {
    return this.database.prepare(sql);
  }

  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    const statement = this.database.prepare(`PRAGMA ${sql}`);
    if (!options.simple) return statement.all();
    const row = statement.get();
    return row === undefined ? undefined : Object.values(row)[0];
  }

  transaction<T>(fn: () => T): TransactionInvoker<T> {
    const invoke = (begin: "BEGIN" | "BEGIN IMMEDIATE"): T => {
      this.database.exec(begin);
      try {
        const result = fn();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original application error if SQLite already ended the transaction.
        }
        throw error;
      }
    };
    const deferred = (() => invoke("BEGIN")) as TransactionInvoker<T>;
    deferred.immediate = () => invoke("BEGIN IMMEDIATE");
    return deferred;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
