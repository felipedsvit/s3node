import { Readable } from 'node:stream'
import { GarbageCollector } from '../../dist/src/storage/gc.js'
import { MetadataStore } from '../../dist/src/storage/metadata.js'
import { ObjectStore } from '../../dist/src/storage/store.js'

const [action, dataDir, payload = ''] = process.argv.slice(2)

if (action === 'migrate') {
  new MetadataStore(dataDir)
  process.exit(42)
}

const store = await ObjectStore.open({ dataDir, minPartSize: 1 })
try {
  if (action === 'put') {
    await store.putObject({ bucket: 'crash-bucket', key: 'key', body: Readable.from([Buffer.from(payload)]) })
  } else if (action === 'part') {
    const { uploadId, partNumber, body } = JSON.parse(payload)
    await store.uploadPart({
      bucket: 'crash-bucket', key: 'multipart', uploadId, partNumber,
      body: Readable.from([Buffer.from(body)]),
    })
  } else if (action === 'complete') {
    const { uploadId, requestedParts } = JSON.parse(payload)
    await store.completeMultipartUpload({
      bucket: 'crash-bucket', key: 'multipart', uploadId, requestedParts,
    })
  } else if (action === 'gc') {
    await new GarbageCollector(store).collect()
  } else {
    throw new Error(`unknown crash action: ${action}`)
  }
} finally {
  store.close()
}

// Every crash scenario is expected to die at its requested point.
process.exit(42)
