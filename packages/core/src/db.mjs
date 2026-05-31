// Tiny SQLite helper shared by apps that persist state. Opens a DB
// at DATA_DIR/<name>.db (DATA_DIR defaults to ./data, which Coolify
// can back with a persistent volume). Apps pass their schema once;
// we run it idempotently on open.

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

export function openDb(name, schemaSql) {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${name}.db`));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (schemaSql) db.exec(schemaSql);
  return db;
}
