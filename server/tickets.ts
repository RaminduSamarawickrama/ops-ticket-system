import { randomUUID } from 'node:crypto';
import type { Priority, TicketStatus } from '../shared/constants.js';
import type { TicketInput } from '../shared/validation.js';
import { withTransaction, type Queryable } from './db.js';
import type { Deps } from './deps.js';
import { HttpError } from './http.js';
import { extensionFor, type ImageType } from './images.js';
import { deliverNotification, queueNotification, type DeliveryOutcome } from './notifications.js';

export interface UploadedImage {
  bytes: Uint8Array;
  contentType: ImageType;
  originalName: string;
}

export function formatReference(year: number, n: number): string {
  return `OPS-${year}-${String(n).padStart(5, '0')}`;
}

/**
 * Atomically take the next number for this year. The row lock on the counter serialises
 * concurrent submissions, and the UNIQUE constraint on tickets.reference is a second safety net.
 */
async function nextReference(client: Queryable): Promise<string> {
  const res = await client.query<{ year: number; last_value: number }>(
    `INSERT INTO ticket_counters (year, last_value)
     VALUES (EXTRACT(YEAR FROM now() AT TIME ZONE 'UTC')::int, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = ticket_counters.last_value + 1
     RETURNING year, last_value`,
  );
  return formatReference(res.rows[0].year, res.rows[0].last_value);
}

export interface CreateTicketResult {
  id: string;
  reference: string;
  duplicate: boolean;
  notifications: DeliveryOutcome[];
}

export async function createTicket(
  deps: Deps,
  input: TicketInput,
  files: UploadedImage[],
  submissionId: string | null,
): Promise<CreateTicketResult> {
  const { db, storage, config } = deps;

  // A repeated submission (double click, network retry) returns the ticket that already exists.
  if (submissionId) {
    const existing = await db.query<{ id: string; reference: string }>(
      'SELECT id, reference FROM tickets WHERE submission_id = $1',
      [submissionId],
    );
    if (existing.rows[0]) return { ...existing.rows[0], duplicate: true, notifications: [] };
  }

  const ticketId = randomUUID();
  // Storage keys are generated here; the uploaded filename is only kept for display.
  const stored = files.map((f) => ({
    ...f,
    key: `tickets/${ticketId}/${randomUUID()}.${extensionFor(f.contentType)}`,
  }));

  // Upload screenshots first. If saving the ticket fails afterwards, they are deleted again.
  try {
    await Promise.all(stored.map((f) => storage.put(f.key, f.bytes, f.contentType)));
  } catch (err) {
    console.error('Screenshot upload failed:', err);
    await storage.delete(stored.map((f) => f.key)).catch(() => {});
    throw new HttpError(502, 'We could not store your screenshots. Please try again, or submit without them.');
  }

  let created: { reference: string; notificationIds: string[] } | null;
  try {
    created = await withTransaction(db, async (client) => {
      const reference = await nextReference(client);
      const inserted = await client.query(
        `INSERT INTO tickets (id, reference, submission_id, subject, priority, reporter_email, description,
                              incident_date, incident_time, affected_system)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (submission_id) DO NOTHING RETURNING id`,
        [
          ticketId,
          reference,
          submissionId,
          input.subject,
          input.priority,
          input.reporterEmail,
          input.description,
          input.incidentDate,
          input.incidentTime,
          input.affectedSystem,
        ],
      );
      if (inserted.rowCount === 0) {
        // A concurrent identical submission won the race. Undo this transaction.
        throw new DuplicateSubmission();
      }
      for (const f of stored) {
        await client.query(
          `INSERT INTO attachments (ticket_id, storage_key, original_name, content_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5)`,
          [ticketId, f.key, f.originalName, f.contentType, f.bytes.byteLength],
        );
      }
      await client.query(
        `INSERT INTO ticket_events (ticket_id, event_type, to_status, detail) VALUES ($1, 'CREATED', 'OPEN', $2)`,
        [ticketId, `Submitted by ${input.reporterEmail}`],
      );
      const opsId = await queueNotification(client, ticketId, 'OPS_NEW_TICKET', 0, config.opsRecipients);
      const reporterId = await queueNotification(client, ticketId, 'REPORTER_CREATED', 0, [input.reporterEmail]);
      return { reference, notificationIds: [opsId, reporterId].filter((x): x is string => !!x) };
    });
  } catch (err) {
    await storage.delete(stored.map((f) => f.key)).catch(() => {});
    if (err instanceof DuplicateSubmission && submissionId) {
      const existing = await db.query<{ id: string; reference: string }>(
        'SELECT id, reference FROM tickets WHERE submission_id = $1',
        [submissionId],
      );
      if (existing.rows[0]) return { ...existing.rows[0], duplicate: true, notifications: [] };
    }
    throw err;
  }

  // The ticket is saved. Emails are attempted now; failures are recorded, not thrown.
  const outcomes = await Promise.all(created.notificationIds.map((id) => deliverNotification(deps, id)));
  return {
    id: ticketId,
    reference: created.reference,
    duplicate: false,
    notifications: outcomes.filter((o): o is DeliveryOutcome => !!o),
  };
}

class DuplicateSubmission extends Error {}

// ---------------------------------------------------------------------------------------------
// Admin queries

export interface TicketListFilters {
  q?: string;
  priority?: Priority;
  status?: TicketStatus;
  sort?: 'default' | 'newest' | 'oldest' | 'priority';
  page?: number;
  pageSize?: number;
}

const SORTS: Record<NonNullable<TicketListFilters['sort']>, string> = {
  // Unresolved first, then P1 before P2 before P3, then newest first.
  default: `(t.status = 'DONE') ASC, t.priority ASC, t.created_at DESC`,
  newest: 't.created_at DESC',
  oldest: 't.created_at ASC',
  priority: 't.priority ASC, t.created_at DESC',
};

export async function listTickets(db: Queryable, f: TicketListFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    where.push(
      `(t.reference ILIKE ${p} OR t.subject ILIKE ${p} OR t.reporter_email ILIKE ${p} OR t.affected_system ILIKE ${p})`,
    );
  }
  if (f.priority) {
    params.push(f.priority);
    where.push(`t.priority = $${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`t.status = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 100);
  const page = Math.max(f.page ?? 1, 1);

  const total = await db.query<{ count: string }>(`SELECT count(*) FROM tickets t ${whereSql}`, params);
  const rows = await db.query(
    `SELECT t.id, t.reference, t.subject, t.priority, t.reporter_email, t.affected_system,
            t.incident_date, t.incident_time, t.created_at, t.status, t.resolved_at,
            EXISTS (SELECT 1 FROM notifications n WHERE n.ticket_id = t.id AND n.status IN ('FAILED', 'SKIPPED'))
              AS has_notification_problem
     FROM tickets t ${whereSql}
     ORDER BY ${SORTS[f.sort ?? 'default']}
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  return {
    tickets: rows.rows.map(rowToListItem),
    page,
    pageSize,
    total: Number(total.rows[0].count),
  };
}

function rowToListItem(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    reference: r.reference as string,
    subject: r.subject as string,
    priority: r.priority as Priority,
    reporterEmail: r.reporter_email as string,
    affectedSystem: r.affected_system as string,
    incidentDate: r.incident_date as string,
    incidentTime: (r.incident_time as string).slice(0, 5),
    createdAt: (r.created_at as Date).toISOString(),
    status: r.status as TicketStatus,
    resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
    hasNotificationProblem: r.has_notification_problem as boolean,
  };
}

export async function getSummary(db: Queryable) {
  const res = await db.query<{
    total: string;
    open: string;
    working: string;
    done: string;
    open_p1: string;
    notification_problems: string;
  }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status = 'OPEN') AS open,
            count(*) FILTER (WHERE status = 'WORKING') AS working,
            count(*) FILTER (WHERE status = 'DONE') AS done,
            count(*) FILTER (WHERE priority = 'P1' AND status <> 'DONE') AS open_p1,
            (SELECT count(DISTINCT ticket_id) FROM notifications WHERE status IN ('FAILED', 'SKIPPED')) AS notification_problems
     FROM tickets`,
  );
  const r = res.rows[0];
  return {
    total: Number(r.total),
    open: Number(r.open),
    working: Number(r.working),
    done: Number(r.done),
    openP1: Number(r.open_p1),
    ticketsWithNotificationProblems: Number(r.notification_problems),
  };
}

export async function getTicketDetail(db: Queryable, id: string) {
  const t = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
  const r = t.rows[0];
  if (!r) return null;
  const [attachments, notifications, events] = await Promise.all([
    db.query(
      'SELECT id, original_name, content_type, size_bytes, created_at FROM attachments WHERE ticket_id = $1 ORDER BY created_at, id',
      [id],
    ),
    db.query(
      `SELECT id, kind, cycle, recipients, status, last_error, attempts, provider_message_id, updated_at
       FROM notifications WHERE ticket_id = $1 ORDER BY created_at, kind`,
      [id],
    ),
    db.query(
      `SELECT id, event_type, from_status, to_status, admin_username, detail, created_at
       FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id`,
      [id],
    ),
  ]);
  return {
    id: r.id as string,
    reference: r.reference as string,
    subject: r.subject as string,
    priority: r.priority as Priority,
    reporterEmail: r.reporter_email as string,
    description: r.description as string,
    incidentDate: r.incident_date as string,
    incidentTime: (r.incident_time as string).slice(0, 5),
    affectedSystem: r.affected_system as string,
    status: r.status as TicketStatus,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
    resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
    attachments: attachments.rows.map((a) => ({
      id: a.id as string,
      name: a.original_name as string,
      contentType: a.content_type as string,
      sizeBytes: a.size_bytes as number,
      url: `/api/admin/attachments/${a.id}`,
    })),
    notifications: notifications.rows.map((n) => ({
      id: n.id as string,
      kind: n.kind as string,
      cycle: n.cycle as number,
      recipients: n.recipients as string[],
      status: n.status as string,
      lastError: (n.last_error as string | null) ?? null,
      attempts: n.attempts as number,
      providerMessageId: (n.provider_message_id as string | null) ?? null,
      updatedAt: (n.updated_at as Date).toISOString(),
    })),
    events: events.rows.map((e) => ({
      id: String(e.id),
      type: e.event_type as string,
      fromStatus: (e.from_status as string | null) ?? null,
      toStatus: (e.to_status as string | null) ?? null,
      adminUsername: (e.admin_username as string | null) ?? null,
      detail: (e.detail as string | null) ?? null,
      createdAt: (e.created_at as Date).toISOString(),
    })),
  };
}

export interface StatusChangeResult {
  changed: boolean;
  status: TicketStatus;
  notification: DeliveryOutcome | null;
}

/**
 * Change a ticket's status. Saving the same status again is a no-op, so it can never send a second
 * resolution email. Moving to Done records the resolution, starts a new "resolution cycle", and
 * queues exactly one resolution email for that cycle.
 */
export async function changeStatus(
  deps: Deps,
  ticketId: string,
  newStatus: TicketStatus,
  admin: { adminId: string; username: string },
): Promise<StatusChangeResult> {
  const result = await withTransaction(deps.db, async (client) => {
    const cur = await client.query<{ status: TicketStatus; resolution_count: number; reporter_email: string }>(
      'SELECT status, resolution_count, reporter_email FROM tickets WHERE id = $1 FOR UPDATE',
      [ticketId],
    );
    const t = cur.rows[0];
    if (!t) throw new HttpError(404, 'Ticket not found.');
    if (t.status === newStatus) return { changed: false, notificationId: null as string | null };

    const resolving = newStatus === 'DONE';
    const reopening = t.status === 'DONE';
    const cycle = resolving ? t.resolution_count + 1 : t.resolution_count;
    await client.query(
      `UPDATE tickets SET status = $2, updated_at = now(), resolution_count = $3,
              resolved_at = CASE WHEN $2 = 'DONE' THEN now() ELSE NULL END
       WHERE id = $1`,
      [ticketId, newStatus, cycle],
    );
    const eventType = resolving ? 'RESOLVED' : reopening ? 'REOPENED' : 'STATUS_CHANGED';
    await client.query(
      `INSERT INTO ticket_events (ticket_id, event_type, from_status, to_status, admin_id, admin_username)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ticketId, eventType, t.status, newStatus, admin.adminId, admin.username],
    );
    const notificationId = resolving
      ? await queueNotification(client, ticketId, 'REPORTER_RESOLVED', cycle, [t.reporter_email])
      : null;
    return { changed: true, notificationId };
  });

  const notification = result.notificationId ? await deliverNotification(deps, result.notificationId) : null;
  return { changed: result.changed, status: newStatus, notification };
}
