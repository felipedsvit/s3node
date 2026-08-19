import type { ServerResponse } from 'node:http'
import { S3Error } from '../errors.js'
import { parseBoundary, parseFormData } from '../features/formdata.js'
import { resolveKey, verifyPostPolicy } from '../features/postpolicy.js'
import { lockFromHeaders } from '../features/objectlock.js'
import { baseHeaders, sendEmpty, sendXml, type RequestContext } from '../http.js'
import { document, text } from '../xml.js'
import { notify } from './shared.js'
import type { ObjectStore } from '../storage/store.js'
import type { S3NodeServer } from '../server.js'

export async function postObject(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  const contentType = String(ctx.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new S3Error('MalformedPOSTRequest', 'POST uploads require multipart/form-data')
  }
  store.requireBucket(ctx.bucket)

  const { fields, file } = await parseFormData(ctx.bodyStreams as NodeJS.ReadableStream[], {
    boundary: parseBoundary(contentType),
  })
  if (!file) throw new S3Error('MalformedPOSTRequest', 'The POST request is missing a file field')

  let verified: { accessKeyId: string; policy: Record<string, unknown>; range: { min: number; max: number } | null }
  try {
    verified = verifyPostPolicy({
      fields,
      bucket: ctx.bucket,
      lookupCredential: server.credentials.lookup,
      region: server.region,
    })
  } catch (err) {
    file.stream.destroy()
    throw err
  }

  const key = resolveKey(fields.get('key'), file.filename)
  try {
    server.authorizePostUpload(ctx, key, verified.accessKeyId)
  } catch (err) {
    file.stream.destroy()
    throw err
  }

  const redirect = fields.get('success_action_redirect') ?? fields.get('redirect')
  let redirectTarget: URL | null = null
  if (redirect) {
    try {
      redirectTarget = new URL(redirect)
    } catch {
      file.stream.destroy()
      throw new S3Error('MalformedPOSTRequest', 'success_action_redirect is not a valid URL')
    }
    if (redirectTarget.protocol !== 'http:' && redirectTarget.protocol !== 'https:') {
      file.stream.destroy()
      throw new S3Error('MalformedPOSTRequest', 'success_action_redirect must use http or https')
    }
  }

  const metadata: Record<string, string> = {}
  let metadataBytes = 0
  for (const [name, value] of fields) {
    if (name.startsWith('x-amz-meta-')) {
      const metadataName = name.slice('x-amz-meta-'.length)
      metadataBytes += Buffer.byteLength(metadataName) + Buffer.byteLength(value)
      if (metadataBytes > 2048) {
        file.stream.destroy()
        throw new S3Error('InvalidArgument', 'Total user metadata size must not exceed 2 KB')
      }
      metadata[metadataName] = value
    }
  }

  const result = await store.putObject({
    bucket: ctx.bucket,
    key,
    body: [file.stream],
    contentType: fields.get('content-type') ?? file.contentType,
    metadata,
    minSize: verified.range?.min,
    maxSize: verified.range?.max,
    lock: lockFromHeaders(Object.fromEntries(
      [...fields].filter(([name]) => name.startsWith('x-amz-object-lock-')),
    )),
  })

  notify(server, {
    bucket: ctx.bucket, eventName: 'ObjectCreated:Post', key,
    size: result.size, etag: result.etag, versionId: result.versionId,
  })

  const location = `http://${ctx.headers.host ?? 'localhost'}/${ctx.bucket}/${encodeURIComponent(key)}`
  const extraHeaders: Record<string, string> = {
    ETag: result.etag,
    ...(result.versioned && result.versionId ? { 'x-amz-version-id': result.versionId } : {}),
  }

  if (redirectTarget) {
    redirectTarget.searchParams.set('bucket', ctx.bucket)
    redirectTarget.searchParams.set('key', key)
    redirectTarget.searchParams.set('etag', result.etag)
    res.writeHead(303, { ...baseHeaders(ctx), ...extraHeaders, Location: redirectTarget.toString(), 'Content-Length': 0 })
    res.end()
    return
  }

  const status = fields.get('success_action_status') ?? '204'
  if (status === '201') {
    sendXml(ctx, res, 201, document('PostResponse',
      text('Location', location) + text('Bucket', ctx.bucket) +
      text('Key', key) + text('ETag', result.etag)), extraHeaders)
    return
  }
  sendEmpty(ctx, res, status === '200' ? 200 : 204, extraHeaders)
}
