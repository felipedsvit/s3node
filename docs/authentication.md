# Authentication

## SigV4 (Signature Version 4)

s3node implements full AWS SigV4 signing and verification with zero external dependencies.

### Authorization header

Standard `Authorization: AWS4-HMAC-SHA256 Credential=.../.../.../s3/aws4_request, SignedHeaders=..., Signature=...`

The `host` header is always required in the signed headers.

### Presigned URLs

Query-string authentication with `X-Amz-Signature`, `X-Amz-Expires`, and `X-Amz-Credential`.

Maximum expiry: 7 days. Time skew: max 15 minutes.

### Payload modes

All four AWS payload modes are supported:

| Mode | x-amz-content-sha256 | Description |
|------|---------------------|-------------|
| Literal SHA-256 | `<hex sha256>` | Full body hash; simplest mode |
| Unsigned payload | `UNSIGNED-PAYLOAD` | No body hash; for streaming |
| Signed chunked | `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` | Per-chunk signature verification |
| Signed chunked + trailers | `STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER` | Signed chunks + signed trailers (e.g. checksums) |

## Chunked encoding

The `aws-chunked` framing wraps request bodies with per-chunk signatures. s3node's ChunkedDecoder strips the framing and validates the signature chain.

The AWS CLI and SDK use chunked encoding by default. Without proper decoding, the framing bytes would be stored as part of the object, corrupting every upload.

- Max chunk size: 1 GiB
- Max line length: 8192 bytes
- Per-chunk verification via `AWS4-HMAC-SHA256-PAYLOAD` string-to-sign
- Trailer verification via `AWS4-HMAC-SHA256-TRAILER`
- Decoded length verified against `x-amz-decoded-content-length`

## Credentials

Credentials are `{ accessKeyId, secretAccessKey }` pairs stored in an in-memory map (CredentialStore).

- Auto-generated on CLI startup (random 20-char hex access key + 40-char base64url secret)
- Or provided via `--access-key` / `--secret-key` / `S3NODE_ACCESS_KEY_ID` / `S3NODE_SECRET_ACCESS_KEY`
- Or passed programmatically via `credentials` array in `createServer()`
- The auto-generated credential is ephemeral — it is never persisted to disk

## Anonymous access

Requests without an `Authorization` header or `X-Amz-Signature` query parameter are treated as anonymous. Access is then allowed or denied based on the bucket policy (if one exists).

## POST policy (browser uploads)

Signed policy documents for browser-based form uploads:

`POST /{bucket}` with a multipart/form-data body containing a UTF-8-encoded and base64-encoded policy JSON document, signed with the secret key.

Supported conditions:
- `eq` — exact match
- `starts-with` — prefix match
- `content-length-range` — byte range validation
- `${filename}` substitution in keys
- `success_action_redirect` / `success_action_status`
