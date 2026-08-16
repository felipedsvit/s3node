#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from '../../dist/src/index.js'

const { values } = parseArgs({
  options: { require: { type: 'string', default: '' } },
})
const required = new Set(values.require.split(',').map((name) => name.trim()).filter(Boolean))
const credentials = { accessKeyId: 'MATRIXACCESSKEY', secretAccessKey: 'matrix-secret-key' }
const root = await mkdtemp(join(tmpdir(), 's3node-client-matrix-'))
const source = join(root, 'source.bin')
const expected = randomBytes(128 * 1024)
await writeFile(source, expected)
const server = await createServer({ dataDir: join(root, 'data'), credentials: [credentials], port: 0, host: '127.0.0.1' })
const results = []

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited ${signal ?? code}: ${stderr || stdout}`))
    })
  })
}

async function available(command, args) {
  try { await run(command, args); return true } catch { return false }
}

async function execute(name, probe, exercise) {
  if (!await probe()) {
    const status = required.has(name) ? 'FAIL' : 'SKIP'
    results.push({ client: name, status, reason: 'client is not installed' })
    return
  }
  try {
    await exercise()
    results.push({ client: name, status: 'PASS' })
  } catch (err) {
    results.push({ client: name, status: 'FAIL', reason: err.message })
  }
}

const awsEnv = {
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_EC2_METADATA_DISABLED: 'true',
}

await execute('aws-cli', () => available('aws', ['--version']), async () => {
  const bucket = 'matrix-aws-cli'
  const output = join(root, 'aws-output.bin')
  const base = ['--endpoint-url', server.endpoint, '--region', 'us-east-1', 's3api']
  await run('aws', [...base, 'create-bucket', '--bucket', bucket], { env: awsEnv })
  await run('aws', [...base, 'put-object', '--bucket', bucket, '--key', 'matrix.bin', '--body', source], { env: awsEnv })
  await run('aws', [...base, 'head-object', '--bucket', bucket, '--key', 'matrix.bin'], { env: awsEnv })
  await run('aws', [...base, 'get-object', '--bucket', bucket, '--key', 'matrix.bin', output], { env: awsEnv })
  if (!(await readFile(output)).equals(expected)) throw new Error('download was not byte-identical')
  await run('aws', [...base, 'delete-object', '--bucket', bucket, '--key', 'matrix.bin'], { env: awsEnv })
  await run('aws', [...base, 'delete-bucket', '--bucket', bucket], { env: awsEnv })
})

await execute('boto3', () => available('python3', ['-c', 'import boto3']), async () => {
  const output = join(root, 'boto-output.bin')
  const script = `
import boto3, os
s3 = boto3.client('s3', endpoint_url=os.environ['S3NODE_ENDPOINT'], region_name='us-east-1')
bucket = 'matrix-boto3'
s3.create_bucket(Bucket=bucket)
s3.upload_file(os.environ['S3NODE_SOURCE'], bucket, 'matrix.bin')
s3.head_object(Bucket=bucket, Key='matrix.bin')
s3.download_file(bucket, 'matrix.bin', os.environ['S3NODE_OUTPUT'])
s3.delete_object(Bucket=bucket, Key='matrix.bin')
s3.delete_bucket(Bucket=bucket)
`
  await run('python3', ['-c', script], { env: {
    ...awsEnv,
    S3NODE_ENDPOINT: server.endpoint,
    S3NODE_SOURCE: source,
    S3NODE_OUTPUT: output,
  } })
  if (!(await readFile(output)).equals(expected)) throw new Error('download was not byte-identical')
})

await execute('rclone', () => available('rclone', ['version']), async () => {
  const bucket = 'matrix-rclone'
  const output = join(root, 'rclone-output.bin')
  const flags = [
    '--config', '/dev/null',
    '--s3-provider', 'Other',
    '--s3-access-key-id', credentials.accessKeyId,
    '--s3-secret-access-key', credentials.secretAccessKey,
    '--s3-endpoint', server.endpoint,
    '--s3-region', 'us-east-1',
    '--s3-force-path-style',
  ]
  await run('rclone', ['mkdir', `:s3:${bucket}`, ...flags])
  await run('rclone', ['copyto', source, `:s3:${bucket}/matrix.bin`, ...flags])
  await run('rclone', ['lsjson', `:s3:${bucket}`, ...flags])
  await run('rclone', ['copyto', `:s3:${bucket}/matrix.bin`, output, ...flags])
  if (!(await readFile(output)).equals(expected)) throw new Error('download was not byte-identical')
  await run('rclone', ['deletefile', `:s3:${bucket}/matrix.bin`, ...flags])
  await run('rclone', ['rmdir', `:s3:${bucket}`, ...flags])
})

await server.close()
await rm(root, { recursive: true, force: true })
for (const result of results) process.stdout.write(`${result.status.padEnd(4)} ${result.client}${result.reason ? ` — ${result.reason}` : ''}\n`)
const passed = results.filter((result) => result.status === 'PASS').length
const failed = results.filter((result) => result.status === 'FAIL').length
const skipped = results.filter((result) => result.status === 'SKIP').length
process.stdout.write(`${passed} passed, ${failed} failed, ${skipped} skipped\n`)
if (failed > 0) process.exitCode = 1
