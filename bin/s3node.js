#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createServer } from '../src/index.js'
import { generateCredential } from '../src/auth/credentials.js'

const USAGE = `
s3node — S3-compatible object storage server

Usage:
  s3node [options]

Options:
  --data-dir <path>      Where objects and metadata live      (default: ./s3node-data)
  --port <number>        Port to listen on                    (default: 9000)
  --host <address>       Address to bind                      (default: 127.0.0.1)
  --region <name>        Region reported to clients           (default: us-east-1)
  --access-key <id>      Access key id      (env: S3NODE_ACCESS_KEY_ID)
  --secret-key <secret>  Secret access key  (env: S3NODE_SECRET_ACCESS_KEY)
  --virtual-host <domain>  Base domain for virtual-host style addressing
  --quiet                Do not print request errors
  --help                 Show this message

If no credential is supplied, one is generated and printed at startup.
`

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    region: { type: 'string' },
    'access-key': { type: 'string' },
    'secret-key': { type: 'string' },
    'virtual-host': { type: 'string' },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const accessKeyId = values['access-key'] ?? process.env.S3NODE_ACCESS_KEY_ID
const secretAccessKey = values['secret-key'] ?? process.env.S3NODE_SECRET_ACCESS_KEY

let credential
let generated = false
if (accessKeyId && secretAccessKey) {
  credential = { accessKeyId, secretAccessKey }
} else if (accessKeyId || secretAccessKey) {
  process.stderr.write('Both --access-key and --secret-key must be provided together.\n')
  process.exit(1)
} else {
  credential = generateCredential()
  generated = true
}

const dataDir = resolve(values['data-dir'] ?? './s3node-data')

const server = await createServer({
  dataDir,
  port: Number(values.port ?? 9000),
  host: values.host ?? '127.0.0.1',
  region: values.region ?? 'us-east-1',
  virtualHostDomain: values['virtual-host'] ?? null,
  credentials: [credential],
  logger: values.quiet ? null : {
    error(entry) {
      process.stderr.write(`${JSON.stringify(entry)}\n`)
    },
  },
})

process.stdout.write(
  `s3node listening on ${server.endpoint}\n` +
  `  data dir     ${dataDir}\n` +
  `  region       ${values.region ?? 'us-east-1'}\n` +
  `  access key   ${credential.accessKeyId}\n` +
  (generated
    ? `  secret key   ${credential.secretAccessKey}\n\n` +
      'This credential was generated for this run. Pass --access-key/--secret-key\n' +
      '(or S3NODE_ACCESS_KEY_ID / S3NODE_SECRET_ACCESS_KEY) to keep it stable.\n'
    : '') +
  `\nExample:\n` +
  `  AWS_ACCESS_KEY_ID=${credential.accessKeyId} \\\n` +
  `  AWS_SECRET_ACCESS_KEY=${generated ? credential.secretAccessKey : '<secret>'} \\\n` +
  `  aws --endpoint-url ${server.endpoint} s3 ls\n`,
)

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return
    closing = true
    await server.close()
    process.exit(0)
  })
}
