import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import * as sqlite from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { SCHEMA_VERSION } from './storage/metadata/schema.js'

const MANIFEST_NAME = 'backup-manifest.json'

interface ManifestFile {
  size: number
  sha256: string
}

export interface BackupManifest {
  format: 1
  createdAt: string
  schemaVersion: number
  blobCount: number
  files: Record<string, ManifestFile>
}

function sqliteValue(row: Record<string, unknown> | undefined): unknown {
  return row ? Object.values(row)[0] : undefined
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback()
    },
  }))
  return hash.digest('hex')
}

function safeManifestPath(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe backup manifest path: ${name}`)
  }
  const path = resolve(root, name)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`unsafe backup manifest path: ${name}`)
  return path
}

async function safeExistingManifestFile(root: string, name: string): Promise<{ path: string; size: number }> {
  const path = safeManifestPath(root, name)
  const linkInfo = await lstat(path)
  if (linkInfo.isSymbolicLink()) throw new Error(`backup file must not be a symbolic link: ${name}`)
  const actual = await realpath(path)
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    throw new Error(`backup file resolves outside the backup root: ${name}`)
  }
  const info = await stat(actual)
  if (!info.isFile()) throw new Error(`backup entry is not a regular file: ${name}`)
  return { path: actual, size: info.size }
}

type DatabaseSync = InstanceType<typeof sqlite.DatabaseSync>

function readBlobIds(db: DatabaseSync): string[] {
  const ids = new Set<string>()
  for (const row of db.prepare('SELECT blob_id, parts FROM objects').all() as { blob_id: string | null; parts: string | null }[]) {
    if (row.blob_id) ids.add(row.blob_id)
    if (row.parts) {
      const parts = JSON.parse(row.parts) as { blobId?: unknown }[]
      for (const part of parts) {
        if (typeof part.blobId !== 'string') throw new Error('invalid multipart blob reference in metadata')
        ids.add(part.blobId)
      }
    }
  }
  for (const row of db.prepare('SELECT blob_id FROM upload_parts').all() as { blob_id: string }[]) ids.add(row.blob_id)
  for (const id of ids) {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`invalid blob id in metadata: ${id}`)
  }
  return [...ids].sort()
}

function blobRelativePath(blobId: string): string {
  return join('data', blobId.slice(0, 2), blobId.slice(2, 4), blobId)
}

async function copyDurable(source: string, destination: string): Promise<ManifestFile> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination)
  await chmod(destination, 0o600)
  await syncFile(destination)
  const info = await stat(destination)
  return { size: info.size, sha256: await sha256File(destination) }
}

function assertSeparateTrees(source: string, destination: string): void {
  if (source === destination || destination.startsWith(`${source}${sep}`) || source.startsWith(`${destination}${sep}`)) {
    throw new Error('source and destination must be separate directory trees')
  }
}

/**
 * Creates an atomic, manifest-verified snapshot. A SQLite IMMEDIATE transaction
 * prevents metadata writers from committing while referenced blobs are copied;
 * reads continue. The SQLite backup API folds committed WAL pages into the
 * standalone metadata.sqlite snapshot, so WAL/SHM companions are not restored.
 */
export async function createBackup(sourceDirectory: string, destinationDirectory: string): Promise<BackupManifest> {
  const source = await realpath(resolve(sourceDirectory))
  const destination = resolve(destinationDirectory)
  assertSeparateTrees(source, destination)
  if (await pathExists(destination)) throw new Error(`backup destination already exists: ${destination}`)
  if (!await pathExists(join(source, 'metadata.sqlite'))) throw new Error(`source metadata.sqlite does not exist: ${source}`)
  if (!await pathExists(join(source, 'master.key'))) {
    throw new Error('source master.key does not exist; externally managed keys must be backed up by their key manager')
  }
  const databaseFile = await safeExistingManifestFile(source, 'metadata.sqlite')
  const masterKeyFile = await safeExistingManifestFile(source, 'master.key')

  const staging = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await mkdir(staging, { recursive: false, mode: 0o700 })
  const databasePath = databaseFile.path
  const lockDb = new sqlite.DatabaseSync(databasePath, { timeout: 30_000 })
  const snapshotDb = new sqlite.DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 })
  let inTransaction = false
  try {
    lockDb.exec('PRAGMA busy_timeout = 30000')
    lockDb.exec('BEGIN IMMEDIATE')
    inTransaction = true
    if (sqliteValue(snapshotDb.prepare('PRAGMA integrity_check').get() as Record<string, unknown>) !== 'ok') {
      throw new Error('source metadata.sqlite failed PRAGMA integrity_check')
    }

    const schemaVersion = Number(sqliteValue(snapshotDb.prepare('PRAGMA user_version').get() as Record<string, unknown>))
    if (schemaVersion > SCHEMA_VERSION) throw new Error(`source schema ${schemaVersion} is newer than supported schema ${SCHEMA_VERSION}`)
    const blobIds = readBlobIds(snapshotDb)
    const files: Record<string, ManifestFile> = {}

    const metadataPath = join(staging, 'metadata.sqlite')
    const backup = (sqlite as unknown as {
      backup?: (source: DatabaseSync, destination: string, options?: { rate?: number }) => Promise<number>
    }).backup
    if (backup) {
      await backup(snapshotDb, metadataPath, { rate: 256 })
    } else {
      // node:sqlite.backup arrived after the package's Node 22.13 floor.
      // VACUUM INTO uses SQLite's own snapshot logic and produces the same
      // standalone, WAL-free database while lockDb prevents writer commits.
      snapshotDb.prepare('VACUUM INTO ?').run(metadataPath)
    }
    await chmod(metadataPath, 0o600)
    await syncFile(metadataPath)
    files['metadata.sqlite'] = { size: (await stat(metadataPath)).size, sha256: await sha256File(metadataPath) }
    files['master.key'] = await copyDurable(masterKeyFile.path, join(staging, 'master.key'))

    for (const blobId of blobIds) {
      const name = blobRelativePath(blobId)
      const blobFile = await safeExistingManifestFile(source, name)
      files[name] = await copyDurable(blobFile.path, join(staging, name))
    }

    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      schemaVersion,
      blobCount: blobIds.length,
      files,
    }
    const manifestPath = join(staging, MANIFEST_NAME)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await syncFile(manifestPath)
    await syncDirectory(staging)

    snapshotDb.close()
    lockDb.exec('COMMIT')
    inTransaction = false
    lockDb.close()
    await rename(staging, destination)
    await syncDirectory(dirname(destination))
    return manifest
  } catch (err) {
    if (inTransaction) {
      try { lockDb.exec('ROLLBACK') } catch { /* connection may already be closed */ }
    }
    try { snapshotDb.close() } catch { /* already closed */ }
    try { lockDb.close() } catch { /* already closed */ }
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function verifyBackup(backupDirectory: string): Promise<BackupManifest> {
  const root = await realpath(resolve(backupDirectory))
  const manifestFile = await safeExistingManifestFile(root, MANIFEST_NAME)
  const manifest = JSON.parse(await readFile(manifestFile.path, 'utf8')) as BackupManifest
  if (manifest.format !== 1 || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('unsupported or malformed backup manifest')
  }
  if (!manifest.files['metadata.sqlite'] || !manifest.files['master.key']) {
    throw new Error('backup manifest is missing metadata.sqlite or master.key')
  }

  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = await safeExistingManifestFile(root, name)
    if (file.size !== expected.size) throw new Error(`backup size mismatch: ${name}`)
    const digest = await sha256File(file.path)
    if (digest !== expected.sha256) throw new Error(`backup checksum mismatch: ${name}`)
  }

  const db = new sqlite.DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true })
  try {
    if (sqliteValue(db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>) !== 'ok') {
      throw new Error('backup metadata.sqlite failed PRAGMA integrity_check')
    }
    const referenced = readBlobIds(db)
    for (const blobId of referenced) {
      if (!manifest.files[blobRelativePath(blobId)]) throw new Error(`backup is missing referenced blob ${blobId}`)
    }
    if (referenced.length !== manifest.blobCount) throw new Error('backup blob count does not match its manifest')
  } finally {
    db.close()
  }
  return manifest
}

export async function restoreBackup(backupDirectory: string, destinationDirectory: string): Promise<BackupManifest> {
  const source = await realpath(resolve(backupDirectory))
  const destination = resolve(destinationDirectory)
  assertSeparateTrees(source, destination)
  if (await pathExists(destination)) throw new Error(`restore destination already exists: ${destination}`)
  const manifest = await verifyBackup(source)
  const staging = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await mkdir(staging, { recursive: false, mode: 0o700 })
  try {
    for (const name of Object.keys(manifest.files)) {
      const file = await safeExistingManifestFile(source, name)
      await copyDurable(file.path, safeManifestPath(staging, name))
    }
    const manifestFile = await safeExistingManifestFile(source, MANIFEST_NAME)
    await copyDurable(manifestFile.path, join(staging, MANIFEST_NAME))
    await syncDirectory(staging)
    await rename(staging, destination)
    await syncDirectory(dirname(destination))
    return await verifyBackup(destination)
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export { MANIFEST_NAME }
