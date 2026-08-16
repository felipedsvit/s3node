/**
 * Test-only crash injection. Production code cannot activate a point by
 * accident: both the explicit enable flag and an exact point name are needed.
 * The recovery suite runs each point in a disposable child process.
 */
export function faultPoint(name: string): void {
  if (process.env['S3NODE_ENABLE_FAULT_INJECTION'] !== '1') return
  if (process.env['S3NODE_FAULT_POINT'] !== name) return
  process.kill(process.pid, 'SIGKILL')
}
