#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createServer } from '../src/index.js'
import { generateCredential } from '../src/auth/credentials.js'
import type { Credential } from '../src/auth/credentials.js'
import { clusterSupported, defaultWorkerCount, runCluster } from '../src/cluster.js'
import { ConsoleServer } from '../src/console/server.js'
import type { S3NodeServer } from '../src/server.js'
import { redactUrlForLog } from '../src/http.js'

const VERSION = '0.1.9'

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
  --max-concurrent-writes <n>  Concurrent blob writes       (default: 64)
  --rate-limit <rps>     Sustained requests/sec per caller   (default: 1000)
  --rate-limit-burst <n> Burst capacity                      (default: 2000)
  --request-timeout-ms <ms>  Maximum request duration        (default: 300000)
  --socket-timeout-ms <ms>   Idle socket timeout             (default: 120000)
  --allow-private-notification-endpoints  Allow private/loopback webhook targets
  --quiet                Do not print request errors
  --version              Print the installed version
  --help                 Show this message

If no credential is supplied, one is generated and printed at startup.

The console authenticates with an s3node credential over HTTP Basic and speaks
plain HTTP, so it binds --host (loopback by default). Do not expose it directly.
`

const cliArgs = process.argv.slice(2)
const bareCluster = cliArgs.indexOf('--cluster')
if (bareCluster !== -1 && (cliArgs[bareCluster + 1] === undefined || cliArgs[bareCluster + 1]!.startsWith('-'))) {
  cliArgs[bareCluster] = '--cluster='
}

const { values } = parseArgs({
  args: cliArgs,
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
    'max-concurrent-writes': { type: 'string' },
    'rate-limit': { type: 'string' },
    'rate-limit-burst': { type: 'string' },
    'request-timeout-ms': { type: 'string' },
    'socket-timeout-ms': { type: 'string' },
    'allow-private-notification-endpoints': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.version) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (values.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const accessKeyId = values['access-key'] ?? process.env['S3NODE_ACCESS_KEY_ID']
const secretAccessKey = values['secret-key'] ?? process.env['S3NODE_SECRET_ACCESS_KEY']

let credential: Credential
let generated = process.env['S3NODE_GENERATED_CREDENTIAL'] === '1'
if (accessKeyId && secretAccessKey) {
  credential = { accessKeyId, secretAccessKey }
} else if (accessKeyId || secretAccessKey) {
  process.stderr.write('Both --access-key and --secret-key must be provided together.\n')
  process.exit(1)
} else {
  credential = generateCredential()
  generated = true
  if (values.cluster !== undefined) {
    process.env['S3NODE_ACCESS_KEY_ID'] = credential.accessKeyId
    process.env['S3NODE_SECRET_ACCESS_KEY'] = credential.secretAccessKey
    process.env['S3NODE_GENERATED_CREDENTIAL'] = '1'
  }
}

const dataDir = resolve(values['data-dir'] ?? './s3node-data')
const host = values.host ?? '127.0.0.1'
const port = Number(values.port ?? 9000)
const region = values.region ?? 'us-east-1'
const consolePort = values['console-port'] === undefined ? null : Number(values['console-port'])
const maxConcurrentWrites = Number(values['max-concurrent-writes'] ?? 64)
const rateLimitPerSecond = Number(values['rate-limit'] ?? 1000)
const rateLimitBurst = Number(values['rate-limit-burst'] ?? 2000)
const requestTimeoutMs = Number(values['request-timeout-ms'] ?? 300_000)
const socketTimeoutMs = Number(values['socket-timeout-ms'] ?? 120_000)

function validInteger(value: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

if (!validInteger(port, { max: 65535 })) {
  process.stderr.write('--port must be an integer from 0 through 65535.\n')
  process.exit(1)
}

if (consolePort !== null && !validInteger(consolePort, { max: 65535 })) {
  process.stderr.write('--console-port must be an integer from 0 through 65535.\n')
  process.exit(1)
}
for (const [name, value, min] of [
  ['--max-concurrent-writes', maxConcurrentWrites, 0],
  ['--rate-limit', rateLimitPerSecond, 1],
  ['--rate-limit-burst', rateLimitBurst, 1],
  ['--request-timeout-ms', requestTimeoutMs, 1],
  ['--socket-timeout-ms', socketTimeoutMs, 1],
] as const) {
  if (!validInteger(value, { min })) {
    process.stderr.write(`${name} must be an integer >= ${min}.\n`)
    process.exit(1)
  }
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
if (clusterRequested && port === 0) {
  process.stderr.write('--port 0 cannot be used with --cluster; choose one shared port.\n')
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
  // Each worker owns an in-process limiter. Divide the CLI's advertised
  // budget so the cluster's aggregate limit remains approximately constant.
  const rateShare = reusePort ? Math.max(1, rateLimitPerSecond / workers) : rateLimitPerSecond
  const burstShare = reusePort ? Math.max(1, Math.ceil(rateLimitBurst / workers)) : rateLimitBurst
  const server = await createServer({
    dataDir,
    port,
    host,
    region,
    virtualHostDomain: values['virtual-host'] ?? null,
    credentials: [credential],
    logger,
    reusePort,
    maxConcurrentWrites,
    rateLimitPerSecond: rateShare,
    rateLimitBurst: burstShare,
    requestTimeoutMs,
    socketTimeoutMs,
    allowPrivateNotificationEndpoints: values['allow-private-notification-endpoints'],
    ...(withLifecycle ? {} : { lifecycleIntervalMs: 0 }),
  })

  if (!values.quiet) {
    server.http.on('request', (req, res) => {
      const start = process.hrtime.bigint()
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6
        process.stdout.write(`[s3node] ${req.method} ${redactUrlForLog(req.url)} ${res.statusCode} ${ms.toFixed(1)}ms\n`)
      })
    })
  }

  let adminConsole: ConsoleServer | null = null
  if (consolePort !== null && withConsole) {
    adminConsole = new ConsoleServer({
      store: server.store,
      credentials: server.credentials,
      region,
      version: VERSION,
      metrics: server.metrics,
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
      try {
        await shutdown(running)
        process.exit(0)
      } catch (err) {
        process.stderr.write(`shutdown failed: ${(err as Error).message}\n`)
        process.exit(1)
      }
    })
  }
}
