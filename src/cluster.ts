import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'
import { supportsReusePort } from './server.js'

/**
 * Multi-core scaling by running one independent server per worker.
 *
 * Every worker binds the same port with SO_REUSEPORT, so the kernel spreads
 * incoming connections and no primary process sits in the data path.
 *
 * Metadata contention is handled by SQLite itself rather than by an RPC layer
 * or a writer lease: the database runs in WAL mode, which lets readers proceed
 * while one writer commits, and `busy_timeout` makes a blocked writer wait
 * instead of failing. That keeps MetadataStore synchronous — the option this
 * project can afford, since an RPC design would force every metadata call to
 * become async, and an alternative engine would cost the zero-dependency
 * guarantee.
 *
 * The consequence to know about: writes are serialised across the whole
 * cluster. Workers scale request handling, hashing and encryption — not the
 * metadata write rate.
 */

export interface ClusterOptions {
  /** Worker count; defaults to one per available core. */
  workers?: number
  /** Runs in the worker process and resolves once it is serving. */
  start: (context: { workerId: number; isLifecycleWorker: boolean }) => Promise<void>
  /** Runs in the worker on shutdown. */
  stop?: () => Promise<void>
  log?: (message: string) => void
}

export function clusterSupported(): boolean {
  return supportsReusePort()
}

export function defaultWorkerCount(): number {
  return Math.max(1, availableParallelism())
}

/**
 * Forks the workers and supervises them, or — when called in a worker — starts
 * the server. Resolves in the primary once every worker has exited.
 */
export async function runCluster(options: ClusterOptions): Promise<void> {
  if (!clusterSupported()) {
    throw new Error('Cluster mode requires Node.js 22.12 or newer for SO_REUSEPORT')
  }

  if (cluster.isPrimary) {
    return supervise(options)
  }

  const workerId = Number(process.env.S3NODE_WORKER_ID ?? cluster.worker?.id ?? 1)
  await options.start({
    workerId,
    // Exactly one worker sweeps lifecycle rules; otherwise every worker would
    // race to expire the same objects.
    isLifecycleWorker: workerId === 1,
  })

  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      await options.stop?.()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  process.on('message', (message) => {
    if (message === 'shutdown') void shutdown()
  })
}

function supervise({ workers = defaultWorkerCount(), log = () => {} }: ClusterOptions): Promise<void> {
  const count = Math.max(1, workers)
  log(`primary ${process.pid} starting ${count} worker${count === 1 ? '' : 's'}`)

  let shuttingDown = false
  // Worker id -> our stable slot number. The slot decides which worker owns the
  // lifecycle sweep, so a replacement has to inherit the slot of the worker it
  // replaces rather than get a fresh one.
  const slots = new Map<number, number>()

  const spawn = (slot: number): void => {
    const worker = cluster.fork({ S3NODE_WORKER_ID: String(slot) })
    slots.set(worker.id, slot)
  }

  for (let slot = 1; slot <= count; slot++) spawn(slot)

  cluster.on('exit', (worker, code, signal) => {
    const slot = slots.get(worker.id) ?? 1
    slots.delete(worker.id)
    if (shuttingDown) return
    log(`worker ${worker.process.pid} exited (${signal ?? code}); restarting`)
    spawn(slot)
  })

  const stopAll = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    log('primary shutting workers down')
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.send('shutdown')
    }
  }
  process.on('SIGTERM', stopAll)
  process.on('SIGINT', stopAll)

  return new Promise((resolve) => {
    cluster.on('exit', () => {
      if (shuttingDown && Object.keys(cluster.workers ?? {}).length === 0) resolve()
    })
  })
}
