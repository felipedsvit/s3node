# Security Policy

## Supported Versions

s3node follows semantic versioning. Security updates are provided for:

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ |
| < 0.1   | ❌ |

## Reporting a Vulnerability

Report security issues via email to `felipedsvit@gmail.com` with the subject prefix `[s3node security]`. Include a reproduction case and timeline. We'll confirm receipt within 48 hours and provide a timeline for a fix.

Do not open a public GitHub issue for security vulnerabilities — it exposes users to the risk before a patch is available.

## Known Design Decisions

### Encryption

Object data uses **AES-256-CTR** (not GCM) to support arbitrary Range reads without re-processing from the beginning. CTR mode does not provide integrity authentication by itself; the trade-off is:

- **Wrap cipher (key storage)**: AES-256-GCM — authenticated, protects the data encryption key.
- **Data cipher (object content)**: AES-256-CTR — no built-in authentication.

An attacker with write access to the storage backend (compromised host, corrupted backup restore) could modify ciphertext and serve corrupted plaintext to clients without detection. Mitigation:

- Assume the storage backend is trusted (same host, same disk I/O path as S3 server code).
- Operator responsibility: protect `/data` directory permissions, use encrypted storage if untrusted infrastructure.
- ETag/checksum on GetObject is *not* re-validated on the read path (only computed on write).

This is not a bug — it is a documented architectural boundary. If integrity checking on read is required (e.g., compliance mandate), use a reverse proxy with TLS termination + client-side checksum validation, or request a future enhancement.

### Plaintext Transmission

This server listens on **HTTP only** (not HTTPS). It is designed to run behind a TLS-terminating reverse proxy (nginx, HAProxy, Kubernetes ingress). Binding to loopback by default:

```bash
s3node --host 127.0.0.1 --port 9000  # Default: localhost only
```

If you expose it beyond localhost without a TLS proxy, credentials and object data travel in cleartext.

### Authentication

The admin console uses **HTTP Basic Auth** (Base64-encoded credentials in the `Authorization` header). This is acceptable only because:

- Console binds loopback by default.
- Operator must terminate TLS before exposing to a network.

S3 API operations use **AWS SigV4** signature verification (request body signed, not encrypted).

## Security Scanning

Code is scanned with:
- **CodeQL** (GitHub default) — enabled
- **Snyk Code** — enabled weekly
- **njsscan** — enabled on push

Scanner results are reviewed and false positives are dismissed (e.g., MD5 is used per S3 protocol, not as a security control; HTTP-only is by design).
