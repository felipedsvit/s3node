import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { S3Error } from '../errors.js'

const MAX_HEADER_BYTES = 8192
const DEFAULT_MAX_FIELD_BYTES = 64 * 1024
const DEFAULT_MAX_FIELDS = 100

export function parseBoundary(contentType) {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''))
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary) throw new S3Error('MalformedPOSTRequest', 'The Content-Type is missing a boundary')
  return boundary
}

/** Pull-based buffer over an async iterable of Buffers. */
class Scanner {
  constructor(iterator) {
    this.iterator = iterator
    this.buffer = Buffer.alloc(0)
    this.exhausted = false
  }

  async fill() {
    if (this.exhausted) return false
    const { value, done } = await this.iterator.next()
    if (done) {
      this.exhausted = true
      return false
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value
    return true
  }

  async readUntil(pattern, maxBytes) {
    for (;;) {
      const index = this.buffer.indexOf(pattern)
      if (index !== -1) {
        const chunk = this.buffer.subarray(0, index)
        this.buffer = this.buffer.subarray(index + pattern.length)
        return chunk
      }
      if (this.buffer.length > maxBytes) {
        throw new S3Error('MalformedPOSTRequest', 'A form part exceeded the maximum accepted size')
      }
      if (!(await this.fill())) return null
    }
  }

  async ensure(count) {
    while (this.buffer.length < count) {
      if (!(await this.fill())) return false
    }
    return true
  }
}

function parsePartHeaders(raw) {
  const headers = {}
  for (const line of raw.toString('latin1').split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  const disposition = headers['content-disposition'] ?? ''
  const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
  const filenameMatch = /;\s*filename="([^"]*)"/i.exec(disposition)
  return {
    name,
    filename: filenameMatch?.[1],
    hasFilename: filenameMatch !== null,
    contentType: headers['content-type'],
  }
}

async function pumpFile(scanner, delimiter, out) {
  const retain = delimiter.length - 1
  for (;;) {
    const index = scanner.buffer.indexOf(delimiter)
    if (index !== -1) {
      const tail = scanner.buffer.subarray(0, index)
      scanner.buffer = scanner.buffer.subarray(index + delimiter.length)
      if (tail.length && !out.write(tail)) await once(out, 'drain')
      out.end()
      return
    }
    // Hold back enough bytes that a delimiter split across chunks is still found.
    if (scanner.buffer.length > retain) {
      const emit = scanner.buffer.subarray(0, scanner.buffer.length - retain)
      scanner.buffer = scanner.buffer.subarray(scanner.buffer.length - retain)
      if (!out.write(emit)) await once(out, 'drain')
    }
    if (!(await scanner.fill())) {
      out.destroy(new S3Error('MalformedPOSTRequest', 'The form data ended before the final boundary'))
      return
    }
  }
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve)
    emitter.once('error', reject)
  })
}

function sourceIterator(sources) {
  if (sources.length === 1) return sources[0][Symbol.asyncIterator]()
  const merged = new PassThrough()
  pipeline(...sources, merged).catch((err) => merged.destroy(err))
  return merged[Symbol.asyncIterator]()
}

/**
 * Streaming multipart/form-data reader for browser POST uploads.
 *
 * Resolves as soon as the file part is reached, so the (possibly very large)
 * file body is never buffered: it is handed back as a stream that keeps being
 * fed while the caller writes it to storage. S3 requires the file field to come
 * last, which is what makes this possible.
 */
export async function parseFormData(sources, {
  boundary,
  maxFieldBytes = DEFAULT_MAX_FIELD_BYTES,
  maxFields = DEFAULT_MAX_FIELDS,
} = {}) {
  const scanner = new Scanner(sourceIterator(Array.isArray(sources) ? sources : [sources]))
  const dashBoundary = Buffer.from(`--${boundary}`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const fields = new Map()

  // Skip the preamble up to the first boundary.
  if ((await scanner.readUntil(dashBoundary, maxFieldBytes)) === null) {
    throw new S3Error('MalformedPOSTRequest', 'No form boundary was found')
  }

  for (;;) {
    if (!(await scanner.ensure(2))) {
      throw new S3Error('MalformedPOSTRequest', 'Truncated form data')
    }
    if (scanner.buffer[0] === 0x2d && scanner.buffer[1] === 0x2d) {
      return { fields, file: null } // closing "--"
    }
    scanner.buffer = scanner.buffer.subarray(2) // the CRLF after the boundary

    const rawHeaders = await scanner.readUntil(Buffer.from('\r\n\r\n'), MAX_HEADER_BYTES)
    if (rawHeaders === null) throw new S3Error('MalformedPOSTRequest', 'Truncated form part headers')
    const part = parsePartHeaders(rawHeaders)
    if (!part.name) throw new S3Error('MalformedPOSTRequest', 'A form part is missing its name')

    if (part.hasFilename || part.name.toLowerCase() === 'file') {
      const stream = new PassThrough()
      // Deliberately not awaited: the caller consumes the stream while this
      // keeps feeding it.
      pumpFile(scanner, delimiter, stream).catch((err) => stream.destroy(err))
      return {
        fields,
        file: { name: part.name, filename: part.filename ?? '', contentType: part.contentType, stream },
      }
    }

    const value = await scanner.readUntil(delimiter, maxFieldBytes)
    if (value === null) throw new S3Error('MalformedPOSTRequest', 'Truncated form field')
    if (fields.size >= maxFields) {
      throw new S3Error('MalformedPOSTRequest', `A form may carry at most ${maxFields} fields`)
    }
    fields.set(part.name.toLowerCase(), value.toString('utf8'))
  }
}
