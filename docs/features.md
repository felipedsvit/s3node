# Features

## Lifecycle

Lifecycle rules manage object expiration automatically.

Rules support:
- **Days expiration** — expire objects N days after `lastModified`
- **Date expiration** — expire objects on a specific date
- **ExpiredObjectDeleteMarker** — clean up delete markers when no non-current versions remain
- **NoncurrentVersionExpiration** — remove non-current versions after N days
- **AbortIncompleteMultipartUpload** — abort stale multipart uploads after N days
- **Filtering** by prefix and object tags
- **Status**: Enabled or Disabled
- **Max 1000 rules** per bucket, max depth 32 in XML

**Lifecycle does not run automatically.** You must either:
- Set `lifecycleIntervalMs` in programmatic options (> 0)
- Call `server.runLifecycle()` manually

```js
const summary = await server.runLifecycle()
// { expiredObjects: 5, expiredVersions: 2, abortedUploads: 1 }
```

## Notifications

Webhook-based event notifications.

### Supported events
- `s3:ObjectCreated:*`, `s3:ObjectCreated:Put`, `s3:ObjectCreated:Post`
- `s3:ObjectCreated:Copy`, `s3:ObjectCreated:CompleteMultipartUpload`
- `s3:ObjectRemoved:*`, `s3:ObjectRemoved:Delete`, `s3:ObjectRemoved:DeleteMarkerCreated`

### Configuration
Uses a custom `<WebhookConfiguration>` element (not SQS/SNS/Lambda).

### Delivery
- SQLite-backed persistent queue with exponential backoff retry
- HTTP POST with `content-type: application/json` and `x-amz-event-source: s3node` header
- 5-second timeout per delivery
- Max 6 delivery attempts, base backoff 1s, max backoff 60s
- Dead-letter after max attempts (status: `dead`)
- Payload matches S3 event format (`Records[].eventVersion: "2.1"`, `eventSource: "aws:s3"`)

## Object Lock

WORM (Write-Once-Read-Many) retention for object versions.

### Requirements
- Bucket must have versioning enabled

### Retention modes
- **GOVERNANCE** — can be bypassed with `x-amz-bypass-governance-retention: true`
- **COMPLIANCE** — cannot be bypassed; truly immutable until expiry

### Legal hold
- ON/OFF flag that blocks deletion unconditionally
- Outranks both retention modes

### Default retention
Configurable at bucket level (mode + days/years). Applied to objects without explicit lock headers.

### Lock headers (PutObject)
- `x-amz-object-lock-mode`: GOVERNANCE or COMPLIANCE
- `x-amz-object-lock-retain-until-date`: ISO 8601 date
- `x-amz-object-lock-legal-hold`: ON or OFF

### Delete behavior
- Writing a delete marker over a locked object is **allowed** (hides the data without destroying it)
- Deleting a specific version that is locked is **blocked**

## CORS

Full CORS support:
- XML configuration round-trip
- Origin matching with wildcards
- Preflight responses (`OPTIONS` requests)
- Configurable allowed methods, headers, and expose-headers

## Bucket policies

IAM-style bucket policies:
- Allow, Deny, and NoDecision evaluation
- Principal matching
- Condition operators: StringEquals, StringLike, IpAddress, Bool, Null, NumericEquals, and their ...IfExists variants
- Wildcard action/resource matching
- Explicit deny priority

## Tagging

- **Bucket tagging**: up to 50 tags
- **Object tagging**: up to 10 tags
- Tags are key-value pairs, managed via `?tagging` subresource

## POST uploads

Browser-based form uploads:
- `POST /{bucket}` with multipart/form-data
- Signed policy documents
- `${filename}` key substitution
- `content-length-range` validation
- `success_action_redirect` / `success_action_status`

## Bucket quotas

Bucket-level quotas (set programmatically or via MetadataStore):
- `maxBucketSize` (bytes)
- `maxObjects` (count)

Enforced on writes — returns `QuotaExceeded` (403) when exceeded.
