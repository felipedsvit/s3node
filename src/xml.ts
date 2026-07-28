import { S3Error } from './errors.js'

export const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

export function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>]/g, (c) => ESCAPES[c]!)
}

export function escapeAttribute(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

export function el(name: string, children?: string | null, attrs?: Record<string, string | undefined | null>): string {
  const attr = attrs
    ? Object.entries(attrs)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`)
        .join('')
    : ''
  if (children === undefined || children === null || children === '') return `<${name}${attr}/>`
  return `<${name}${attr}>${children}</${name}>`
}

export function text(name: string, value: unknown): string {
  if (value === undefined || value === null) return ''
  return `<${name}>${escapeXml(value)}</${name}>`
}

export function document(rootName: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName} xmlns="${S3_XMLNS}">${body}</${rootName}>`
}

export function errorDocument({ code, message, resource, requestId, hostId }: {
  code: string
  message: string
  resource: string
  requestId: string
  hostId: string
}): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error>' +
    text('Code', code) +
    text('Message', message) +
    text('Resource', resource) +
    text('RequestId', requestId) +
    text('HostId', hostId) +
    '</Error>'
  )
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const NAME_RE = /[A-Za-z_:][A-Za-z0-9._:-]*/y

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new S3Error('MalformedXML', 'Invalid character reference')
      }
      return String.fromCodePoint(code)
    }
    const named = NAMED_ENTITIES[body]
    if (named === undefined) throw new S3Error('MalformedXML', `Unsupported entity &${body};`)
    return named
  })
}

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  text: string
  children: XmlNode[]
}

export function parseXml(input: string | Buffer, { maxSize = 1024 * 1024, maxDepth = 32, maxNodes = 100_000 } = {}): XmlNode {
  const src = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)
  if (src.length > maxSize) throw new S3Error('MalformedXML', 'XML body too large')
  if (/<!\s*(DOCTYPE|ENTITY|ATTLIST|ELEMENT|NOTATION)/i.test(src)) {
    throw new S3Error('MalformedXML', 'Document type declarations are not accepted')
  }
  if (src.includes('<![CDATA[')) throw new S3Error('MalformedXML', 'CDATA sections are not accepted')

  let pos = 0
  let nodes = 0

  const fail = (msg: string): never => { throw new S3Error('MalformedXML', msg) }

  const skipTrivia = (): void => {
    for (;;) {
      while (pos < src.length) {
        const c = src.charCodeAt(pos)
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break
        pos++
      }
      if (src.startsWith('<?', pos)) {
        const end = src.indexOf('?>', pos)
        if (end === -1) fail('Unterminated processing instruction')
        pos = end + 2
        continue
      }
      if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos)
        if (end === -1) fail('Unterminated comment')
        pos = end + 3
        continue
      }
      return
    }
  }

  const readName = (): string => {
    NAME_RE.lastIndex = pos
    const m = NAME_RE.exec(src)
    if (!m) fail('Expected element name')
    pos = NAME_RE.lastIndex
    return m![0]
  }

  const readAttributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {}
    for (;;) {
      while (pos < src.length) {
        const c = src.charCodeAt(pos)
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break
        pos++
      }
      if (src[pos] === '>' || src.startsWith('/>', pos)) return attrs
      const name = readName()
      while (pos < src.length) {
        const c = src.charCodeAt(pos)
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break
        pos++
      }
      if (src[pos] !== '=') fail('Expected "=" in attribute')
      pos++
      while (pos < src.length) {
        const c = src.charCodeAt(pos)
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break
        pos++
      }
      const quote = src[pos]!
      if (quote !== '"' && quote !== "'") fail('Unquoted attribute value')
      const end = src.indexOf(quote, pos + 1)
      if (end === -1) fail('Unterminated attribute value')
      attrs[name] = decodeEntities(src.slice(pos + 1, end))
      pos = end + 1
    }
  }

  const parseElement = (depth: number): XmlNode => {
    if (depth > maxDepth) fail('XML nesting too deep')
    if (++nodes > maxNodes) fail('XML has too many nodes')
    if (src[pos] !== '<') fail('Expected "<"')
    pos++
    const name = readName()
    const attrs = readAttributes()
    if (src.startsWith('/>', pos)) {
      pos += 2
      return { name, attrs, text: '', children: [] }
    }
    if (src[pos] !== '>') fail('Malformed start tag')
    pos++

    const children: XmlNode[] = []
    let textParts = ''
    for (;;) {
      if (pos >= src.length) fail('Unexpected end of document')
      if (src.startsWith('</', pos)) {
        pos += 2
        const closing = readName()
        if (closing !== name) fail(`Mismatched closing tag </${closing}>`)
        while (pos < src.length && /\s/.test(src[pos]!)) pos++
        if (src[pos] !== '>') fail('Malformed end tag')
        pos++
        return { name, attrs, text: decodeEntities(textParts).trim(), children }
      }
      if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos)
        if (end === -1) fail('Unterminated comment')
        pos = end + 3
        continue
      }
      if (src[pos] === '<') {
        children.push(parseElement(depth + 1))
        continue
      }
      const next = src.indexOf('<', pos)
      if (next === -1) fail('Unexpected end of document')
      textParts += src.slice(pos, next)
      pos = next
    }
  }

  skipTrivia()
  if (pos >= src.length) fail('Empty XML document')
  const root = parseElement(0)
  skipTrivia()
  if (pos !== src.length) fail('Trailing content after root element')
  return root
}

export function childrenNamed(node: XmlNode | undefined | null, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : []
}

export function childNamed(node: XmlNode | undefined | null, name: string): XmlNode | undefined {
  return node ? node.children.find((c) => c.name === name) : undefined
}

export function childText(node: XmlNode | undefined | null, name: string): string | undefined {
  return childNamed(node, name)?.text
}
