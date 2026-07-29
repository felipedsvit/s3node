# CLI Reference

## Usage

```sh
s3node [options]
```

Or without installing:

```sh
npx @felipedsvit/s3node [options]
```

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--data-dir <path>` | --- | `./s3node-data` | Directory for blobs + `metadata.sqlite` |
| `--port <number>` | --- | `9000` | S3 API listening port |
| `--host <address>` | --- | `127.0.0.1` | Bind address |
| `--region <name>` | --- | `us-east-1` | Region reported to clients |
| `--access-key <id>` | `S3NODE_ACCESS_KEY_ID` | auto-generated | Access key for SigV4 |
| `--secret-key <secret>` | `S3NODE_SECRET_ACCESS_KEY` | auto-generated | Secret key for SigV4 |
| `--virtual-host <domain>` | --- | off | Enable `bucket.domain` addressing |
| `--cluster [count]` | --- | off | Workers: one per core or explicit count |
| `--console-port <port>` | --- | off | Admin console HTTP port |
| `--quiet` | --- | false | Suppress request error logging |
| `--help` | --- | --- | Show usage |

`--access-key` and `--secret-key` must be given together.

## Examples

```sh
# Basic server
s3node --data-dir ./data --port 9000

# With stable credentials
s3node --data-dir ./data --access-key AKIDTEST --secret-key test-secret

# With admin console
s3node --data-dir ./data --port 9000 --console-port 9001

# Cluster mode (one worker per CPU core)
s3node --data-dir ./data --port 9000 --cluster

# Cluster mode with 4 workers
s3node --data-dir ./data --port 9000 --cluster 4

# Virtual-host-style addressing
s3node --data-dir ./data --virtual-host s3.example.com

# Quiet mode (no request error output)
s3node --data-dir ./data --quiet
```