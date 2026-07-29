/**
 * Promise-based counting semaphore. `limit <= 0` disables the check entirely
 * (acquire always grants immediately), matching the convention already used
 * by `maxConcurrentUploads`.
 */
export class Semaphore {
  private available: number
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {
    this.available = limit
  }

  /**
   * Resolves with a release function once a slot is free. If `timeoutMs` is
   * given and no slot frees up in time, the request is dropped from the queue
   * and the promise rejects instead of waiting forever.
   */
  async acquire(timeoutMs = 0): Promise<() => void> {
    if (this.limit <= 0) return () => {}
    if (this.available > 0) {
      this.available--
      return () => this.release()
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const grant = (): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(() => this.release())
      }

      this.queue.push(grant)

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          const index = this.queue.indexOf(grant)
          if (index !== -1) this.queue.splice(index, 1)
          reject(new Error('Semaphore acquire timed out'))
        }, timeoutMs)
        timer.unref?.()
      }
    })
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.available++
  }
}
