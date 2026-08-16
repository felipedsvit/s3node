#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.js'

const usage = `Usage:
  s3node-backup backup  --source <data-dir> --destination <backup-dir>
  s3node-backup verify  --source <backup-dir>
  s3node-backup restore --source <backup-dir> --destination <new-data-dir>
`

const [command, ...args] = process.argv.slice(2)
const { values } = parseArgs({
  args,
  options: {
    source: { type: 'string' },
    destination: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help || !command) {
  process.stdout.write(usage)
  process.exit(values.help ? 0 : 1)
}
if (!values.source) throw new TypeError('--source is required')

let manifest
if (command === 'backup') {
  if (!values.destination) throw new TypeError('--destination is required')
  manifest = await createBackup(values.source, values.destination)
} else if (command === 'verify') {
  manifest = await verifyBackup(values.source)
} else if (command === 'restore') {
  if (!values.destination) throw new TypeError('--destination is required')
  manifest = await restoreBackup(values.source, values.destination)
} else {
  process.stderr.write(usage)
  throw new TypeError(`unknown command: ${command}`)
}

process.stdout.write(`${JSON.stringify({
  command,
  schemaVersion: manifest.schemaVersion,
  blobCount: manifest.blobCount,
  createdAt: manifest.createdAt,
})}\n`)
