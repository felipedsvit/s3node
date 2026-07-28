/**
 * A multipart object is stored as one blob per part. Reading a byte range out
 * of it means walking the parts in order, skipping those that fall outside the
 * range and clipping the ones that straddle its edges.
 *
 * Both the plaintext reader (BlobStore.createRangeStream) and the encrypted
 * reader (ObjectService.createObjectStream) need exactly this walk, so it lives
 * here rather than being copied into each.
 */

export interface BlobPart {
  partNumber: number
  size: number
  etag: string
  blobId: string
}

/** One part's contribution to a range: which blob, and which bytes of it. */
export interface PartSlice {
  blobId: string
  partNumber: number
  /** Offset of the first wanted byte, relative to the start of the part. */
  from: number
  /** Offset of the last wanted byte, relative to the start of the part. */
  to: number
}

/**
 * Yields the slice of each part overlapping the absolute range [start, end].
 * Parts are assumed to be in ascending part-number order and contiguous.
 */
export function* sliceParts(parts: BlobPart[], start: number, end: number): Generator<PartSlice> {
  let offset = 0
  for (const part of parts) {
    const partStart = offset
    const partEnd = offset + part.size - 1
    offset += part.size
    if (partEnd < start) continue
    if (partStart > end) break
    const from = Math.max(start - partStart, 0)
    const to = Math.min(end - partStart, part.size - 1)
    if (to < from) continue
    yield { blobId: part.blobId, partNumber: part.partNumber, from, to }
  }
}
