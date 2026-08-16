#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import { runLifecycle } from '../dist/src/features/lifecycle.js'
import { GarbageCollector } from '../dist/src/storage/gc.js'
import { ObjectStore } from '../dist/src/storage/store.js'

const { values } = parseArgs({
  options: {
    'duration-seconds': { type: 'string', default: '3600' },
    concurrency: { type: 'string', default: '4' },
    'data-dir': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
})

const durationSeconds = Number(values['duration-seconds'])
const concurrency = Number(values.concurrency)
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new TypeError('--duration-seconds must be > 0')
if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('--concurrency must be a positive integer')

const temporary = !values['data-dir']
const dataDir = values['data-dir']
  ? resolve(values['data-dir'])
  : await mkdtemp(join(tmpdir(), 's3node-soak-'))
const store = await ObjectStore.open({ dataDir, minPartSize: 1, maxConcurrentWrites: Math.max(8, concurrency * 2) })
const gc = new GarbageCollector(store)
const deadline = Date.now() + durationSeconds * 1000
const counters = { putGet: 0, multipart: 0, lifecycle: 0, gc: 0, errors: 0 }
const samples = []
let stop = false

store.createBucket('soak-data')
store.createBucket('soak-expire')
store.putBucketConfig('soak-expire', 'lifecycle', {
  rules: [{
    id: 'expire-immediately', status: 'Enabled',
    filter: { prefix: '', tags: {} }, expirationDays: 0,
    expiredObjectDeleteMarker: false,
  }],
})

async function readObject(bucket, key) {
  const record = store.getObject(bucket, key)
  const chunks = []
  for await (const chunk of store.createObjectStream(record)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function putGetWorker(workerId) {
  let sequence = 0
  while (!stop && Date.now() < deadline) {
    const key = `worker-${workerId}/${sequence++}`
    const payload = randomBytes(8 * 1024 + (sequence % 32) * 1024)
    try {
      await store.putObject({ bucket: 'soak-data', key, body: Readable.from([payload]) })
      const received = await readObject('soak-data', key)
      if (!received.equals(payload)) throw new Error(`byte mismatch for ${key}`)
      await store.deleteObject('soak-data', key)
      if (sequence % 8 === 0) {
        await store.putObject({
          bucket: 'soak-expire', key: `${workerId}/${sequence}`,
          body: Readable.from([Buffer.from(String(sequence))]),
        })
      }
      counters.putGet++
    } catch (err) {
      counters.errors++
      process.stderr.write(`${JSON.stringify({ type: 'error', worker: workerId, message: err.message })}\n`)
    }
  }
}

async function multipartWorker() {
  let sequence = 0
  while (!stop && Date.now() < deadline) {
    const key = `multipart/${sequence++}`
    const firstBytes = randomBytes(64 * 1024)
    const secondBytes = randomBytes(64 * 1024)
    try {
      const { uploadId } = store.createMultipartUpload({ bucket: 'soak-data', key })
      const first = await store.uploadPart({
        bucket: 'soak-data', key, uploadId, partNumber: 1, body: Readable.from([firstBytes]),
      })
      const second = await store.uploadPart({
        bucket: 'soak-data', key, uploadId, partNumber: 2, body: Readable.from([secondBytes]),
      })
      await store.completeMultipartUpload({
        bucket: 'soak-data', key, uploadId,
        requestedParts: [{ partNumber: 1, etag: first.etag }, { partNumber: 2, etag: second.etag }],
      })
      const received = await readObject('soak-data', key)
      if (!received.equals(Buffer.concat([firstBytes, secondBytes]))) throw new Error(`multipart mismatch for ${key}`)
      await store.deleteObject('soak-data', key)
      counters.multipart++
    } catch (err) {
      counters.errors++
      process.stderr.write(`${JSON.stringify({ type: 'error', worker: 'multipart', message: err.message })}\n`)
    }
  }
}

async function maintenanceWorker() {
  while (!stop && Date.now() < deadline) {
    try {
      const lifecycle = await runLifecycle(store)
      counters.lifecycle += lifecycle.expiredObjects + lifecycle.expiredVersions + lifecycle.abortedUploads
      await gc.collect({ stalePendingBlobAgeMs: 60_000 })
      counters.gc++
    } catch (err) {
      counters.errors++
      process.stderr.write(`${JSON.stringify({ type: 'error', worker: 'maintenance', message: err.message })}\n`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
}

async function directoryBytes(path) {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) {
      try { total += (await stat(child)).size } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
  }
  return total
}

async function takeSample() {
  const memory = process.memoryUsage()
  let walBytes = 0
  try { walBytes = (await stat(join(dataDir, 'metadata.sqlite-wal'))).size } catch {}
  const sample = {
    type: 'sample', elapsedSeconds: Number(((Date.now() - (deadline - durationSeconds * 1000)) / 1000).toFixed(1)),
    heapUsed: memory.heapUsed, rss: memory.rss,
    activeResources: process.getActiveResourcesInfo().length,
    walBytes, dataBytes: await directoryBytes(dataDir), ...counters,
  }
  samples.push(sample)
  process.stdout.write(`${JSON.stringify(sample)}\n`)
}

const sampler = setInterval(() => { void takeSample() }, 1000)
try {
  await Promise.all([
    ...Array.from({ length: concurrency }, (_, index) => putGetWorker(index)),
    multipartWorker(),
    maintenanceWorker(),
  ])
} finally {
  stop = true
  clearInterval(sampler)
  await takeSample()
  const integrity = store.metadata.db.prepare('PRAGMA integrity_check').get().integrity_check
  const first = samples[0]
  const last = samples.at(-1)
  const summary = {
    type: 'summary', durationSeconds, concurrency, dataDir, integrity, ...counters,
    samples: samples.length,
    heapDeltaBytes: first && last ? last.heapUsed - first.heapUsed : 0,
    rssDeltaBytes: first && last ? last.rss - first.rss : 0,
    maxActiveResources: Math.max(...samples.map((sample) => sample.activeResources)),
    maxWalBytes: Math.max(...samples.map((sample) => sample.walBytes)),
    finalWalBytes: last?.walBytes ?? 0,
    finalDataBytes: last?.dataBytes ?? 0,
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  store.close()
  if (temporary && !values.keep) await rm(dataDir, { recursive: true, force: true })
  if (integrity !== 'ok' || counters.errors > 0) process.exitCode = 1
}
