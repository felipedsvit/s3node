# Encryption

s3node supports two server-side encryption modes. Both use AES-256-CTR for the data cipher, which supports seekable byte-range reads.

## SSE-C (Customer-Provided Keys)

The client supplies the encryption key on every request.

### PutObject

```
x-amz-server-side-encryption-customer-algorithm: AES256
x-amz-server-side-encryption-customer-key: <base64-encoded 256-bit key>
x-amz-server-side-encryption-customer-key-md5: <base64 MD5 of the key>
```

### GetObject / HeadObject

The same headers must be provided. If the wrong key is supplied, `AccessDenied` is returned (constant-time comparison).

The key is **never stored** — only its MD5 is saved to verify it is provided again on reads.

## SSE-S3 (Server-Side Encryption with s3node-managed key)

The server manages the encryption key.

### PutObject

```
x-amz-server-side-encryption: AES256
```

### Master key

The master key is:
- Read from `<dataDir>/master.key` (base64, 32 bytes, mode 0600) if the file exists
- Or auto-created at `<dataDir>/master.key` if the file does not exist
- Or provided programmatically via `encryptionMasterKey` option (base64 string or Buffer)

### Per-object data key

For each object, a random 256-bit data key is generated. The data key is wrapped (encrypted) with AES-256-GCM using the master key. The wrapped key, wrap IV, GCM auth tag, and data IV are stored in the object's metadata.

On read, the data key is unwrapped and used to decrypt.

### Data cipher: AES-256-CTR

Both modes use AES-256-CTR (counter mode) for object data. CTR mode was chosen because it supports arbitrary byte-range reads — you can seek to any position without re-processing from the beginning.

**Trade-off**: CTR provides no integrity authentication. See SECURITY.md for the full security boundary.

### Multipart encryption

Each part in a multipart encrypted upload uses the same base IV but with the part number shifted into the high 64 bits of the counter (GF(2^128) arithmetic).

### Response headers

SSE-C responses include:
- `x-amz-server-side-encryption-customer-algorithm`
- `x-amz-server-side-encryption-customer-key-MD5`

SSE-S3 responses include:
- `x-amz-server-side-encryption: AES256`
