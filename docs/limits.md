# Limits

## Single node

s3node is a single-node server. Durability is delegated to the filesystem underneath (RAID, ZFS, or replication at the storage layer). There is no erasure coding, no multi-node replication, and no automatic failover. This is a deliberate scope decision.

## No sendfile

Node.js has no `sendfile` binding, so every read pays extra memory copies. For large objects, this means higher CPU usage per byte served compared to Go or Rust servers.

## Metadata write serialization

In cluster mode, SQLite WAL allows concurrent reads but serializes writes. The metadata write rate is the effective throughput ceiling for object creates, deletes, and metadata updates.

## Object size

| Limit | Default | Configurable |
|-------|---------|-------------|
| Max object size | 5 TiB | `maxObjectSize` |
| Min multipart part size | 5 MiB | `minPartSize` |

## Concurrent operations

| Limit | Default | Configurable |
|-------|---------|-------------|
| Max multipart uploads | 1000 | `maxConcurrentUploads` |
| Max blob writes | unlimited | `maxConcurrentWrites` |

## Comparison with alternatives

| Feature | s3node | MinIO | LocalStack |
|---------|--------|-------|------------|
| In-process (Node) | yes | no | no |
| Install | npm, 0 deps | Go binary / container | Docker + Python |
| Startup | milliseconds | seconds + pull | seconds |
| Scope | S3 API | S3 + erasure coding | Most of AWS |
| Multi-node | no | yes | no |
| Erasure coding | no | yes | no |

## When to use something else

- You need multi-node replication or erasure coding -> use MinIO
- You need other AWS services (SQS, DynamoDB, Lambda) -> use LocalStack
- You need maximum throughput per node -> use MinIO (Go), or a CDN-backed solution
