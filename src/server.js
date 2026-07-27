import { createServer as createHttpServer } from 'node:http'
import { ChunkedDecoder } from './auth/chunked.js'
import { CredentialStore } from './auth/credentials.js'
import {
  STREAMING_PAYLOADS,
  STREAMING_SIGNED,
  STREAMING_SIGNED_TRAILER,
  verifyRequest,
} from './auth/sigv4.js'
import { S3Error } from './errors.js'
import { createContext, sendError } from './http.js'
import { resolveHandler } from './router.js'
import { ObjectStore } from './storage/store.js'

const DEFAULT_REGION = 'us-east-1'

export class S3NodeServer {
  constructor({ store, credentials, region = DEFAULT_REGION, virtualHostDomain = null, logger = null }) {
    this.store = store
    this.credentials = credentials
    this.region = region
    this.virtualHostDomain = virtualHostDomain
    this.logger = logger
    this.http = createHttpServer()

    this.http.on('request', (req, res) => {
      if (req.headers.expect) return // handled by the checkContinue listener
      this._handle(req, res, false)
    })
    this.http.on('checkContinue', (req, res) => {
      this._handle(req, res, true)
    })
    this.http.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
  }

  static async create({
    dataDir,
    credentials = [],
    region = DEFAULT_REGION,
    virtualHostDomain = null,
    minPartSize,
    logger = null,
  } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required')
    const store = await ObjectStore.open({ dataDir, region, minPartSize })
    return new S3NodeServer({
      store,
      credentials: credentials instanceof CredentialStore ? credentials : new CredentialStore(credentials),
      region,
      virtualHostDomain,
      logger,
    })
  }

  /**
   * `Expect: 100-continue` is answered only after the signature checks out, so
   * an unauthorized client is rejected before it uploads the body rather than
   * after (docs/plan.md section 4.8).
   */
  async _handle(req, res, expectContinue) {
    let ctx = null
    try {
      ctx = createContext(req, { virtualHostDomain: this.virtualHostDomain })
      ctx.auth = verifyRequest(ctx, {
        lookupCredential: this.credentials.lookup,
        region: this.region,
      })

      if (expectContinue) res.writeContinue()

      this._attachBody(ctx)
      const handler = resolveHandler(ctx)
      await handler(ctx, res, { store: this.store, server: this })
    } catch (err) {
      const rendered = sendError(ctx, res, err)
      this.logger?.error?.({
        requestId: ctx?.requestId,
        method: req.method,
        url: req.url,
        code: rendered.code,
        message: rendered.message,
        canonicalRequest: rendered.detail?.canonicalRequest,
        stringToSign: rendered.detail?.stringToSign,
      })
    }
  }

  /**
   * Wraps the request in the `aws-chunked` decoder when the payload is
   * streamed. Without this the framing bytes are written into the object and
   * every aws-cli upload is silently corrupted (docs/plan.md section 4.1).
   */
  _attachBody(ctx) {
    const payloadHash = ctx.auth.payloadHash
    if (!STREAMING_PAYLOADS.has(payloadHash)) return

    const declaredLength = ctx.headers['x-amz-decoded-content-length']
    const expectedLength = declaredLength === undefined ? null : Number.parseInt(declaredLength, 10)
    if (declaredLength !== undefined && !Number.isInteger(expectedLength)) {
      throw new S3Error('InvalidArgument', 'Invalid x-amz-decoded-content-length')
    }

    const decoder = new ChunkedDecoder({
      signed: payloadHash === STREAMING_SIGNED || payloadHash === STREAMING_SIGNED_TRAILER,
      seedSignature: ctx.auth.seedSignature,
      signingKey: ctx.auth.signingKey,
      scope: ctx.auth.scope,
      amzDate: ctx.auth.amzDate,
      expectedLength,
    })

    ctx.trailers = decoder.trailers
    ctx.bodyStreams = [ctx.req, decoder]
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, host, () => {
        this.http.removeListener('error', reject)
        resolve(this.address())
      })
    })
  }

  address() {
    const address = this.http.address()
    if (!address) return null
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    return { ...address, endpoint: `http://${host}:${address.port}` }
  }

  async close() {
    await new Promise((resolve) => this.http.close(resolve))
    this.store.close()
  }
}
