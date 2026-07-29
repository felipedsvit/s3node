#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createServer } from '../src/index.js'
import { generateCredential } from '../src/auth/credentials.js'
import type { Credential } from '../src/auth/credentials.js'
import { clusterSupported, defaultWorkerCount, runCluster } from '../src/cluster.js'
import { ConsoleServer } from '../src/console/server.js'
import type { S3NodeServer } from '../src/server.js'

const VERSION = '0.1.4'

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
  --cluster [count]      Run one worker per core, or the given count
  --console-port <port>  Serve the admin console on this port (off by default)
  --quiet                Do not print request errors
  --help                 Show this message

If no credential is supplied, one is generated and printed at startup.

The console authenticates with an s3node credential over HTTP Basic and speaks
plain HTTP, so it binds --host (loopback by default). Do not expose it directly.
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
    cluster: { type: 'string' },
    'console-port': { type: 'string' },
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

let credential: Credential
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
const host = values.host ?? '127.0.0.1'
const port = Number(values.port ?? 9000)
const region = values.region ?? 'us-east-1'
const consolePort = values['console-port'] === undefined ? null : Number(values['console-port'])

if (consolePort !== null && !Number.isInteger(consolePort)) {
  process.stderr.write('--console-port must be a port number.\n')
  process.exit(1)
}

// `--cluster` alone means one worker per core; `--cluster 4` pins the count.
const clusterRequested = values.cluster !== undefined
const workers = clusterRequested
  ? (values.cluster === '' ? defaultWorkerCount() : Number(values.cluster))
  : 0
if (clusterRequested && (!Number.isInteger(workers) || workers < 1)) {
  process.stderr.write('--cluster expects a positive worker count.\n')
  process.exit(1)
}
if (clusterRequested && !clusterSupported()) {
  process.stderr.write('Cluster mode needs Node.js 22.12 or newer (SO_REUSEPORT).\n')
  process.exit(1)
}

const logger = values.quiet ? null : {
  error(entry: Record<string, unknown>) {
    process.stderr.write(`${JSON.stringify(entry)}\n`)
  },
}

interface Running {
  server: S3NodeServer
  console: ConsoleServer | null
}

async function start({ reusePort = false, withConsole = true, withLifecycle = true } = {}): Promise<Running> {
  const server = await createServer({
    dataDir,
    port,
    host,
    region,
    virtualHostDomain: values['virtual-host'] ?? null,
    credentials: [credential],
    logger,
    reusePort,
    ...(withLifecycle ? {} : { lifecycleIntervalMs: 0 }),
  })

  let adminConsole: ConsoleServer | null = null
  if (consolePort !== null && withConsole) {
    adminConsole = new ConsoleServer({
      store: server.store,
      credentials: server.credentials,
      region,
      version: VERSION,
    })
    await adminConsole.listen(consolePort, host)
  }
  return { server, console: adminConsole }
}

function banner(running: Running, suffix = ''): string {
  return (
    `s3node listening on ${running.server.endpoint}${suffix}\n` +
    (running.console ? `  console      ${running.console.endpoint}\n` : '') +
    `  data dir     ${dataDir}\n` +
    `  region       ${region}\n` +
    `  access key   ${credential.accessKeyId}\n` +
    (generated
      ? `  secret key   ${credential.secretAccessKey}\n\n` +
        'This credential was generated for this run. Pass --access-key/--secret-key\n' +
        '(or S3NODE_ACCESS_KEY_ID / S3NODE_SECRET_ACCESS_KEY) to keep it stable.\n'
      : '') +
    `\nExample:\n` +
    `  AWS_ACCESS_KEY_ID=${credential.accessKeyId} \\\n` +
    `  AWS_SECRET_ACCESS_KEY=${generated ? credential.secretAccessKey : '<secret>'} \\\n` +
    `  aws --endpoint-url ${running.server.endpoint} s3 ls\n`
  )
}

async function shutdown(running: Running): Promise<void> {
  await running.console?.close()
  await running.server.close()
}

if (clusterRequested) {
  let running: Running | null = null
  await runCluster({
    workers,
    log: (message) => { if (!values.quiet) process.stdout.write(`${message}\n`) },
    async start({ workerId, isLifecycleWorker }) {
      running = await start({
        reusePort: true,
        // One console and one lifecycle sweep for the whole cluster, both on
        // worker 1 — otherwise every worker would bind the console port and
        // race to expire the same objects.
        withConsole: isLifecycleWorker,
        withLifecycle: isLifecycleWorker,
      })
      if (workerId === 1) process.stdout.write(banner(running, ` (${workers} workers)`))
    },
    async stop() {
      if (running) await shutdown(running)
    },
  })
} else {
  const running = await start()
  process.stdout.write(banner(running))

  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (closing) return
      closing = true
      await shutdown(running)
      process.exit(0)
    })
  }
}
