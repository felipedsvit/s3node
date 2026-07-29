# S3 API Reference

## Service

| Operation | HTTP | Description |
|-----------|------|-------------|
| ListBuckets | GET / | List all buckets |

## Bucket

| Operation | HTTP | Description |
|-----------|------|-------------|
| CreateBucket | PUT /{bucket} | Create a new bucket |
| DeleteBucket | DELETE /{bucket} | Delete an empty bucket |
| HeadBucket | HEAD /{bucket} | Check if bucket exists |
| GetBucketLocation | GET /{bucket}?location | Get bucket region |
| ListObjectsV1 | GET /{bucket} | List objects (V1) |
| ListObjectsV2 | GET /{bucket}?list-type=2 | List objects (V2) |
| ListObjectVersions | GET /{bucket}?versions | List all object versions |
| DeleteObjects | POST /{bucket}?delete | Multi-object delete |
| ListMultipartUploads | GET /{bucket}?uploads | List in-progress multipart uploads |
| GetBucketVersioning | GET /{bucket}?versioning | Get versioning config |
| PutBucketVersioning | PUT /{bucket}?versioning | Enable/suspend versioning |
| GetBucketPolicy | GET /{bucket}?policy | Get bucket policy |
| PutBucketPolicy | PUT /{bucket}?policy | Set bucket policy |
| DeleteBucketPolicy | DELETE /{bucket}?policy | Delete bucket policy |
| GetBucketCORS | GET /{bucket}?cors | Get CORS config |
| PutBucketCORS | PUT /{bucket}?cors | Set CORS config |
| DeleteBucketCORS | DELETE /{bucket}?cors | Delete CORS config |
| GetLifecycleConfiguration | GET /{bucket}?lifecycle | Get lifecycle rules |
| PutLifecycleConfiguration | PUT /{bucket}?lifecycle | Set lifecycle rules |
| DeleteLifecycleConfiguration | DELETE /{bucket}?lifecycle | Delete lifecycle rules |
| GetBucketTagging | GET /{bucket}?tagging | Get bucket tags |
| PutBucketTagging | PUT /{bucket}?tagging | Set bucket tags |
| DeleteBucketTagging | DELETE /{bucket}?tagging | Delete bucket tags |
| GetBucketNotification | GET /{bucket}?notification | Get notification config |
| PutBucketNotification | PUT /{bucket}?notification | Set notification config |
| GetObjectLockConfiguration | GET /{bucket}?object-lock | Get Object Lock config |
| PutObjectLockConfiguration | PUT /{bucket}?object-lock | Set Object Lock config |

## Object

| Operation | HTTP | Description |
|-----------|------|-------------|
| PutObject | PUT /{bucket}/{key} | Upload an object |
| GetObject | GET /{bucket}/{key} | Download an object |
| HeadObject | HEAD /{bucket}/{key} | Get object metadata |
| DeleteObject | DELETE /{bucket}/{key} | Delete an object |
| CopyObject | PUT /{bucket}/{key} (with x-amz-copy-source) | Copy an object |
| PutObjectTagging | PUT /{bucket}/{key}?tagging | Set object tags |
| GetObjectTagging | GET /{bucket}/{key}?tagging | Get object tags |
| DeleteObjectTagging | DELETE /{bucket}/{key}?tagging | Delete object tags |
| PutObjectRetention | PUT /{bucket}/{key}?retention | Set retention (Object Lock) |
| GetObjectRetention | GET /{bucket}/{key}?retention | Get retention |
| PutObjectLegalHold | PUT /{bucket}/{key}?legal-hold | Set legal hold |
| GetObjectLegalHold | GET /{bucket}/{key}?legal-hold | Get legal hold |

## Multipart

| Operation | HTTP | Description |
|-----------|------|-------------|
| CreateMultipartUpload | POST /{bucket}/{key}?uploads | Start multipart upload |
| UploadPart | PUT /{bucket}/{key}?uploadId=&partNumber= | Upload a part |
| UploadPartCopy | PUT /{bucket}/{key}?uploadId=&partNumber= (with x-amz-copy-source) | Copy a part |
| CompleteMultipartUpload | POST /{bucket}/{key}?uploadId= | Complete multipart upload |
| AbortMultipartUpload | DELETE /{bucket}/{key}?uploadId= | Abort multipart upload |
| ListParts | GET /{bucket}/{key}?uploadId= | List uploaded parts |

## POST (Browser uploads)

The full POST object upload with signed policy documents is supported:

- `POST /{bucket}` — Browser form uploads with signed policy
- Supports `${filename}` key substitution
- `content-length-range` validation
- `success_action_redirect` / `success_action_status`

## Supported headers and features

- **Range reads**: `Range`, `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`
- **Metadata**: `x-amz-meta-*` headers
- **Tagging**: object and bucket tagging
- **Server-side encryption**: SSE-C and SSE-S3
- **Checksums**: `x-amz-checksum-*` headers and trailers (CRC32, CRC32C, SHA1, SHA256)
- **Presigned URL response overrides**: `response-content-type`, `response-content-disposition`, etc.
- **Auth modes**: SigV4 (header), presigned URL (query string), anonymous (judged by bucket policy)
- **Payload modes**: literal SHA-256, UNSIGNED-PAYLOAD, STREAMING-AWS4-HMAC-SHA256-PAYLOAD, STREAMING-UNSIGNED-PAYLOAD-TRAILER

## Not implemented

These return `NotImplemented` instead of silently succeeding:

acl, website, replication, encryption (bucket-level default), accelerate, logging, requestPayment, analytics, inventory, metrics, publicAccessBlock, intelligent-tiering, ownershipControls, restore, select
