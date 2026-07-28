import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../../dist/src/index.js'
import { TestClient } from './client.js'

export const CREDENTIAL = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

export const OTHER_CREDENTIAL = {
  accessKeyId: 'AKIDSECOND',
  secretAccessKey: 'second-secret-access-key-value-here',
}

/** Boots a throwaway server backed by a temp directory. */
export async function startServer(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 's3node-test-'))
  const server = await createServer({
    dataDir: join(root, 'data'),
    credentials: [CREDENTIAL, OTHER_CREDENTIAL],
    minPartSize: 16,
    ...options,
  })
  const client = new TestClient({ endpoint: server.endpoint, ...CREDENTIAL })
  const other = new TestClient({ endpoint: server.endpoint, ...OTHER_CREDENTIAL })
  return {
    root,
    server,
    client,
    other,
    endpoint: server.endpoint,
    async cleanup() {
      await server.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export function unescapeXml(value) {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

export function tag(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? unescapeXml(match[1]) : undefined
}

export function allTags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))]
    .map((match) => unescapeXml(match[1]))
}

/**
 * Drops every bucket. Deletion goes through ListObjectVersions rather than
 * ListObjectsV2 because in a versioned bucket a plain DELETE only writes a
 * delete marker, which would leave the bucket non-empty.
 */
export async function resetBuckets(client) {
  const listing = await client.request({ method: 'GET' })
  for (const name of allTags(listing.text, 'Name')) {
    const uploads = await client.request({ method: 'GET', bucket: name, query: { uploads: '' } })
    const uploadIds = allTags(uploads.text, 'UploadId')
    const uploadKeys = allTags(uploads.text, 'Key')
    for (const [index, uploadId] of uploadIds.entries()) {
      await client.request({
        method: 'DELETE', bucket: name, key: uploadKeys[index], query: { uploadId },
      })
    }

    for (let page = 0; page < 50; page++) {
      const versions = await client.request({ method: 'GET', bucket: name, query: { versions: '' } })
      const entries = versionBlocks(versions.text)
      if (entries.length === 0) break
      for (const entry of entries) {
        await client.request({
          method: 'DELETE', bucket: name, key: entry.key, query: { versionId: entry.versionId },
        })
      }
    }

    const dropped = await client.request({ method: 'DELETE', bucket: name })
    if (dropped.status !== 204) {
      throw new Error(`failed to drop bucket ${name}: ${dropped.status} ${dropped.text}`)
    }
  }
}

/** Extracts each `<Version>`/`<DeleteMarker>` block from a ListVersions body. */
export function versionBlocks(xml) {
  return [...xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)].map((match) => ({
    type: match[1],
    key: tag(match[2], 'Key'),
    versionId: tag(match[2], 'VersionId'),
    isLatest: tag(match[2], 'IsLatest') === 'true',
    size: tag(match[2], 'Size'),
  }))
}
