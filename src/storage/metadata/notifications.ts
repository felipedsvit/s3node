import type { DatabaseSync } from 'node:sqlite'
import type { NotificationQueueRow } from './types.js'

interface NotificationStatements {
  enqueueNotification: ReturnType<DatabaseSync['prepare']>
  claimDueNotifications: ReturnType<DatabaseSync['prepare']>
  rescheduleNotification: ReturnType<DatabaseSync['prepare']>
  deadLetterNotification: ReturnType<DatabaseSync['prepare']>
  deleteNotification: ReturnType<DatabaseSync['prepare']>
}

/** The durable delivery queue backing `NotificationDispatcher`. */
export class NotificationMetadata {
  private statements: NotificationStatements

  constructor(db: DatabaseSync) {
    this.statements = {
      enqueueNotification: db.prepare(
        'INSERT INTO notification_queue (bucket, target_id, endpoint, payload, attempts, next_attempt_at, status, created_at) ' +
        "VALUES (?, ?, ?, ?, 0, ?, 'pending', ?)"),
      // Atomically flips due rows to 'in-flight' and returns them in one step, so the
      // periodic worker and an explicit drain() can never both pick up the same row.
      claimDueNotifications: db.prepare(
        "UPDATE notification_queue SET status = 'in-flight' WHERE id IN (" +
        "  SELECT id FROM notification_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?" +
        ') RETURNING id, bucket, target_id, endpoint, payload, attempts'),
      rescheduleNotification: db.prepare(
        "UPDATE notification_queue SET status = 'pending', attempts = ?, next_attempt_at = ? WHERE id = ?"),
      deadLetterNotification: db.prepare("UPDATE notification_queue SET status = 'dead', attempts = ? WHERE id = ?"),
      deleteNotification: db.prepare('DELETE FROM notification_queue WHERE id = ?'),
    }
  }

  enqueueNotification({ bucket, targetId, endpoint, payload, now }: {
    bucket: string; targetId: string; endpoint: string; payload: string; now: number
  }): void {
    this.statements.enqueueNotification.run(bucket, targetId, endpoint, payload, now, now)
  }

  /** Claims up to `limit` due rows for delivery, marking them 'in-flight' so no other caller can also pick them up. */
  claimDueNotifications(now: number, limit = 100): NotificationQueueRow[] {
    return this.statements.claimDueNotifications.all(now, limit) as unknown as NotificationQueueRow[]
  }

  rescheduleNotification(id: number, attempts: number, nextAttemptAt: number): void {
    this.statements.rescheduleNotification.run(attempts, nextAttemptAt, id)
  }

  deadLetterNotification(id: number, attempts: number): void {
    this.statements.deadLetterNotification.run(attempts, id)
  }

  deleteNotification(id: number): void {
    this.statements.deleteNotification.run(id)
  }
}
