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
import { resolveRoute } from './router.js'
import { ObjectStore } from './storage/store.js'
import type { ObjectRecord } from './storage/metadata.js'

const DEFAULT_REGION = 'us-east-1'

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
  encryptionMasterKey?: string | Buffer | null
  lifecycleIntervalMs?: number
  logger?: { error: (entry: Record<string, unknown>) => void } | null
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
    })
    this.lifecycleTimer = null
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
      encryptionMasterKey: options.encryptionMasterKey ?? null,
    })
    return new S3NodeServer({
      store,
      credentials: options.credentials ?? [],
      region: options.region,
      virtualHostDomain: options.virtualHostDomain,
      logger: options.logger,
      lifecycleIntervalMs: options.lifecycleIntervalMs,
    })
  }

  runLifecycle(options?: { now?: number }): Promise<LifecycleSummary> {
    return runLifecycle(this.store, options)
  }

  async _handle(req: IncomingMessage, res: ServerResponse, expectContinue: boolean): Promise<void> {
    let ctx: RequestContext | null = null
    try {
      ctx = createContext(req, { virtualHostDomain: this.virtualHostDomain })

      if (req.method === 'OPTIONS') {
        this._handlePreflight(ctx, res)
        return
      }

      const route = resolveRoute(ctx)
      const selfAuthenticating = route.selfAuthenticating === true

      ctx.auth = selfAuthenticating
        ? { anonymous: false, deferred: true, payloadHash: null }
        : this._authenticate(ctx)

      if (!selfAuthenticating) this.authorize(ctx, route.action, route.resource as string)

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

  listen(port = 0, host = '127.0.0.1'): Promise<ReturnType<typeof this.address>> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, host, () => {
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
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
    await this.notifications.drain()
    this.store.close()
  }
}
