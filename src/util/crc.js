/**
 * Table-driven CRC32 (IEEE, as used by x-amz-checksum-crc32) and CRC32C
 * (Castagnoli, x-amz-checksum-crc32c). Kept in-tree so the package has zero
 * runtime dependencies — see docs/plan.md section 8.
 */

function buildTable(poly) {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? poly ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
}

const CRC32_TABLE = buildTable(0xedb88320)
const CRC32C_TABLE = buildTable(0x82f63b78)

class Crc {
  constructor(table) {
    this.table = table
    this.state = 0xffffffff
  }

  update(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const table = this.table
    let c = this.state
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    this.state = c >>> 0
    return this
  }

  value() {
    return (this.state ^ 0xffffffff) >>> 0
  }

  digest(encoding) {
    const out = Buffer.allocUnsafe(4)
    out.writeUInt32BE(this.value(), 0)
    if (encoding === 'hex') return out.toString('hex')
    if (encoding === 'base64') return out.toString('base64')
    return out
  }
}

export class Crc32 extends Crc {
  constructor() { super(CRC32_TABLE) }
}

export class Crc32c extends Crc {
  constructor() { super(CRC32C_TABLE) }
}
