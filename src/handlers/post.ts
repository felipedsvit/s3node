import type { ServerResponse } from 'node:http'
import { S3Error } from '../errors.js'
import { parseBoundary, parseFormData } from '../features/formdata.js'
import { resolveKey, verifyPostPolicy } from '../features/postpolicy.js'
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

  const metadata: Record<string, string> = {}
  for (const [name, value] of fields) {
    if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value
  }

  const result = await store.putObject({
    bucket: ctx.bucket,
    key,
    body: [file.stream],
    contentType: fields.get('content-type') ?? file.contentType,
    metadata,
  })

  if (verified.range) {
    const { min, max } = verified.range
    if (result.size < min || result.size > max) {
      await store.deleteObject(ctx.bucket, key, result.versioned ? result.versionId : null)
      throw new S3Error('EntityTooLarge',
        `The uploaded body must be between ${min} and ${max} bytes`)
    }
  }

  notify(server, {
    bucket: ctx.bucket, eventName: 'ObjectCreated:Post', key,
    size: result.size, etag: result.etag, versionId: result.versionId,
  })

  const location = `http://${ctx.headers.host ?? 'localhost'}/${ctx.bucket}/${encodeURIComponent(key)}`
  const extraHeaders: Record<string, string> = {
    ETag: result.etag,
    ...(result.versioned && result.versionId ? { 'x-amz-version-id': result.versionId } : {}),
  }

  const redirect = fields.get('success_action_redirect') ?? fields.get('redirect')
  if (redirect) {
    let target: URL
    try {
      target = new URL(redirect)
    } catch {
      throw new S3Error('MalformedPOSTRequest', 'success_action_redirect is not a valid URL')
    }
    target.searchParams.set('bucket', ctx.bucket)
    target.searchParams.set('key', key)
    target.searchParams.set('etag', result.etag)
    res.writeHead(303, { ...baseHeaders(ctx), ...extraHeaders, Location: target.toString(), 'Content-Length': 0 })
    res.end()
    return
  }

  const status = Number.parseInt(fields.get('success_action_status') ?? '204', 10)
  if (status === 201) {
    sendXml(ctx, res, 201, document('PostResponse',
      text('Location', location) + text('Bucket', ctx.bucket) +
      text('Key', key) + text('ETag', result.etag)), extraHeaders)
    return
  }
  sendEmpty(ctx, res, status === 200 ? 200 : 204, extraHeaders)
}
