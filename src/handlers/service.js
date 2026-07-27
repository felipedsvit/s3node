import { isoDate, sendXml } from '../http.js'
import { document, text } from '../xml.js'
import { ownerXml } from './shared.js'

export function listBuckets(ctx, res, { store }) {
  const buckets = store.listBuckets()
    .map((bucket) => `<Bucket>${text('Name', bucket.name)}${text('CreationDate', isoDate(bucket.createdAt))}</Bucket>`)
    .join('')
  sendXml(ctx, res, 200, document('ListAllMyBucketsResult', `${ownerXml}<Buckets>${buckets}</Buckets>`))
}
