# Getting Started

This guide walks you through running s3node for the first time, creating a bucket, and uploading/downloading objects from the command line.

## Prerequisites

- **Node.js 22.5 or newer** (22.12+ for cluster mode)
- No Docker, no containers, no Go runtime needed

## Run with npx

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000
```

Output:

```
s3node listening on http://127.0.0.1:9000
  data dir     /home/you/project/data
  region       us-east-1
  access key   493C07B6058B1FD72FEC
  secret key   rn_vaYnwVLH-x1GmOw7exX_FnR1ha885XSxQxdWl

This credential was generated for this run. Pass --access-key/--secret-key
(or S3NODE_ACCESS_KEY_ID / S3NODE_SECRET_ACCESS_KEY) to keep it stable.
```

## Work with the AWS CLI

Set the credentials printed by the banner and use `--endpoint-url`:

```sh
export AWS_ACCESS_KEY_ID=493C07B6058B1FD72FEC
export AWS_SECRET_ACCESS_KEY=rn_vaYnwVLH-x1GmOw7exX_FnR1ha885XSxQxdWl

aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://my-bucket
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./file.bin s3://my-bucket/
aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://my-bucket
aws --endpoint-url http://127.0.0.1:9000 s3 cp s3://my-bucket/file.bin ./downloaded.bin
```

## Use in a test

```js
import { createServer } from '@felipedsvit/s3node'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const credentials = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' }
const s3node = await createServer({ dataDir: './tmp-data', credentials: [credentials] })

const client = new S3Client({
  endpoint: s3node.endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials,
})

await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'hello' }))
await s3node.close()
```

`port` defaults to `0`, so every server grabs a free port and parallel test files never collide.

## Use with rclone

```sh
rclone config create s3node s3 \
  provider=Other \
  endpoint=http://127.0.0.1:9000 \
  access_key_id=$AWS_ACCESS_KEY_ID \
  secret_access_key=$AWS_SECRET_ACCESS_KEY \
  region=us-east-1

rclone sync ./photos s3node:my-bucket/photos
```