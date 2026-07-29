# Cluster Mode

Cluster mode runs multiple worker processes that share the same port using `SO_REUSEPORT`.

## Requirements

- **Node.js >= 22.12.0** (for `SO_REUSEPORT` support)

## Enabling cluster mode

```sh
# One worker per CPU core
npx @felipedsvit/s3node --data-dir ./data --port 9000 --cluster

# Exactly 4 workers
npx @felipedsvit/s3node --data-dir ./data --port 9000 --cluster 4
```

## How it works

- Each worker binds the same port via `SO_REUSEPORT`
- The kernel distributes incoming connections across workers
- There is no relay process — each worker handles requests independently
- The primary process forks workers, assigns stable slot IDs via `S3NODE_WORKER_ID`, and respawns crashed workers

## Concurrency model

Metadata is stored in SQLite with WAL mode. This lets readers proceed while one writer commits. Blocked writers wait with a 5-second `busy_timeout`.

**Scaling caveat**: Workers scale request handling, hashing, and encryption — but metadata write rate is serialized across the cluster (SQLite serializes writes).

## Worker-specific responsibilities

- **Worker 1 only**: Lifecycle sweeps, admin console, metrics
- **All workers**: S3 API request handling

## Graceful shutdown

The primary sends a `shutdown` message to workers. Workers exit on `SIGTERM` / `SIGINT`.
