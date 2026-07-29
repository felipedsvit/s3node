import { S3Error } from '../errors.js'
import { childNamed, childText, document, parseXml, text } from '../xml.js'

export const RETENTION_MODES = ['GOVERNANCE', 'COMPLIANCE'] as const
export type RetentionMode = (typeof RETENTION_MODES)[number]

export interface ObjectLockConfig {
  enabled: boolean
  /** Bucket-wide default applied to objects that arrive without their own. */
  defaultRetention?: {
    mode: RetentionMode
    days?: number
    years?: number
  }
}

export interface Retention {
  mode: RetentionMode
  retainUntil: Date
}

/** The lock state of a single object version. */
export interface LockState {
  retentionMode: string | null
  retainUntil: Date | null
  legalHold: boolean
}

function assertMode(value: string | undefined): RetentionMode {
  if (value !== 'GOVERNANCE' && value !== 'COMPLIANCE') {
    throw new S3Error('MalformedXML', 'Mode must be GOVERNANCE or COMPLIANCE')
  }
  return value
}

function parseDate(value: string | undefined, field: string): Date {
  const parsed = Date.parse(value ?? '')
  if (!Number.isFinite(parsed)) throw new S3Error('MalformedXML', `Invalid ${field}`)
  return new Date(parsed)
}

export function parseObjectLockConfigXml(body: string | Buffer): ObjectLockConfig {
  const root = parseXml(body)
  if (root.name !== 'ObjectLockConfiguration') {
    throw new S3Error('MalformedXML', 'Expected an ObjectLockConfiguration element')
  }
  const enabled = childText(root, 'ObjectLockEnabled') === 'Enabled'
  const rule = childNamed(root, 'Rule')
  const defaultRetention = rule ? childNamed(rule, 'DefaultRetention') : null
  if (!defaultRetention) return { enabled }

  const days = childText(defaultRetention, 'Days')
  const years = childText(defaultRetention, 'Years')
  if (days !== undefined && years !== undefined) {
    throw new S3Error('MalformedXML', 'DefaultRetention accepts either Days or Years, not both')
  }
  const period = days ?? years
  const amount = Number.parseInt(period ?? '', 10)
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new S3Error('MalformedXML', 'DefaultRetention requires a positive Days or Years')
  }

  return {
    enabled,
    defaultRetention: {
      mode: assertMode(childText(defaultRetention, 'Mode')),
      ...(days !== undefined ? { days: amount } : { years: amount }),
    },
  }
}

export function objectLockConfigXml(config: ObjectLockConfig): string {
  const retention = config.defaultRetention
  const rule = retention
    ? `<Rule><DefaultRetention>${text('Mode', retention.mode)}${
        retention.days !== undefined ? text('Days', retention.days) : ''
      }${retention.years !== undefined ? text('Years', retention.years) : ''
      }</DefaultRetention></Rule>`
    : ''
  return document('ObjectLockConfiguration',
    text('ObjectLockEnabled', config.enabled ? 'Enabled' : 'Disabled') + rule)
}

export function parseRetentionXml(body: string | Buffer): Retention {
  const root = parseXml(body)
  if (root.name !== 'Retention') throw new S3Error('MalformedXML', 'Expected a Retention element')
  return {
    mode: assertMode(childText(root, 'Mode')),
    retainUntil: parseDate(childText(root, 'RetainUntilDate'), 'RetainUntilDate'),
  }
}

export function retentionXml(lock: LockState): string {
  if (!lock.retentionMode || !lock.retainUntil) {
    throw new S3Error('NoSuchObjectLockConfiguration', 'The object has no retention settings')
  }
  return document('Retention',
    text('Mode', lock.retentionMode) + text('RetainUntilDate', lock.retainUntil.toISOString()))
}

export function parseLegalHoldXml(body: string | Buffer): boolean {
  const root = parseXml(body)
  if (root.name !== 'LegalHold') throw new S3Error('MalformedXML', 'Expected a LegalHold element')
  const status = childText(root, 'Status')
  if (status !== 'ON' && status !== 'OFF') {
    throw new S3Error('MalformedXML', 'LegalHold Status must be ON or OFF')
  }
  return status === 'ON'
}

export function legalHoldXml(held: boolean): string {
  return document('LegalHold', text('Status', held ? 'ON' : 'OFF'))
}

/** Reads the lock headers S3 accepts on PutObject / CreateMultipartUpload. */
export function lockFromHeaders(headers: Record<string, string | string[] | undefined>): Partial<LockState> {
  const mode = headers['x-amz-object-lock-mode']
  const until = headers['x-amz-object-lock-retain-until-date']
  const hold = headers['x-amz-object-lock-legal-hold']

  if ((mode === undefined) !== (until === undefined)) {
    throw new S3Error('InvalidRequest',
      'x-amz-object-lock-mode and x-amz-object-lock-retain-until-date must be used together')
  }
  const state: Partial<LockState> = {}
  if (mode !== undefined) {
    state.retentionMode = assertMode(String(mode))
    state.retainUntil = parseDate(String(until), 'x-amz-object-lock-retain-until-date')
  }
  if (hold !== undefined) {
    const value = String(hold).toUpperCase()
    if (value !== 'ON' && value !== 'OFF') {
      throw new S3Error('InvalidRequest', 'x-amz-object-lock-legal-hold must be ON or OFF')
    }
    state.legalHold = value === 'ON'
  }
  return state
}

/** Response headers describing an object's lock state. */
export function lockResponseHeaders(lock: LockState): Record<string, string> {
  const headers: Record<string, string> = {}
  if (lock.retentionMode && lock.retainUntil) {
    headers['x-amz-object-lock-mode'] = lock.retentionMode
    headers['x-amz-object-lock-retain-until-date'] = lock.retainUntil.toISOString()
  }
  if (lock.legalHold) headers['x-amz-object-lock-legal-hold'] = 'ON'
  return headers
}

/** Turns a bucket default retention into a concrete expiry from `now`. */
export function applyDefaultRetention(config: ObjectLockConfig | null, now = Date.now()): Partial<LockState> {
  const retention = config?.defaultRetention
  if (!config?.enabled || !retention) return {}
  const days = retention.days ?? (retention.years ?? 0) * 365
  return {
    retentionMode: retention.mode,
    retainUntil: new Date(now + days * 24 * 60 * 60 * 1000),
  }
}

export interface LockGuardOptions {
  /** `x-amz-bypass-governance-retention`, which only ever relaxes GOVERNANCE. */
  bypassGovernance?: boolean
  now?: number
}

/**
 * Refuses to remove a version that Object Lock still protects.
 *
 * A legal hold blocks unconditionally. COMPLIANCE blocks until the retain-until
 * date passes and cannot be bypassed by anyone, which is the whole point of the
 * mode. GOVERNANCE blocks too, but yields to an explicit bypass header.
 */
export function assertVersionDeletable(lock: LockState, { bypassGovernance = false, now = Date.now() }: LockGuardOptions = {}): void {
  if (lock.legalHold) {
    throw new S3Error('AccessDenied', 'The object version is under a legal hold')
  }
  if (!lock.retentionMode || !lock.retainUntil) return
  if (now >= lock.retainUntil.getTime()) return

  if (lock.retentionMode === 'GOVERNANCE' && bypassGovernance) return
  throw new S3Error('AccessDenied',
    `The object version is retained under ${lock.retentionMode} until ${lock.retainUntil.toISOString()}`)
}

/**
 * Guards a retention *change*. Shortening or removing retention is as dangerous
 * as deleting, so COMPLIANCE forbids it outright and GOVERNANCE needs the
 * bypass header. Extending is always allowed.
 */
export function assertRetentionReplaceable(current: LockState, next: Retention | null, { bypassGovernance = false, now = Date.now() }: LockGuardOptions = {}): void {
  if (!current.retentionMode || !current.retainUntil) return
  if (now >= current.retainUntil.getTime()) return

  const extending = next !== null &&
    next.mode === current.retentionMode &&
    next.retainUntil.getTime() >= current.retainUntil.getTime()
  if (extending) return

  if (current.retentionMode === 'GOVERNANCE' && bypassGovernance) return
  throw new S3Error('AccessDenied',
    `Retention under ${current.retentionMode} may only be extended until ${current.retainUntil.toISOString()}`)
}
