import { timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { CredentialStore } from '../auth/credentials.js'
import { S3Error } from '../errors.js'
import type { ObjectStore } from '../storage/store.js'
import { CONSOLE_HTML } from './page.js'

/**
 * A minimal admin UI, served on its own port.
 *
 * It is a separate listener rather than a path on the S3 endpoint because every
 * path there is already a bucket name — mounting a console at `/console` would
 * make a bucket of that name unreachable.
 *
 * It talks to the ObjectStore in process, so nothing here signs or verifies
 * SigV4; the operator authenticates once with HTTP Basic using an s3node
 * credential pair. That is only appropriate because the console is off unless a
 * port is passed and binds loopback by default.
 */

export interface ConsoleOptions {
  store: ObjectStore
  credentials: CredentialStore
  region: string
  version: string
}

const MAX_LIST_KEYS = 1000

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="s3node console", charset="UTF-8"',
    'Content-Type': 'text/plain',
  })
  res.end('Authentication required\n')
}

/** Constant-time comparison that tolerates differing lengths. */
function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authenticate(req: IncomingMessage, credentials: CredentialStore): boolean {
  const header = String(req.headers.authorization ?? '')
  if (!header.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator === -1) return false

  const credential = credentials.get(decoded.slice(0, separator))
  if (!credential) return false
  return secretsMatch(credential.secretAccessKey, decoded.slice(separator + 1))
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length })
  res.end(body)
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name)
  if (!value) throw new S3Error('InvalidArgument', `Missing ${name}`)
  return value
}

export class ConsoleServer {
  readonly http: ReturnType<typeof createHttpServer>
  endpoint?: string

  constructor(private readonly options: ConsoleOptions) {
    this.http = createHttpServer((req, res) => {
      this.handle(req, res).catch((err: Error) => {
        if (res.headersSent) { res.destroy(); return }
        const status = err instanceof S3Error ? err.statusCode : 500
        res.writeHead(status, { 'Content-Type': 'text/plain' })
        res.end(`${err.message}\n`)
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authenticate(req, this.options.credentials)) {
      unauthorized(res)
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const params = url.searchParams
    const { store } = this.options

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const body = Buffer.from(CONSOLE_HTML, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        // The page is entirely self-contained; forbid anything external.
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/info' && req.method === 'GET') {
      sendJson(res, 200, this.summarise())
      return
    }

    if (url.pathname === '/api/buckets' && req.method === 'GET') {
      sendJson(res, 200, {
        buckets: store.listBuckets().map((bucket) => ({
          name: bucket.name,
          createdAt: bucket.createdAt.toISOString(),
        })),
      })
      return
    }

    if (url.pathname === '/api/bucket') {
      const name = required(params, 'name')
      if (req.method === 'POST') { store.createBucket(name); sendJson(res, 201, { name }); return }
      if (req.method === 'DELETE') { await store.deleteBucket(name); sendJson(res, 200, { name }); return }
    }

    if (url.pathname === '/api/objects' && req.method === 'GET') {
      const listing = store.listObjects(required(params, 'bucket'), {
        prefix: params.get('prefix') ?? '',
        maxKeys: MAX_LIST_KEYS,
      })
      sendJson(res, 200, {
        objects: listing.contents.map((record) => ({
          key: record.key.toString('utf8'),
          size: record.size,
          etag: record.etag,
          lastModified: record.lastModified.toISOString(),
        })),
        truncated: listing.truncated,
      })
      return
    }

    if (url.pathname === '/api/object') {
      const bucket = required(params, 'bucket')
      const key = required(params, 'key')

      if (req.method === 'GET') {
        const record = store.getObject(bucket, key)
        const encryptionKey = store.resolveEncryptionKey(record, null)
        res.writeHead(200, {
          'Content-Type': record.contentType ?? 'application/octet-stream',
          'Content-Length': record.size,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(key)}"`,
        })
        if (record.size === 0) { res.end(); return }
        await pipeline(store.createObjectStream(record, 0, record.size - 1, { encryptionKey }), res)
        return
      }

      if (req.method === 'PUT') {
        const result = await store.putObject({
          bucket, key, body: req,
          contentType: req.headers['content-type'] as string | undefined,
        })
        sendJson(res, 200, { key, etag: result.etag, size: result.size })
        return
      }

      if (req.method === 'DELETE') {
        await store.deleteObject(bucket, key)
        sendJson(res, 200, { key })
        return
      }
    }

    sendJson(res, 404, { error: 'Not found' })
  }

  private summarise(): { region: string; version: string; buckets: number; objects: number; bytes: number } {
    const buckets = this.options.store.listBuckets()
    let objects = 0
    let bytes = 0
    for (const bucket of buckets) {
      const listing = this.options.store.listObjects(bucket.name, { maxKeys: MAX_LIST_KEYS })
      objects += listing.contents.length
      for (const record of listing.contents) bytes += record.size
    }
    return { region: this.options.region, version: this.options.version, buckets: buckets.length, objects, bytes }
  }

  listen(port: number, host = '127.0.0.1'): Promise<string> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, host, () => {
        this.http.removeListener('error', reject)
        const address = this.http.address() as import('node:net').AddressInfo
        const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
        this.endpoint = `http://${displayHost}:${address.port}`
        resolve(this.endpoint)
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.http.close(() => resolve()))
  }
}
