// SQLite storage (Node's built-in node:sqlite — no extra dependency).
// One file, by default ./data/dulu.db; in Docker /data/dulu.db on a volume.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
-- Inbound Relworx mobile-money collections ("coffees").
CREATE TABLE IF NOT EXISTS payments (
  id             TEXT PRIMARY KEY,
  reference      TEXT NOT NULL UNIQUE,            -- ours: APP_REF_PREFIX + random
  internal_ref   TEXT,                            -- Relworx internal_reference
  msisdn         TEXT NOT NULL,                   -- +256...
  amount_ugx     INTEGER NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  raw_response   TEXT,                            -- last Relworx payload (JSON) for audit
  error_message  TEXT,
  guest_id       TEXT NOT NULL,                   -- anonymous player who gets the pass
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  confirmed_at   TEXT
);
CREATE INDEX IF NOT EXISTS payments_status_idx  ON payments (status);
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments (created_at);
CREATE INDEX IF NOT EXISTS payments_msisdn_idx  ON payments (msisdn);

-- Online-play passes: one row per anonymous player.
CREATE TABLE IF NOT EXISTS passes (
  guest_id    TEXT PRIMARY KEY,
  msisdn      TEXT,                               -- last number that paid (for restore)
  expires_at  INTEGER NOT NULL,                   -- epoch ms
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passes_msisdn_idx ON passes (msisdn);
`;

/** Open (and migrate) the database. Pass ':memory:' for tests. */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
