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
import {
  matchRule,
  parseRequestHeaders,
  preflightHeaders,
  responseHeaders as corsResponseHeaders,
} from './features/cors.js'
import { runLifecycle } from './features/lifecycle.js'
import { NotificationDispatcher } from './features/notifications.js'
import { evaluatePolicy, objectArn } from './features/policy.js'
import { createContext, sendEmpty, sendError } from './http.js'
import { resolveRoute } from './router.js'
import { ObjectStore } from './storage/store.js'

const DEFAULT_REGION = 'us-east-1'

export class S3NodeServer {
  constructor({
    store, credentials, region = DEFAULT_REGION, virtualHostDomain = null, logger = null,
    lifecycleIntervalMs = 0,
  }) {
    this.store = store
    this.credentials = credentials
    this.region = region
    this.virtualHostDomain = virtualHostDomain
    this.logger = logger
    this.notifications = new NotificationDispatcher(store, { region, logger })
    this.lifecycleTimer = null
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

    if (lifecycleIntervalMs > 0) {
      this.lifecycleTimer = setInterval(() => {
        this.runLifecycle().catch((err) =>
          this.logger?.error?.({ message: 'lifecycle sweep failed', error: err.message }))
      }, lifecycleIntervalMs)
      this.lifecycleTimer.unref?.()
    }
  }

  static async create({
    dataDir,
    credentials = [],
    region = DEFAULT_REGION,
    virtualHostDomain = null,
    minPartSize,
    encryptionMasterKey = null,
    lifecycleIntervalMs = 0,
    logger = null,
  } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required')
    const store = await ObjectStore.open({ dataDir, region, minPartSize, encryptionMasterKey })
    return new S3NodeServer({
      store,
      credentials: credentials instanceof CredentialStore ? credentials : new CredentialStore(credentials),
      region,
      virtualHostDomain,
      logger,
      lifecycleIntervalMs,
    })
  }

  /** Applies expiration rules once. Also exposed so callers can trigger it. */
  runLifecycle(options) {
    return runLifecycle(this.store, options)
  }

  /**
   * `Expect: 100-continue` is answered only after the request is both
   * authenticated and authorised, so a rejected client is turned away before it
   * uploads the body rather than after (docs/plan.md section 4.8).
   */
  async _handle(req, res, expectContinue) {
    let ctx = null
    try {
      ctx = createContext(req, { virtualHostDomain: this.virtualHostDomain })

      if (req.method === 'OPTIONS') {
        this._handlePreflight(ctx, res)
        return
      }

      const route = resolveRoute(ctx)
      // A browser form upload carries its credential and signature in the form
      // body, so it authenticates itself once the body has been parsed.
      const selfAuthenticating = route.handler.name === 'postObject'

      ctx.auth = selfAuthenticating
        ? { anonymous: false, deferred: true, payloadHash: null }
        : this._authenticate(ctx)

      if (!selfAuthenticating) this.authorize(ctx, route.action, route.resource)

      if (expectContinue) res.writeContinue()

      this._attachBody(ctx)
      this._applyCors(ctx, res)
      await route.handler(ctx, res, { store: this.store, server: this })
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

  _authenticate(ctx) {
    const signed = ctx.headers.authorization || ctx.query.get('X-Amz-Signature') !== undefined
    if (!signed) {
      // Anonymous is allowed to reach policy evaluation; the default there is
      // deny, so an unauthenticated request only proceeds if a bucket policy
      // explicitly permits it.
      return {
        anonymous: true,
        payloadHash: ctx.headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD',
      }
    }
    return {
      anonymous: false,
      ...verifyRequest(ctx, { lookupCredential: this.credentials.lookup, region: this.region }),
    }
  }

  _bucketConfig(bucket, name) {
    if (!bucket) return null
    try {
      return this.store.metadata.getConfig(bucket, name)
    } catch {
      return null
    }
  }

  _conditionContext(ctx) {
    const socket = ctx.req.socket
    return {
      principal: ctx.auth.anonymous ? '*' : `arn:aws:iam::s3node:user/${ctx.auth.accessKeyId}`,
      'aws:sourceip': socket?.remoteAddress ?? '',
      'aws:securetransport': String(Boolean(socket?.encrypted)),
      'aws:useragent': ctx.headers['user-agent'],
      'aws:referer': ctx.headers.referer,
      'aws:principaltype': ctx.auth.anonymous ? 'Anonymous' : 'User',
      's3:prefix': ctx.query.get('prefix'),
      's3:delimiter': ctx.query.get('delimiter'),
      's3:max-keys': ctx.query.get('max-keys'),
      's3:x-amz-acl': ctx.headers['x-amz-acl'],
      's3:x-amz-server-side-encryption': ctx.headers['x-amz-server-side-encryption'],
      's3:x-amz-content-sha256': ctx.headers['x-amz-content-sha256'],
    }
  }

  /**
   * Bucket policy evaluation. Explicit Deny always wins; when the policy is
   * silent the holder of a valid credential is allowed and anonymous is not.
   */
  authorize(ctx, action, resource, overrides = {}) {
    const policy = this._bucketConfig(ctx.bucket, 'policy')
    const context = { ...this._conditionContext(ctx), ...overrides }
    const decision = evaluatePolicy(policy, { action, resource, context })

    if (decision === 'Deny') throw new S3Error('AccessDenied')
    if (decision === 'Allow') return
    if (ctx.auth.anonymous) throw new S3Error('AccessDenied')
  }

  /** Used by the POST upload handler once the form has revealed its principal. */
  authorizePostUpload(ctx, key, accessKeyId) {
    const previous = ctx.auth
    ctx.auth = { anonymous: false, accessKeyId }
    try {
      this.authorize(ctx, 's3:PutObject', objectArn(ctx.bucket, key))
    } finally {
      ctx.auth = previous
    }
  }

  /* -------------------------------- CORS -------------------------------- */

  _handlePreflight(ctx, res) {
    const origin = ctx.headers.origin
    const method = ctx.headers['access-control-request-method']
    if (!origin || !method) {
      throw new S3Error('InvalidRequest', 'This is not a valid CORS preflight request')
    }
    const requestHeaders = parseRequestHeaders(ctx.headers['access-control-request-headers'])
    const rule = matchRule(this._bucketConfig(ctx.bucket, 'cors'), {
      origin, method: String(method).toUpperCase(), requestHeaders,
    })
    // Preflight is intentionally unauthenticated: browsers never attach
    // credentials to it.
    if (!rule) throw new S3Error('AccessForbidden')
    sendEmpty(ctx, res, 200, preflightHeaders(rule, origin, requestHeaders))
  }

  _applyCors(ctx, res) {
    const origin = ctx.headers.origin
    if (!origin || !ctx.bucket) return
    const rule = matchRule(this._bucketConfig(ctx.bucket, 'cors'), { origin, method: ctx.method })
    // Headers set here survive writeHead(): Node merges them, with writeHead's
    // own object taking precedence.
    for (const [name, value] of Object.entries(corsResponseHeaders(rule, origin))) {
      res.setHeader(name, value)
    }
  }

  /**
   * Wraps the request in the `aws-chunked` decoder when the payload is
   * streamed. Without this the framing bytes are written into the object and
   * every aws-cli upload is silently corrupted (docs/plan.md section 4.1).
   */
  _attachBody(ctx) {
    const payloadHash = ctx.auth.payloadHash
    if (!payloadHash || !STREAMING_PAYLOADS.has(payloadHash)) return

    const declaredLength = ctx.headers['x-amz-decoded-content-length']
    const expectedLength = declaredLength === undefined ? null : Number.parseInt(declaredLength, 10)
    if (declaredLength !== undefined && !Number.isInteger(expectedLength)) {
      throw new S3Error('InvalidArgument', 'Invalid x-amz-decoded-content-length')
    }

    const decoder = new ChunkedDecoder({
      signed: !ctx.auth.anonymous &&
        (payloadHash === STREAMING_SIGNED || payloadHash === STREAMING_SIGNED_TRAILER),
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
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer)
    await new Promise((resolve) => this.http.close(resolve))
    await this.notifications.drain()
    this.store.close()
  }
}
