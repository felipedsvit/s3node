import { S3Error } from '../errors.js'
import { parseBoundary, parseFormData } from '../features/formdata.js'
import { resolveKey, verifyPostPolicy } from '../features/postpolicy.js'
import { baseHeaders, sendEmpty, sendXml } from '../http.js'
import { document, text } from '../xml.js'
import { notify } from './shared.js'

/**
 * Browser form upload: `POST /{bucket}` with multipart/form-data.
 *
 * Unlike every other route this one authenticates itself, because the
 * credential and signature arrive as form fields rather than headers. The
 * router therefore reaches it before the normal SigV4 path runs.
 */
export async function postObject(ctx, res, { store, server }) {
  const contentType = String(ctx.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new S3Error('MalformedPOSTRequest', 'POST uploads require multipart/form-data')
  }
  store.requireBucket(ctx.bucket)

  const { fields, file } = await parseFormData(ctx.bodyStreams, {
    boundary: parseBoundary(contentType),
  })
  if (!file) throw new S3Error('MalformedPOSTRequest', 'The POST request is missing a file field')

  let verified
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
    // The form told us who is uploading; a bucket policy still gets its say.
    server.authorizePostUpload(ctx, key, verified.accessKeyId)
  } catch (err) {
    file.stream.destroy()
    throw err
  }

  const metadata = {}
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

  // content-length-range is only knowable once the body has been read.
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
  const extraHeaders = {
    ETag: result.etag,
    ...(result.versioned && result.versionId ? { 'x-amz-version-id': result.versionId } : {}),
  }

  const redirect = fields.get('success_action_redirect') ?? fields.get('redirect')
  if (redirect) {
    let target
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
