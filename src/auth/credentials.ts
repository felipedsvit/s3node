import { randomBytes } from 'node:crypto'

export interface Credential {
  accessKeyId: string
  secretAccessKey: string
}

export class CredentialStore {
  credentials: Map<string, Credential>

  constructor(credentials: Credential[] = []) {
    this.credentials = new Map()
    for (const credential of credentials) this.add(credential)
  }

  add({ accessKeyId, secretAccessKey }: Credential): this {
    if (!accessKeyId || !secretAccessKey) {
      throw new TypeError('A credential requires both accessKeyId and secretAccessKey')
    }
    this.credentials.set(accessKeyId, { accessKeyId, secretAccessKey })
    return this
  }

  get(accessKeyId: string): Credential | undefined {
    return this.credentials.get(accessKeyId)
  }

  get size(): number {
    return this.credentials.size
  }

  lookup = (accessKeyId: string): Credential | undefined => this.get(accessKeyId)
}

export function generateCredential(): Credential {
  return {
    accessKeyId: randomBytes(10).toString('hex').toUpperCase(),
    secretAccessKey: randomBytes(30).toString('base64url'),
  }
}
