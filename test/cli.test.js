import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

function cli(...args) {
  return spawnSync(process.execPath, ['dist/bin/s3node.js', ...args], { encoding: 'utf8' })
}

describe('CLI validation', () => {
  it('reports the package version', () => {
    const result = cli('--version')
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '0.1.10\n')
    assert.equal(result.stderr, '')
  })

  it('documents operational limits and timeouts', () => {
    const result = cli('--help')
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--max-concurrent-writes/)
    assert.match(result.stdout, /--rate-limit/)
    assert.match(result.stdout, /--request-timeout-ms/)
    assert.match(result.stdout, /--version/)
  })

  it('rejects invalid ports without starting a listener', () => {
    const result = cli('--port', '70000')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /integer from 0 through 65535/)
  })

  it('parses bare --cluster and rejects an unshareable ephemeral port', () => {
    const result = cli('--cluster', '--port', '0')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot be used with --cluster/)
  })
})
