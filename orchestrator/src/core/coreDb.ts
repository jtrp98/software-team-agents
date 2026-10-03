import * as fs from "node:fs";
import * as path from "node:path";
import SqliteDatabase from "../store/sqliteDatabase.js";
import { corePaths } from "./corePaths.js";

/**
 * The Core's one durable store (`core/core.db` in the Core home).
 *
 * The task engine keeps its own state in each Knowledge root's
 * `.workflow/state.db`; this database holds only what sits above it — work
 * runs (the user's "do this module until QA" request), runtime health, the
 * runtime/fallback history and structured handoffs. Nothing critical lives in
 * memory: a restarted service reads this and reconciles.
 *
 * WAL + busy timeout because bounded-run children write runtime health into
 * the same file while the service reads it.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_health (
  runtime_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  failure_class TEXT,
  reason TEXT,
  cooldown_until INTEGER,
  consecutive_timeouts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_success_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  role TEXT,
  kind TEXT NOT NULL,
  failure_class TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS runtime_events_run ON runtime_events(run_id, id);
CREATE TABLE IF NOT EXISTS work_runs (
  run_id TEXT PRIMARY KEY,
  knowledge_name TEXT NOT NULL,
  knowledge_path TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_runs_module ON work_runs(knowledge_name, module, created_at);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
`;

export function openCoreDb(file = corePaths().database): SqliteDatabase {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new SqliteDatabase(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
