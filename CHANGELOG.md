# Changelog

All notable changes to s3node are documented here. The project follows semantic versioning while the public API remains in the `0.x` development series.

## Unreleased

## 0.1.11 - 2026-08-19

### Security and correctness

- Harden SigV4 payload, scope, date, expiry, trailer, and strict numeric validation across authenticated requests.
- Fix policy principal matching, pagination and range edge cases, and multipart completion behavior.
- Close blob retirement and garbage-collection races while keeping file-descriptor reads safe during cleanup.

### Operations and compatibility

- Add console CSRF protection, safer backup symlink handling, startup cleanup, and more reliable notification and storage observability.
- Expand interoperability, soak, concurrency, and fault-injection coverage for the release path.

## 0.1.10 - 2026-08-16

### Backup and recovery

- Add manifest-verified online backups that snapshot SQLite, `master.key`, active multipart uploads, and the exact referenced blob set while metadata writers are locked.
- Add `s3node-backup backup`, `verify`, and `restore`, plus the public `createBackup()`, `verifyBackup()`, and `restoreBackup()` APIs.
- Restore only into a new directory, verify SHA-256 checksums and SQLite integrity, and reject malformed or path-traversing manifests.
- Prevent concurrent garbage collection from classifying blobs published after its filesystem snapshot begins as orphans.

### Operations and observability

- Add fault-injection crash tests across blob publication, metadata commits and migrations, multipart completion, and garbage collection.
- Add notification queue, SQLite WAL, filesystem capacity, process restart, garbage collection, and latency signals to Prometheus metrics.
- Add a repeatable soak runner, an AWS CLI/boto3/rclone interoperability matrix, and Node 22.13/24 CI quality gates.
- Create data directories with owner-only permissions and keep informational CLI paths free from `node:sqlite` startup warnings.

### Documentation

- Document backup, restore, metrics, crash recovery, client compatibility, and the single-node production boundary in the repository and project wiki.
- Publish the proposed authenticated-content format, availability recommendation, S3 API priorities, and Phase 2 readiness evidence in the wiki.

## 0.1.9 - 2026-08-16

### Security

- Authorize the source object for `CopyObject` and `UploadPartCopy`, authorize every key in bulk deletes, and require `s3:BypassGovernanceRetention` before bypassing governance retention.
- Redact SigV4 credentials and signatures from logs and stop logging canonical signing material.
- Block loopback, private, link-local, reserved, and redirecting webhook destinations by default to reduce SSRF risk. Trusted private endpoints require an explicit opt-in.
- Validate browser POST size bounds and redirect targets before publishing an object, and enforce the 2 KiB user-metadata limit.

### Durability and correctness

- Upgrade metadata to schema v6 with transactional migrations, forward-version rejection, durable blob reservations, cross-connection sequence allocation, and cache invalidation.
- Use full SQLite synchronization and co-located atomic blob staging so crashes cannot expose metadata that points to missing data.
- Create the SSE-S3 master key atomically, reject malformed persisted keys, and document that `metadata.sqlite` and `master.key` must be backed up together.
- Preserve Object Lock settings across copies and multipart uploads, reject past retention dates, and prevent disabling Object Lock or suspending its required versioning.
- Recover notification deliveries abandoned by crashed workers, treat only 2xx responses as success, and cap notification configurations at 100 targets per bucket.

### Operations

- Add bounded write concurrency, request rate limits, request/header/socket timeouts, forced graceful shutdown, and strict numeric option validation.
- Add CLI flags for write limits, rate limits, timeouts, and private notification endpoints; cluster workers now share generated credentials and divide aggregate rate limits.
- Raise the minimum runtime to Node.js 22.13.0, where `node:sqlite` no longer needs an experimental flag.
- Publish an explicit conditional export map with TypeScript declarations.

### Tests and documentation

- Expand coverage for CLI validation, log redaction, metadata migrations, concurrent metadata access, storage GC, notification delivery, policies, Object Lock, encryption, and cluster startup.
- Refresh the README, security policy, architecture, CLI, configuration, storage, testing, and operational documentation.

[0.1.10]: https://github.com/felipedsvit/s3node/releases/tag/v0.1.10
[0.1.11]: https://github.com/felipedsvit/s3node/releases/tag/v0.1.11
[0.1.9]: https://github.com/felipedsvit/s3node/releases/tag/v0.1.9
[previous releases]: https://github.com/felipedsvit/s3node/releases
