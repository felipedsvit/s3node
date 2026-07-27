import { S3Error } from './errors.js'

export const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/**
 * Element text needs only &, < and > escaped. S3 leaves quotes and apostrophes
 * literal in element content, and matching that keeps keys byte-identical to
 * what clients sent.
 */
export function escapeXml(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>]/g, (c) => ESCAPES[c])
}

/** Attribute values additionally need quotes escaped. */
export function escapeAttribute(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/** Build an element. `children` may be a string (text) or pre-rendered markup. */
export function el(name, children, attrs) {
  const attr = attrs
    ? Object.entries(attrs)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`)
        .join('')
    : ''
  if (children === undefined || children === null || children === '') return `<${name}${attr}/>`
  return `<${name}${attr}>${children}</${name}>`
}

export function text(name, value) {
  if (value === undefined || value === null) return ''
  return `<${name}>${escapeXml(value)}</${name}>`
}

export function document(rootName, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName} xmlns="${S3_XMLNS}">${body}</${rootName}>`
}

export function errorDocument({ code, message, resource, requestId, hostId }) {
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

/* ------------------------------------------------------------------ *
 * Parsing
 *
 * Deliberately minimal: no DTD, no entity declarations, no CDATA, no
 * external references. That makes XXE and billion-laughs impossible by
 * construction rather than by configuration (docs/plan.md section 7).
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const NAME_RE = /[A-Za-z_:][A-Za-z0-9._:-]*/y

function decodeEntities(raw) {
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

export function parseXml(input, { maxSize = 1024 * 1024, maxDepth = 32, maxNodes = 100_000 } = {}) {
  const src = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)
  if (src.length > maxSize) throw new S3Error('MalformedXML', 'XML body too large')
  if (/<!\s*(DOCTYPE|ENTITY|ATTLIST|ELEMENT|NOTATION)/i.test(src)) {
    throw new S3Error('MalformedXML', 'Document type declarations are not accepted')
  }
  if (src.includes('<![CDATA[')) throw new S3Error('MalformedXML', 'CDATA sections are not accepted')

  let pos = 0
  let nodes = 0

  const fail = (msg) => { throw new S3Error('MalformedXML', msg) }

  const skipTrivia = () => {
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++
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

  const readName = () => {
    NAME_RE.lastIndex = pos
    const m = NAME_RE.exec(src)
    if (!m) fail('Expected element name')
    pos = NAME_RE.lastIndex
    return m[0]
  }

  const readAttributes = () => {
    const attrs = {}
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++
      if (src[pos] === '>' || src.startsWith('/>', pos)) return attrs
      const name = readName()
      while (pos < src.length && /\s/.test(src[pos])) pos++
      if (src[pos] !== '=') fail('Expected "=" in attribute')
      pos++
      while (pos < src.length && /\s/.test(src[pos])) pos++
      const quote = src[pos]
      if (quote !== '"' && quote !== "'") fail('Unquoted attribute value')
      const end = src.indexOf(quote, pos + 1)
      if (end === -1) fail('Unterminated attribute value')
      attrs[name] = decodeEntities(src.slice(pos + 1, end))
      pos = end + 1
    }
  }

  const parseElement = (depth) => {
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

    const children = []
    let textParts = ''
    for (;;) {
      if (pos >= src.length) fail('Unexpected end of document')
      if (src.startsWith('</', pos)) {
        pos += 2
        const closing = readName()
        if (closing !== name) fail(`Mismatched closing tag </${closing}>`)
        while (pos < src.length && /\s/.test(src[pos])) pos++
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

export function childrenNamed(node, name) {
  return node ? node.children.filter((c) => c.name === name) : []
}

export function childNamed(node, name) {
  return node ? node.children.find((c) => c.name === name) : undefined
}

export function childText(node, name) {
  return childNamed(node, name)?.text
}
