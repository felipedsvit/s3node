# s3node Documentation

**s3node** is an embeddable, S3-compatible object storage server that runs inside your Node.js process. No containers, no binaries, no runtime dependencies.

## Contents

| # | Document | Description |
|---|----------|-------------|
| 1 | [Getting Started](getting-started.md) | Run the server, create a bucket, upload and download |
| 2 | [Installation](installation.md) | Requirements, npm install, credential auto-generation |
| 3 | [CLI Reference](cli.md) | All command-line flags and environment variables |
| 4 | [Programmatic Usage](programmatic.md) | Embed s3node with createServer() |
| 5 | [Configuration](configuration.md) | Complete config map: CLI, env, programmatic |
| 6 | [Admin Console](admin-console.md) | Web UI, JSON API, health and metrics endpoints |
| 7 | [S3 API Reference](s3-api.md) | All supported S3 operations + NotImplemented list |
| 8 | [Authentication](authentication.md) | SigV4, presigned URLs, chunked encoding, POST policy |
| 9 | [Encryption](encryption.md) | SSE-C and SSE-S3 server-side encryption |
| 10 | [Storage](storage.md) | On-disk layout, atomic writes, SQLite schema, blob fanout |
| 11 | [Cluster Mode](cluster.md) | Multi-worker with SO_REUSEPORT |
| 12 | [Features](features.md) | Lifecycle, notifications, Object Lock, CORS, policies, tagging |
| 13 | [Testing](testing.md) | Running tests, interop suite, coverage |
| 14 | [Architecture](architecture.md) | Design decisions, how it works |
| 15 | [Limits](limits.md) | Known limits, comparisons with MinIO and LocalStack |
