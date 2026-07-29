# Configuration

## Configuration sources (by priority)

1. **Programmatic options** (passed to `createServer()`)
2. **Environment variables** (read by CLI)
3. **CLI flags**
4. **Defaults**

## Environment variables

| Variable | Corresponding CLI flag |
|----------|----------------------|
| `S3NODE_ACCESS_KEY_ID` | `--access-key` |
| `S3NODE_SECRET_ACCESS_KEY` | `--secret-key` |

## Complete options map

| Purpose | CLI flag | Env var | Programmatic | Default |
|---------|----------|---------|-------------|---------|
| Data directory | `--data-dir` | --- | `dataDir` | `./s3node-data` |
| S3 API port | `--port` | --- | `port` | `9000` |
| Bind address | `--host` | --- | `host` | `127.0.0.1` |
| AWS region | `--region` | --- | `region` | `us-east-1` |
| Access key | `--access-key` | `S3NODE_ACCESS_KEY_ID` | `credentials[].accessKeyId` | auto-generated |
| Secret key | `--secret-key` | `S3NODE_SECRET_ACCESS_KEY` | `credentials[].secretAccessKey` | auto-generated |
| Virtual-host domain | `--virtual-host` | --- | `virtualHostDomain` | off |
| Cluster workers | `--cluster` | --- | *(use CLI)* | off |
| Console port | `--console-port` | --- | *(separate server)* | off |
| Quiet mode | `--quiet` | --- | `logger: null` | false |
| Min part size | --- | --- | `minPartSize` | 5 MiB |
| Max object size | --- | --- | `maxObjectSize` | 5 TiB |
| Max concurrent uploads | --- | --- | `maxConcurrentUploads` | 1000 |
| Max concurrent writes | --- | --- | `maxConcurrentWrites` | 0 (unlimited) |
| Encryption master key | --- | --- | `encryptionMasterKey` | null (reads `master.key`) |
| Lifecycle interval | --- | --- | `lifecycleIntervalMs` | 0 (off) |
| Notification interval | --- | --- | `notificationIntervalMs` | 2000 |
| Rate limit (per sec) | --- | --- | `rateLimitPerSecond` | unset |
| Rate limit burst | --- | --- | `rateLimitBurst` | same as rate |
| Logger | --- | --- | `logger` | null |
| SO_REUSEPORT | --- | --- | `reusePort` | false |

## Notes

- `credentials` is an array in programmatic mode but the CLI only supports a single credential.
- `lifecycleIntervalMs` has no CLI flag — it only runs programmatically or via `server.runLifecycle()`.
- `encryptionMasterKey` can be a base64 string or Buffer. If not provided, s3node reads/writes `master.key` in the data directory.
- The CLI auto-generates one credential when none is provided. The secret is ephemeral and never persisted.