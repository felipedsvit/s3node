import type { ServerResponse } from 'node:http'
import { isoDate, sendXml, type RequestContext } from '../http.js'
import { document, text } from '../xml.js'
import { ownerXml } from './shared.js'
import type { ObjectStore } from '../storage/store.js'

export function listBuckets(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const buckets = store.listBuckets()
    .map((bucket) => `<Bucket>${text('Name', bucket.name)}${text('CreationDate', isoDate(bucket.createdAt))}</Bucket>`)
    .join('')
  sendXml(ctx, res, 200, document('ListAllMyBucketsResult', `${ownerXml}<Buckets>${buckets}</Buckets>`))
}
