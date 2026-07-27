/**
 * Byte-order key helpers. S3 orders keys by their UTF-8 bytes; JavaScript
 * string comparison orders by UTF-16 code units and diverges on surrogate
 * pairs, so every ordering decision goes through Buffers (docs/plan.md 4.4).
 */

export function toKeyBuffer(key) {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
}

export function compareKeys(a, b) {
  return Buffer.compare(toKeyBuffer(a), toKeyBuffer(b))
}

/**
 * Smallest buffer strictly greater than every key beginning with `prefix`.
 * Returns null when no such bound exists (empty prefix, or all-0xFF prefix),
 * meaning the scan is unbounded above.
 */
export function prefixUpperBound(prefix) {
  const buf = toKeyBuffer(prefix)
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] < 0xff) {
      const bound = Buffer.from(buf.subarray(0, i + 1))
      bound[i] += 1
      return bound
    }
  }
  return null
}

/** Smallest buffer strictly greater than `key`. */
export function keySuccessor(key) {
  return Buffer.concat([toKeyBuffer(key), Buffer.from([0x00])])
}
