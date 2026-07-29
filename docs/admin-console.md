# Admin Console

The admin console is a self-contained, dependency-free web UI for browsing buckets and objects, uploading, downloading, and deleting.

It runs on a **separate port** (not a path on the S3 endpoint) because every path there is already a bucket name.

## Enable the console

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000 --console-port 9001
```

Open `http://127.0.0.1:9001` in your browser. Authenticate with any s3node credential over HTTP Basic.

## Security

- Authenticates with HTTP Basic using s3node credentials
- Binds `--host` (loopback `127.0.0.1` by default)
- Speaks plain HTTP — **put it behind TLS before exposing it off the machine**
- CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'none'`

## Web UI features

- Dark/light theme (follows `prefers-color-scheme`)
- Bucket list with create and delete
- Object listing with prefix filter
- Upload via file input
- Download (directs browser to object URL)
- Delete objects
- Header showing region, version, bucket count, object count, total bytes

## JSON API

All endpoints except `/-/health` and `/metrics` require HTTP Basic authentication with an s3node credential.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/-/health` | No | Returns `"ok\n"` |
| GET | `/metrics` | No | Prometheus metrics |
| GET | `/` or `/index.html` | Basic | Web UI page |
| GET | `/favicon.svg` | Basic | Inline SVG favicon |
| GET | `/api/info` | Basic | Server summary |
| GET | `/api/buckets` | Basic | List all buckets |
| POST | `/api/bucket?name=` | Basic | Create a bucket |
| DELETE | `/api/bucket?name=` | Basic | Delete a bucket |
| GET | `/api/objects?bucket=&prefix=` | Basic | List objects (capped at 1000) |
| GET | `/api/object?bucket=&key=` | Basic | Download an object |
| PUT | `/api/object?bucket=&key=` | Basic | Upload an object |
| DELETE | `/api/object?bucket=&key=` | Basic | Delete an object |

### Examples

```sh
# Server info
curl -u AKIDTEST:test-secret http://127.0.0.1:9001/api/info
```

```json
{"region":"us-east-1","version":"0.1.6","buckets":3,"objects":42,"bytes":1048576}
```

```sh
# List buckets
curl -u AKIDTEST:test-secret http://127.0.0.1:9001/api/buckets
```

```json
{"buckets":[{"name":"my-bucket","createdAt":"2025-01-15T10:30:00.000Z"}]}
```

```sh
# List objects
curl -u AKIDTEST:test-secret 'http://127.0.0.1:9001/api/objects?bucket=my-bucket&prefix=photos/'
```

```json
{"objects":[{"key":"photos/sunset.jpg","size":204800,"etag":"\"abc123\"","lastModified":"2025-01-15T10:31:00.000Z"}],"truncated":false}
```