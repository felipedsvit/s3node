import { createServer as createHttpServer } from 'node:http'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { ChunkedDecoder } from './auth/chunked.js'
import { CredentialStore } from './auth/credentials.js'
import type { Credential } from './auth/credentials.js'
import {
  STREAMING_PAYLOADS,
  STREAMING_SIGNED,
  STREAMING_SIGNED_TRAILER,
  verifyRequest,
} from './auth/sigv4.js'
import type { VerifyResult } from './auth/sigv4.js'
import { S3Error } from './errors.js'
import {
  matchRule,
  parseRequestHeaders,
  preflightHeaders,
  responseHeaders as corsResponseHeaders,
} from './features/cors.js'
import type { CorsConfig } from './features/cors.js'
import { runLifecycle } from './features/lifecycle.js'
import type { LifecycleSummary } from './features/lifecycle.js'
import { NotificationDispatcher } from './features/notifications.js'
import { evaluatePolicy, objectArn } from './features/policy.js'
import type { PolicyDocument } from './features/policy.js'
import { createContext, sendEmpty, sendError } from './http.js'
import type { RequestContext } from './http.js'
import { MetricsRegistry } from './metrics.js'
import { resolveRoute } from './router.js'
import { ObjectStore } from './storage/store.js'
import type { ObjectRecord } from './storage/metadata.js'
import { RateLimiter } from './util/rateLimiter.js'

const DEFAULT_REGION = 'us-east-1'

/** Node grew SO_REUSEPORT support for listeners in 22.12. */
export function supportsReusePort(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major! > 22 || (major === 22 && minor! >= 12)
}

interface ServerEvent {
  bucket: string
  eventName: string
  key: string
  size?: number
  etag?: string
  versionId?: string
}

export interface ServerOptions {
  store: ObjectStore
  credentials: CredentialStore | Credential[]
  region?: string
  virtualHostDomain?: string | null
  logger?: { error: (entry: Record<string, unknown>) => void } | null
  lifecycleIntervalMs?: number
  /** How often the notification worker sweeps the queue for due deliveries. 0 disables the background worker. */
  notificationIntervalMs?: number
  /** Sustained requests/sec allowed per caller (access key, or source IP when anonymous). Unset disables rate limiting. */
  rateLimitPerSecond?: number
  /** Burst capacity for the rate limiter; defaults to `rateLimitPerSecond` when that option is set. */
  rateLimitBurst?: number
}

export interface CreateOptions {
  dataDir: string
  credentials?: Credential[]
  region?: string
  virtualHostDomain?: string | null
  port?: number
  host?: string
  minPartSize?: number
  maxObjectSize?: number
  maxConcurrentUploads?: number
  maxConcurrentWrites?: number
  encryptionMasterKey?: string | Buffer | null
  lifecycleIntervalMs?: number
  notificationIntervalMs?: number
  logger?: { error: (entry: Record<string, unknown>) => void } | null
  rateLimitPerSecond?: number
  rateLimitBurst?: number
}

export class S3NodeServer {
  store: ObjectStore
  credentials: CredentialStore
  region: string
  virtualHostDomain: string | null
  logger: { error: (entry: Record<string, unknown>) => void } | null
  notifications: NotificationDispatcher
  lifecycleTimer: ReturnType<typeof setInterval> | null
  http: ReturnType<typeof createHttpServer>
  metrics: MetricsRegistry
  rateLimiter: RateLimiter | null
  endpoint?: string

  constructor(options: ServerOptions) {
    this.store = options.store
    this.credentials = options.credentials instanceof CredentialStore ? options.credentials : new CredentialStore(options.credentials as Credential[])
    this.region = options.region ?? DEFAULT_REGION
    this.virtualHostDomain = options.virtualHostDomain ?? null
    this.logger = options.logger ?? null
    this.notifications = new NotificationDispatcher(this.store, {
      region: this.region,
      logger: this.logger ?? undefined,
      intervalMs: options.notificationIntervalMs,
    })
    this.lifecycleTimer = null
    this.metrics = new MetricsRegistry()
    this.rateLimiter = options.rateLimitPerSecond
      ? new RateLimiter(options.rateLimitBurst ?? options.rateLimitPerSecond, options.rateLimitPerSecond)
      : null
    this.http = createHttpServer()

    this.http.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers.expect) return
      this._handle(req, res, false)
    })
    this.http.on('checkContinue', (req: IncomingMessage, res: ServerResponse) => {
      this._handle(req, res, true)
    })
    this.http.on('clientError', (_err: Error, socket: import('node:net').Socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })

    if (options.lifecycleIntervalMs && options.lifecycleIntervalMs > 0) {
      this.lifecycleTimer = setInterval(() => {
        this.runLifecycle().catch((err: Error) =>
          this.logger?.error?.({ message: 'lifecycle sweep failed', error: err.message }))
      }, options.lifecycleIntervalMs)
      this.lifecycleTimer.unref?.()
    }
  }

  static async create(options: CreateOptions): Promise<S3NodeServer> {
    if (!options.dataDir) throw new TypeError('dataDir is required')
    const store = await ObjectStore.open({
      dataDir: options.dataDir,
      region: options.region,
      minPartSize: options.minPartSize,
      maxObjectSize: options.maxObjectSize,
      maxConcurrentUploads: options.maxConcurrentUploads,
      maxConcurrentWrites: options.maxConcurrentWrites,
      encryptionMasterKey: options.encryptionMasterKey ?? null,
    })
    return new S3NodeServer({
      store,
      credentials: options.credentials ?? [],
      region: options.region,
      virtualHostDomain: options.virtualHostDomain,
      logger: options.logger,
      lifecycleIntervalMs: options.lifecycleIntervalMs,
      notificationIntervalMs: options.notificationIntervalMs,
      rateLimitPerSecond: options.rateLimitPerSecond,
      rateLimitBurst: options.rateLimitBurst,
    })
  }

  runLifecycle(options?: { now?: number }): Promise<LifecycleSummary> {
    return runLifecycle(this.store, options)
  }

  async _handle(req: IncomingMessage, res: ServerResponse, expectContinue: boolean): Promise<void> {
    const start = process.hrtime.bigint()
    let ctx: RequestContext | null = null
    let action = req.method ?? 'unknown'
    try {
      ctx = createContext(req, { virtualHostDomain: this.virtualHostDomain })

      if (req.method === 'OPTIONS') {
        this._handlePreflight(ctx, res)
        return
      }

      const route = resolveRoute(ctx)
      action = route.action
      const selfAuthenticating = route.selfAuthenticating === true

      ctx.auth = selfAuthenticating
        ? { anonymous: false, deferred: true, payloadHash: null }
        : this._authenticate(ctx)

      if (this.rateLimiter && !this.rateLimiter.allow(this._rateLimitKey(ctx))) {
        throw new S3Error('SlowDown', 'Request rate limit exceeded')
      }

      if (!selfAuthenticating) this.authorize(ctx, route.action, route.resource as string)

      if (expectContinue) res.writeContinue()

      this._attachBody(ctx)
      this._applyCors(ctx, res)
      await route.handler(ctx, res, { store: this.store, server: this })
      this._recordMetrics(action, req, res, start)
    } catch (err) {
      const rendered = sendError(ctx, res, err)
      this.metrics.httpErrorsTotal.inc({ code: rendered.code })
      this._recordMetrics(action, req, res, start)
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
   * Byte counts come from Content-Length headers rather than instrumenting
   * the stream: most handlers already declare one (fixed bodies, or known
   * object size for streamed GETs), and that avoids wrapping every
   * `res.write`/`res.end` call just to keep a running total.
   */
  _recordMetrics(action: string, req: IncomingMessage, res: ServerResponse, start: bigint): void {
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9
    const status = String(res.statusCode)
    this.metrics.httpRequestsTotal.inc({ action, method: req.method ?? 'unknown', status })
    this.metrics.httpRequestDurationSeconds.observe({ action }, elapsedSeconds)
    const bytesIn = Number(req.headers['content-length'] ?? 0)
    if (bytesIn > 0) this.metrics.bytesInTotal.inc({}, bytesIn)
    const bytesOut = Number(res.getHeader('content-length') ?? 0)
    if (bytesOut > 0) this.metrics.bytesOutTotal.inc({}, bytesOut)
  }

  /** Rate-limits by access key when signed, falling back to source IP for anonymous requests. */
  _rateLimitKey(ctx: RequestContext): string {
    if (!ctx.auth?.anonymous && (ctx.auth as Record<string, string>)?.accessKeyId) {
      return `key:${(ctx.auth as Record<string, string>).accessKeyId}`
    }
    return `ip:${(ctx.req.socket as import('node:net').Socket)?.remoteAddress ?? 'unknown'}`
  }

  _authenticate(ctx: RequestContext): Record<string, unknown> {
    const signed = ctx.headers.authorization || ctx.query.get('X-Amz-Signature') !== undefined
    if (!signed) {
      return {
        anonymous: true,
        payloadHash: ctx.headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD',
      }
    }
    return {
      anonymous: false,
      ...verifyRequest(ctx, { lookupCredential: (id: string) => this.credentials.lookup(id), region: this.region }),
    }
  }

  /** Reads a bucket config document, treating any lookup failure as "absent". */
  _bucketConfig<T>(bucket: string, name: string): T | null {
    if (!bucket) return null
    try {
      return this.store.metadata.getConfig<T>(bucket, name)
    } catch {
      return null
    }
  }

  _conditionContext(ctx: RequestContext): Record<string, string | undefined | null> {
    const socket = ctx.req.socket
    // Only queried for bucket-scoped requests (ListBuckets etc. has no ctx.bucket), so
    // policies that never reference these keys don't pay for an extra aggregate query.
    const usage = ctx.bucket ? this.store.metadata.bucketUsage(ctx.bucket) : null
    return {
      principal: ctx.auth?.anonymous ? '*' : `arn:aws:iam::s3node:user/${(ctx.auth as Record<string, string>).accessKeyId}`,
      'aws:sourceip': (socket as import('node:net').Socket)?.remoteAddress ?? '',
      'aws:securetransport': String(Boolean((socket as import('node:net').Socket & { encrypted?: boolean })?.encrypted)),
      'aws:useragent': ctx.headers['user-agent'] as string | undefined,
      'aws:referer': ctx.headers.referer as string | undefined,
      'aws:principaltype': ctx.auth?.anonymous ? 'Anonymous' : 'User',
      's3:prefix': ctx.query.get('prefix'),
      's3:delimiter': ctx.query.get('delimiter'),
      's3:max-keys': ctx.query.get('max-keys'),
      's3:x-amz-acl': ctx.headers['x-amz-acl'] as string | undefined,
      's3:x-amz-server-side-encryption': ctx.headers['x-amz-server-side-encryption'] as string | undefined,
      's3:x-amz-content-sha256': ctx.headers['x-amz-content-sha256'] as string | undefined,
      's3:bucket-size': usage ? String(usage.bytes) : undefined,
      's3:bucket-object-count': usage ? String(usage.objects) : undefined,
    }
  }

  authorize(ctx: RequestContext, action: string, resource: string, overrides: Record<string, string | undefined | null> = {}): void {
    const policy = this._bucketConfig<PolicyDocument>(ctx.bucket, 'policy')
    const context = { ...this._conditionContext(ctx), ...overrides }
    const decision = evaluatePolicy(policy, { action, resource, context })

    if (decision === 'Deny') throw new S3Error('AccessDenied')
    if (decision === 'Allow') return
    if (ctx.auth?.anonymous) throw new S3Error('AccessDenied')
  }

  authorizePostUpload(ctx: RequestContext, key: string, accessKeyId: string): void {
    const previous = ctx.auth
    ctx.auth = { anonymous: false, accessKeyId }
    try {
      this.authorize(ctx, 's3:PutObject', objectArn(ctx.bucket, key))
    } finally {
      ctx.auth = previous
    }
  }

  _handlePreflight(ctx: RequestContext, res: ServerResponse): void {
    const origin = ctx.headers.origin as string | undefined
    const method = ctx.headers['access-control-request-method'] as string | undefined
    if (!origin || !method) {
      throw new S3Error('InvalidRequest', 'This is not a valid CORS preflight request')
    }
    const requestHeaders = parseRequestHeaders(ctx.headers['access-control-request-headers'] as string | undefined)
    const rule = matchRule(this._bucketConfig<CorsConfig>(ctx.bucket, 'cors'), {
      origin, method: String(method).toUpperCase(), requestHeaders,
    })
    if (!rule) throw new S3Error('AccessForbidden')
    sendEmpty(ctx, res, 200, preflightHeaders(rule, origin, requestHeaders))
  }

  _applyCors(ctx: RequestContext, res: ServerResponse): void {
    const origin = ctx.headers.origin as string | undefined
    if (!origin || !ctx.bucket) return
    const rule = matchRule(this._bucketConfig<CorsConfig>(ctx.bucket, 'cors'), { origin, method: ctx.method ?? '' })
    for (const [name, value] of Object.entries(corsResponseHeaders(rule, origin))) {
      res.setHeader(name, value)
    }
  }

  _attachBody(ctx: RequestContext): void {
    const payloadHash = (ctx.auth as Record<string, string>)?.payloadHash
    if (!payloadHash || !STREAMING_PAYLOADS.has(payloadHash)) return

    const declaredLength = ctx.headers['x-amz-decoded-content-length'] as string | undefined
    const expectedLength = declaredLength === undefined ? null : Number.parseInt(declaredLength, 10)
    if (declaredLength !== undefined && !Number.isInteger(expectedLength)) {
      throw new S3Error('InvalidArgument', 'Invalid x-amz-decoded-content-length')
    }

    const auth = ctx.auth as Record<string, unknown>
    const decoder = new ChunkedDecoder({
      signed: !ctx.auth?.anonymous &&
        (payloadHash === STREAMING_SIGNED || payloadHash === STREAMING_SIGNED_TRAILER),
      seedSignature: auth.seedSignature as string | null,
      signingKey: auth.signingKey as Buffer | null,
      scope: auth.scope as string | null,
      amzDate: auth.amzDate as string | null,
      expectedLength,
    })

    ctx.trailers = decoder.trailers
    ctx.bodyStreams = [ctx.req, decoder]
  }

  /**
   * `reusePort` lets several processes bind the same port and have the kernel
   * spread connections between them, which is how cluster mode scales without a
   * primary relaying every socket. It needs Node >= 22.12; callers that ask for
   * it on an older runtime get a clear error rather than a silent single-worker
   * fallback.
   */
  listen(port = 0, host = '127.0.0.1', { reusePort = false } = {}): Promise<ReturnType<typeof this.address>> {
    if (reusePort && !supportsReusePort()) {
      throw new Error('reusePort requires Node.js 22.12 or newer')
    }
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen({ port, host, ...(reusePort ? { reusePort: true } : {}) }, () => {
        this.http.removeListener('error', reject)
        resolve(this.address())
      })
    })
  }

  address(): { address: string; family: string; port: number; endpoint: string } | null {
    const address = this.http.address()
    if (!address) return null
    const addr = address as import('node:net').AddressInfo
    const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
    return { ...addr, endpoint: `http://${host}:${addr.port}` }
  }

  async close(): Promise<void> {
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer)
    this.notifications.close()
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
    await this.notifications.drain()
    this.store.close()
  }
}
