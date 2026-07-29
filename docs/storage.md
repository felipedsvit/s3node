# Storage

## On-disk layout

```
<dataDir>/
  data/                  Object blobs (2-level hex fanout)
    <xx>/<yy>/<blobId>   blobId = 32 hex chars from random UUID
                           xx = blobId[0..2], yy = blobId[2..4]
  tmp/                   Staging for atomic writes
  metadata.sqlite        SQLite database (WAL mode)
  master.key             SSE-S3 master key (base64, 32 bytes, mode 0600)
```

## SQLite schema (version 4)

### `buckets` table
- `name` (TEXT PRIMARY KEY)
- `created_at` (TEXT)
- `region` (TEXT)

### `bucket_config` table
- `bucket` (TEXT, FK to buckets)
- `name` (TEXT) — config type: versioning, policy, cors, lifecycle, tagging, notification, quota, object-lock
- `value` (TEXT) — JSON value

### `objects` table
- `bucket` (TEXT)
- `key` (BLOB) — stored as UTF-8 bytes for correct byte ordering
- `version_id` (TEXT)
- `sequence` (INTEGER)
- `is_latest` (INTEGER)
- `is_delete_marker` (INTEGER)
- `size` (INTEGER)
- `etag` (TEXT)
- `content_type` (TEXT)
- `last_modified` (TEXT)
- `blob_id` (TEXT)
- `parts` (TEXT) — JSON, for multipart objects
- `metadata` (TEXT) — JSON, user metadata
- `checksums` (TEXT) — JSON, algorithm -> hex
- `tags` (TEXT) — JSON, key-value pairs
- `encryption` (TEXT) — JSON, SSE-C/SSE-S3 params
- `retention_mode` (TEXT)
- `retain_until` (TEXT)
- `legal_hold` (TEXT)

### `uploads` table
- `upload_id` (TEXT PRIMARY KEY)
- `bucket` (TEXT)
- `key` (BLOB)
- `initiated_at` (TEXT)
- `content_type` (TEXT)
- `metadata` (TEXT) — JSON
- `tags` (TEXT) — JSON
- `encryption` (TEXT) — JSON

### `upload_parts` table
- `upload_id` (TEXT)
- `part_number` (INTEGER)
- `size` (INTEGER)
- `etag` (TEXT)
- `blob_id` (TEXT)
- `uploaded_at` (TEXT)

### `notification_queue` table
- `id` (INTEGER PRIMARY KEY)
- `bucket` (TEXT)
- `target_id` (TEXT)
- `endpoint` (TEXT)
- `payload` (TEXT)
- `attempts` (INTEGER)
- `next_attempt_at` (TEXT)
- `status` (TEXT)
- `created_at` (TEXT)

## Design decisions

### Blob names are decoupled from object keys

Object keys may contain `../` or other path-traversal patterns. By using UUID-based blob IDs, path traversal is prevented by construction, along with case-folding and name-length issues of key-as-path layouts.

### Keys stored as BLOB (not TEXT)

SQLite orders TEXT by collation, but JavaScript string comparison uses UTF-16 code units. By storing keys as BLOB, SQLite orders by UTF-8 bytes, which matches byte-for-byte comparison.

### Atomic write path

The write path is ordered so a crash can only leave an orphan blob, never metadata pointing at missing data:

1. Stream to a temp file in `tmp/`
2. `fsync` the temp file
3. `rename` to final location in `data/<xx>/<yy>/`
4. `fsync` the parent directory
5. Commit the metadata row to SQLite

### SQLite WAL mode

Write-Ahead Logging allows concurrent readers while one writer commits. A `busy_timeout` of 5 seconds makes blocked writers wait instead of failing immediately.
