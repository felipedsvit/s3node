import type { DatabaseSync } from 'node:sqlite'

// v4 only adds a new table (CREATE TABLE IF NOT EXISTS), so it needs no
// migrate function: unlike the v1->v2/v2->v3 ALTERs, there is no existing
// data to reshape for a table that didn't exist before.
export const SCHEMA_VERSION = 4
export const NULL_VERSION = 'null'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  region        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bucket_config (
  bucket        TEXT NOT NULL,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  PRIMARY KEY (bucket, name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS objects (
  bucket           TEXT NOT NULL,
  key              BLOB NOT NULL,
  version_id       TEXT NOT NULL,
  sequence         INTEGER NOT NULL,
  is_latest        INTEGER NOT NULL DEFAULT 1,
  is_delete_marker INTEGER NOT NULL DEFAULT 0,
  size             INTEGER NOT NULL,
  etag             TEXT NOT NULL,
  content_type     TEXT,
  last_modified    INTEGER NOT NULL,
  blob_id          TEXT,
  parts            TEXT,
  metadata         TEXT,
  checksums        TEXT,
  tags             TEXT,
  encryption       TEXT,
  retention_mode   TEXT,
  retain_until     INTEGER,
  legal_hold       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key, version_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS objects_latest ON objects (bucket, key) WHERE is_latest = 1;
CREATE INDEX IF NOT EXISTS objects_sequence ON objects (bucket, key, sequence DESC);

CREATE TABLE IF NOT EXISTS uploads (
  upload_id     TEXT PRIMARY KEY,
  bucket        TEXT NOT NULL,
  key           BLOB NOT NULL,
  initiated_at  INTEGER NOT NULL,
  content_type  TEXT,
  metadata      TEXT,
  tags          TEXT,
  encryption    TEXT
);

CREATE INDEX IF NOT EXISTS uploads_by_bucket_key ON uploads (bucket, key);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id     TEXT NOT NULL,
  part_number   INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  etag          TEXT NOT NULL,
  blob_id       TEXT NOT NULL,
  uploaded_at   INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS notification_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket          TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS notification_queue_due ON notification_queue (status, next_attempt_at);
`

/** Object Lock columns arrived in v3; they are nullable, so ALTER is enough. */
export function migrateV2ToV3(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(objects)').all().map((c: Record<string, unknown>) => c['name'])
  if (columns.length === 0 || columns.includes('retention_mode')) return
  db.exec('ALTER TABLE objects ADD COLUMN retention_mode TEXT')
  db.exec('ALTER TABLE objects ADD COLUMN retain_until INTEGER')
  db.exec('ALTER TABLE objects ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0')
}

export function migrateV1ToV2(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(objects)').all().map((c: Record<string, unknown>) => c['name'])
  if (columns.length === 0 || columns.includes('version_id')) return
  db.exec('ALTER TABLE objects RENAME TO objects_v1')
  db.exec(SCHEMA)
  db.exec(`
    INSERT INTO objects (bucket, key, version_id, sequence, is_latest, is_delete_marker,
                         size, etag, content_type, last_modified, blob_id, parts, metadata, checksums)
    SELECT bucket, key, 'null', last_modified, 1, 0,
           size, etag, content_type, last_modified, blob_id, parts, metadata, checksums
      FROM objects_v1`)
  db.exec('DROP TABLE objects_v1')
}
