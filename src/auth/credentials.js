import { randomBytes } from 'node:crypto'

/**
 * In-memory credential store.
 *
 * SigV4 recomputes an HMAC from the secret, so the secret cannot be stored as a
 * one-way hash — the store always holds recoverable material and must be
 * treated accordingly (docs/plan.md section 7).
 */
export class CredentialStore {
  constructor(credentials = []) {
    this.credentials = new Map()
    for (const credential of credentials) this.add(credential)
  }

  add({ accessKeyId, secretAccessKey }) {
    if (!accessKeyId || !secretAccessKey) {
      throw new TypeError('A credential requires both accessKeyId and secretAccessKey')
    }
    this.credentials.set(accessKeyId, { accessKeyId, secretAccessKey })
    return this
  }

  get(accessKeyId) {
    return this.credentials.get(accessKeyId)
  }

  get size() {
    return this.credentials.size
  }

  /** Bound lookup suitable for passing into `verifyRequest`. */
  lookup = (accessKeyId) => this.get(accessKeyId)
}

export function generateCredential() {
  return {
    accessKeyId: randomBytes(10).toString('hex').toUpperCase(),
    secretAccessKey: randomBytes(30).toString('base64url'),
  }
}
