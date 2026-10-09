import type { NotificationKind, Priority, TicketStatus } from '../shared/constants.js';
import type { Queryable } from './db.js';
import type { Deps } from './deps.js';
import {
  opsNewTicketEmail,
  reporterCreatedEmail,
  reporterResolvedEmail,
  type EmailContent,
  type TicketForEmail,
} from './emailTemplates.js';

/**
 * Record that an email should be sent. Returns the notification id, or null if one already exists
 * for this ticket/kind/cycle (which is how duplicate resolution emails are prevented).
 */
export async function queueNotification(
  db: Queryable,
  ticketId: string,
  kind: NotificationKind,
  cycle: number,
  recipients: string[],
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO notifications (ticket_id, kind, cycle, recipients) VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticket_id, kind, cycle) DO NOTHING RETURNING id`,
    [ticketId, kind, cycle, recipients],
  );
  return res.rows[0]?.id ?? null;
}

interface TicketRow {
  id: string;
  reference: string;
  subject: string;
  priority: Priority;
  reporter_email: string;
  description: string;
  incident_date: string;
  incident_time: string;
  affected_system: string;
  status: TicketStatus;
  created_at: Date;
  resolved_at: Date | null;
}

function toEmailTicket(r: TicketRow): TicketForEmail {
  return {
    id: r.id,
    reference: r.reference,
    subject: r.subject,
    priority: r.priority,
    reporterEmail: r.reporter_email,
    description: r.description,
    incidentDate: r.incident_date,
    incidentTime: r.incident_time,
    affectedSystem: r.affected_system,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

function buildContent(deps: Deps, kind: NotificationKind, ticket: TicketForEmail): EmailContent {
  const { timeZone, appBaseUrl } = deps.config;
  switch (kind) {
    case 'OPS_NEW_TICKET':
      return opsNewTicketEmail(ticket, {
        timeZone,
        dashboardUrl: appBaseUrl ? `${appBaseUrl}/admin/tickets/${ticket.id}` : null,
      });
    case 'REPORTER_CREATED':
      return reporterCreatedEmail(ticket, { timeZone });
    case 'REPORTER_RESOLVED':
      return reporterResolvedEmail(ticket, { timeZone });
  }
}

export interface DeliveryOutcome {
  id: string;
  kind: NotificationKind;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string;
}

/**
 * Try to send one queued notification and record the outcome. Never throws: an email problem must
 * not undo a saved ticket or status change.
 *
 * `mode: 'retry'` re-sends a FAILED/SKIPPED notification (or one stuck in PENDING for 5+ minutes).
 */
export async function deliverNotification(
  deps: Deps,
  notificationId: string,
  mode: 'initial' | 'retry' = 'initial',
  actor?: { adminId: string; username: string },
): Promise<DeliveryOutcome | null> {
  const { db, config } = deps;
  try {
    // Claim the row so two concurrent requests can't both send it.
    const claimSql =
      mode === 'initial'
        ? `UPDATE notifications SET attempts = attempts + 1, updated_at = now()
           WHERE id = $1 AND status = 'PENDING' AND attempts = 0 RETURNING *`
        : `UPDATE notifications SET status = 'PENDING', attempts = attempts + 1, updated_at = now(),
             recipients = CASE WHEN kind = 'OPS_NEW_TICKET' THEN $2::text[] ELSE recipients END
           WHERE id = $1 AND (status IN ('FAILED', 'SKIPPED')
             OR (status = 'PENDING' AND updated_at < now() - interval '5 minutes'))
           RETURNING *`;
    const claimParams = mode === 'initial' ? [notificationId] : [notificationId, config.opsRecipients];
    const claimed = await db.query<{
      id: string;
      ticket_id: string;
      kind: NotificationKind;
      recipients: string[];
      attempts: number;
    }>(claimSql, claimParams);
    const n = claimed.rows[0];
    if (!n) return null;

    if (mode === 'retry') {
      await db.query(
        `INSERT INTO ticket_events (ticket_id, event_type, admin_id, admin_username, detail)
         VALUES ($1, 'NOTIFICATION_RETRIED', $2, $3, $4)`,
        [n.ticket_id, actor?.adminId ?? null, actor?.username ?? null, `Retrying ${n.kind} (attempt ${n.attempts})`],
      );
    }

    const finish = async (status: 'SENT' | 'FAILED' | 'SKIPPED', error: string | null, messageId: string | null) => {
      await db.query(
        `UPDATE notifications SET status = $2, last_error = $3, provider_message_id = $4, updated_at = now() WHERE id = $1`,
        [n.id, status, error, messageId],
      );
      if (status !== 'SENT') {
        await db.query(
          `INSERT INTO ticket_events (ticket_id, event_type, detail) VALUES ($1, 'NOTIFICATION_FAILED', $2)`,
          [n.ticket_id, `${n.kind}: ${error}`],
        );
      }
      return { id: n.id, kind: n.kind, status, ...(error ? { error } : {}) } as DeliveryOutcome;
    };

    if (n.recipients.length === 0) {
      return finish(
        'SKIPPED',
        n.kind === 'OPS_NEW_TICKET'
          ? 'No operations recipients configured (set OPERATIONS_NOTIFICATION_EMAIL).'
          : 'No recipient address.',
        null,
      );
    }

    const t = await db.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [n.ticket_id]);
    if (!t.rows[0]) return finish('FAILED', 'Ticket no longer exists.', null);

    const content = buildContent(deps, n.kind, toEmailTicket(t.rows[0]));
    const result = await deps.mailer.send({
      to: n.recipients,
      ...content,
      idempotencyKey: `${n.id}-${n.attempts}`,
    });
    return result.ok ? finish('SENT', null, result.providerMessageId) : finish('FAILED', result.error.slice(0, 500), null);
  } catch (err) {
    console.error(`Notification ${notificationId} could not be processed:`, err);
    await db
      .query(
        `UPDATE notifications SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
        [notificationId, 'Internal error while sending'],
      )
      .catch(() => {});
    return null;
  }
}
