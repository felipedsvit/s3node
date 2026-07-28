import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  childText,
  childrenNamed,
  document,
  errorDocument,
  escapeAttribute,
  escapeXml,
  parseXml,
  text,
} from '../dist/src/xml.js'

describe('serialisation', () => {
  it('escapes only &, < and > in element text, as S3 does', () => {
    assert.equal(escapeXml(`<a&b>"'`), `&lt;a&amp;b&gt;"'`)
  })

  it('escapes quotes as well inside attribute values', () => {
    assert.equal(escapeAttribute(`<a&b>"'`), '&lt;a&amp;b&gt;&quot;&apos;')
  })

  it('survives a round trip through the parser', () => {
    const key = `quote'and(paren)&<>"`
    assert.equal(childText(parseXml(`<Object>${text('Key', key)}</Object>`), 'Key'), key)
  })

  it('emits nothing for undefined values', () => {
    assert.equal(text('Key', undefined), '')
  })

  it('wraps a document in the S3 namespace', () => {
    assert.equal(
      document('ListBucketResult', '<Name>b</Name>'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name></ListBucketResult>',
    )
  })

  it('renders an error document with the code clients dispatch on', () => {
    const xml = errorDocument({ code: 'NoSuchKey', message: 'missing', resource: '/b/k', requestId: 'R1' })
    assert.match(xml, /<Code>NoSuchKey<\/Code>/)
    assert.match(xml, /<RequestId>R1<\/RequestId>/)
  })
})

describe('parseXml', () => {
  it('parses a CompleteMultipartUpload body', () => {
    const root = parseXml(`
      <CompleteMultipartUpload>
        <Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag></Part>
        <Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag></Part>
      </CompleteMultipartUpload>`)
    assert.equal(root.name, 'CompleteMultipartUpload')
    const parts = childrenNamed(root, 'Part')
    assert.equal(parts.length, 2)
    assert.equal(childText(parts[0], 'PartNumber'), '1')
    assert.equal(childText(parts[1], 'ETag'), '"bbb"')
  })

  it('decodes the five predefined entities', () => {
    const root = parseXml('<Delete><Object><Key>a&amp;b&lt;c</Key></Object></Delete>')
    assert.equal(childText(childrenNamed(root, 'Object')[0], 'Key'), 'a&b<c')
  })

  it('handles self-closing elements and attributes', () => {
    const root = parseXml('<Delete><Quiet a="1"/></Delete>')
    assert.equal(childrenNamed(root, 'Quiet').length, 1)
  })

  it('skips the XML declaration and comments', () => {
    const root = parseXml('<?xml version="1.0"?><!-- hi --><Delete><!-- x --><Quiet>true</Quiet></Delete>')
    assert.equal(childText(root, 'Quiet'), 'true')
  })

  /* Security: these are the payload shapes that break naive XML parsers. */

  it('refuses a DOCTYPE, blocking XXE and billion-laughs', () => {
    const xxe = `<?xml version="1.0"?>
      <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <Delete><Object><Key>&xxe;</Key></Object></Delete>`
    assert.throws(() => parseXml(xxe), (err) => err.code === 'MalformedXML')
  })

  it('refuses entity declarations even without a DOCTYPE keyword', () => {
    assert.throws(() => parseXml('<!ENTITY a "b"><Delete/>'), (err) => err.code === 'MalformedXML')
  })

  it('refuses unknown entity references', () => {
    assert.throws(() => parseXml('<Delete><Key>&lol;</Key></Delete>'),
      (err) => err.code === 'MalformedXML')
  })

  it('refuses CDATA sections', () => {
    assert.throws(() => parseXml('<Delete><![CDATA[x]]></Delete>'), (err) => err.code === 'MalformedXML')
  })

  it('caps nesting depth', () => {
    const deep = '<a>'.repeat(64) + '</a>'.repeat(64)
    assert.throws(() => parseXml(deep, { maxDepth: 32 }), (err) => err.code === 'MalformedXML')
  })

  it('caps body size', () => {
    assert.throws(() => parseXml(`<a>${'x'.repeat(200)}</a>`, { maxSize: 100 }),
      (err) => err.code === 'MalformedXML')
  })

  it('rejects mismatched and unterminated tags', () => {
    assert.throws(() => parseXml('<a></b>'), (err) => err.code === 'MalformedXML')
    assert.throws(() => parseXml('<a>'), (err) => err.code === 'MalformedXML')
    assert.throws(() => parseXml(''), (err) => err.code === 'MalformedXML')
  })

  it('rejects trailing content after the root element', () => {
    assert.throws(() => parseXml('<a/><b/>'), (err) => err.code === 'MalformedXML')
  })
})
