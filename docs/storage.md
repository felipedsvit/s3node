# Storage

## On-disk layout

```
<dataDir>/
  data/                  Object blobs (2-level hex fanout)
    <xx>/<yy>/<blobId>   blobId = 32 hex chars from random UUID
                           xx = blobId[0..2], yy = blobId[2..4]
    <xx>/<yy>/.<id>.tmp-*  Co-located staging files for atomic rename
  tmp/                   Reserved for compatibility
  metadata.sqlite        SQLite database (WAL mode)
  master.key             SSE-S3 master key (base64, 32 bytes, mode 0600)
```

## SQLite schema (version 6)

Opening an older data directory runs all required schema migrations inside one
transaction. Before upgrading, back up `metadata.sqlite` and `master.key`
together. Downgrading a data directory after it has been opened by v0.1.9 is not
supported, and databases created by a newer schema are rejected at startup.

### `buckets` table
- `name` (TEXT PRIMARY KEY)
- `created_at` (INTEGER, Unix milliseconds)
- `region` (TEXT)

### `bucket_config` table
- `bucket` (TEXT)
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
- `last_modified` (INTEGER, Unix milliseconds)
- `blob_id` (TEXT)
- `parts` (TEXT) — JSON, for multipart objects
- `metadata` (TEXT) — JSON, user metadata
- `checksums` (TEXT) — JSON, algorithm -> base64 digest
- `tags` (TEXT) — JSON, key-value pairs
- `encryption` (TEXT) — JSON, SSE-C/SSE-S3 params
- `retention_mode` (TEXT)
- `retain_until` (INTEGER, Unix milliseconds)
- `legal_hold` (INTEGER boolean)

### `uploads` table
- `upload_id` (TEXT PRIMARY KEY)
- `bucket` (TEXT)
- `key` (BLOB)
- `initiated_at` (INTEGER, Unix milliseconds)
- `content_type` (TEXT)
- `metadata` (TEXT) — JSON
- `tags` (TEXT) — JSON
- `encryption` (TEXT) — JSON
- `retention_mode` (TEXT)
- `retain_until` (INTEGER, Unix milliseconds)
- `legal_hold` (INTEGER boolean)

### `upload_parts` table
- `upload_id` (TEXT)
- `part_number` (INTEGER)
- `size` (INTEGER)
- `etag` (TEXT)
- `blob_id` (TEXT)
- `uploaded_at` (INTEGER, Unix milliseconds)

### `notification_queue` table
- `id` (INTEGER PRIMARY KEY)
- `bucket` (TEXT)
- `target_id` (TEXT)
- `endpoint` (TEXT)
- `payload` (TEXT)
- `attempts` (INTEGER)
- `next_attempt_at` (INTEGER, Unix milliseconds)
- `status` (TEXT)
- `claimed_at` (INTEGER, Unix milliseconds; nullable delivery lease)
- `created_at` (INTEGER, Unix milliseconds)

### `pending_blobs` table
- `blob_id` (TEXT PRIMARY KEY)
- `created_at` (INTEGER, Unix milliseconds)

This journal protects a blob between its filesystem publication and metadata commit, so online garbage collection cannot delete an in-progress write.

### `metadata_sequence` table
- `id` (INTEGER PRIMARY KEY, fixed at 1)
- `value` (INTEGER)

The database-wide counter gives versions a unique ordering across cluster workers.

## Design decisions

### Blob names are decoupled from object keys

Object keys may contain `../` or other path-traversal patterns. By using UUID-based blob IDs, path traversal is prevented by construction, along with case-folding and name-length issues of key-as-path layouts.

### Keys stored as BLOB (not TEXT)

SQLite orders TEXT by collation, but JavaScript string comparison uses UTF-16 code units. By storing keys as BLOB, SQLite orders by UTF-8 bytes, which matches byte-for-byte comparison.

### Atomic write path

The write path is ordered so a crash can only leave an orphan blob, never metadata pointing at missing data:

1. Reserve the blob ID in `pending_blobs`
2. Stream to a hidden temp file beside its final fanout path
3. `fsync` the temp file
4. `rename` to final location in `data/<xx>/<yy>/`
5. `fsync` the parent directory
6. Commit the metadata row and clear the pending reservation in one SQLite transaction

### SQLite WAL mode

Write-Ahead Logging allows concurrent readers while one writer commits. A `busy_timeout` of 5 seconds makes blocked writers wait instead of failing immediately. Metadata uses `synchronous=FULL`; schema upgrades run in a single immediate transaction and reject databases created by a newer schema version.
