import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { NOTIFICATION_KIND_LABEL, PRIORITY_INFO, STATUS_INFO, type TicketStatus } from '../../shared/constants';
import { ApiError, apiGet, apiSend, type StatusChangeResult, type TicketDetail as Ticket } from '../api';
import { useAdmin } from '../components/AdminShell';
import { NotificationBadge, PriorityBadge, StatusBadge } from '../components/Badges';
import { Alert, Spinner } from '../components/Layout';
import { StatusSelect, confirmStatusChange } from '../components/StatusSelect';
import { formatBytes, formatDateTime, formatIncident } from '../format';

const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Ticket created',
  STATUS_CHANGED: 'Status changed',
  RESOLVED: 'Resolved',
  REOPENED: 'Reopened',
  NOTIFICATION_FAILED: 'Email not sent',
  NOTIFICATION_RETRIED: 'Email retry',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const { onUnauthorized } = useAdmin();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'warning'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    try {
      setTicket(await apiGet<Ticket>(`/admin/tickets/${id}`));
      setError(null);
    } catch (err) {
      handleError(err);
    }
  }, [id, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeStatus(to: TicketStatus) {
    if (!ticket || to === ticket.status || !confirmStatusChange(ticket.status, to, ticket.reference)) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await apiSend<StatusChangeResult>('PATCH', `/admin/tickets/${ticket.id}/status`, { status: to });
      if (r.notification && r.notification.status !== 'SENT') {
        setNotice({
          kind: 'warning',
          text: `Status saved as ${STATUS_INFO[to].label}, but the resolution email was not sent: ${r.notification.error ?? 'unknown error'}. You can retry below.`,
        });
      } else {
        setNotice({
          kind: 'success',
          text: `Status saved as ${STATUS_INFO[to].label}.${r.notification ? ' The reporter has been emailed.' : ''}`,
        });
      }
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  }

  async function retry(notificationId: string) {
    setRetrying(notificationId);
    setNotice(null);
    try {
      const r = await apiSend<{ status: string; error?: string }>('POST', `/admin/notifications/${notificationId}/retry`);
      setNotice(
        r.status === 'SENT'
          ? { kind: 'success', text: 'Email accepted by the email provider.' }
          : { kind: 'warning', text: `Email still not sent: ${r.error ?? 'unknown error'}` },
      );
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setRetrying(null);
    }
  }

  if (error && !ticket) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <Link to="/admin" className="text-sm text-slate-600 hover:text-ink">
          ← Back to tickets
        </Link>
        <Alert kind="error">{error}</Alert>
      </main>
    );
  }
  if (!ticket) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10 text-center">
        <Spinner label="Loading ticket" />
      </main>
    );
  }

  const p = PRIORITY_INFO[ticket.priority];

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <Link to="/admin" className="text-sm text-slate-600 hover:text-ink">
        ← Back to tickets
      </Link>

      {ticket.priority === 'P1' && ticket.status !== 'DONE' && (
        <div className="rounded-md px-4 py-3 font-semibold text-white" style={{ backgroundColor: p.color }} role="status">
          ⚠ P1 Emergency: this ticket needs immediate action.
        </div>
      )}
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      <div className="card overflow-hidden">
        <div className="h-1.5" style={{ backgroundColor: p.color }} />
        <div className="flex flex-wrap items-start justify-between gap-4 p-6">
          <div className="min-w-0">
            <p className="font-mono text-sm font-semibold text-slate-500">{ticket.reference}</p>
            <h1 className="mt-1 break-words text-2xl font-semibold">{ticket.subject}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <PriorityBadge priority={ticket.priority} />
              <StatusBadge status={ticket.status} />
            </div>
          </div>
          <div>
            <label htmlFor="status" className="label">
              Change status
            </label>
            <StatusSelect id="status" label="Change status" value={ticket.status} disabled={saving} onChange={changeStatus} />
          </div>
        </div>

        <dl className="grid gap-5 border-t border-slate-100 p-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Reporter email">
            <a href={`mailto:${ticket.reporterEmail}`} className="text-blue-700 hover:underline">
              {ticket.reporterEmail}
            </a>
          </Field>
          <Field label="Affected system">{ticket.affectedSystem}</Field>
          <Field label="Incident date & time">{formatIncident(ticket.incidentDate, ticket.incidentTime)}</Field>
          <Field label="Submitted">{formatDateTime(ticket.createdAt)}</Field>
          <Field label="Last updated">{formatDateTime(ticket.updatedAt)}</Field>
          <Field label="Resolved">{ticket.resolvedAt ? formatDateTime(ticket.resolvedAt) : '—'}</Field>
        </dl>

        <div className="border-t border-slate-100 p-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">Incident description</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{ticket.description}</p>
        </div>
      </div>

      <section className="card p-6">
        <h2 className="font-semibold">Screenshots ({ticket.attachments.length})</h2>
        {ticket.attachments.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No screenshots were attached.</p>
        ) : (
          <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ticket.attachments.map((a) => (
              <li key={a.id} className="overflow-hidden rounded-md border border-slate-200">
                <button type="button" className="block w-full bg-slate-50" onClick={() => setPreview(a.url)} aria-label={`View ${a.name}`}>
                  <img src={a.url} alt={a.name} loading="lazy" className="h-44 w-full object-contain" />
                </button>
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="truncate" title={a.name}>
                    {a.name}
                  </span>
                  <span className="shrink-0 text-slate-500">{formatBytes(a.sizeBytes)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-6">
        <h2 className="font-semibold">Email notifications</h2>
        <p className="mt-1 text-xs text-slate-500">
          "Accepted by email provider" means the provider took the message for delivery; it does not confirm it reached the inbox.
        </p>
        <ul className="mt-3 divide-y divide-slate-100">
          {ticket.notifications.map((n) => (
            <li key={n.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {NOTIFICATION_KIND_LABEL[n.kind]}
                  {n.kind === 'REPORTER_RESOLVED' && n.cycle > 1 ? ` (resolution #${n.cycle})` : ''}
                </p>
                <p className="break-all text-xs text-slate-500">
                  To: {n.recipients.length ? n.recipients.join(', ') : 'no recipients configured'} · Attempts: {n.attempts} · {formatDateTime(n.updatedAt)}
                </p>
                {n.lastError && n.status !== 'SENT' && <p className="mt-1 text-xs text-red-700">{n.lastError}</p>}
              </div>
              <div className="flex items-center gap-2">
                <NotificationBadge status={n.status} />
                {(n.status === 'FAILED' || n.status === 'SKIPPED') && (
                  <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={retrying === n.id} onClick={() => retry(n.id)}>
                    {retrying === n.id ? 'Retrying…' : 'Retry'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-6">
        <h2 className="font-semibold">History</h2>
        <ol className="mt-3 space-y-3 border-l-2 border-slate-200 pl-4">
          {ticket.events.map((e) => (
            <li key={e.id} className="text-sm">
              <p className="font-medium">
                {EVENT_LABEL[e.type] ?? e.type}
                {e.fromStatus && e.toStatus && (
                  <span className="font-normal text-slate-600">
                    {' '}
                    {STATUS_INFO[e.fromStatus].label} → {STATUS_INFO[e.toStatus].label}
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-500">
                {formatDateTime(e.createdAt)}
                {e.adminUsername && ` · by ${e.adminUsername}`}
                {e.detail && ` · ${e.detail}`}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
          onKeyDown={(e) => e.key === 'Escape' && setPreview(null)}
        >
          <img src={preview} alt="Screenshot" className="max-h-full max-w-full rounded" />
          <button type="button" autoFocus className="btn-secondary absolute right-4 top-4" onClick={() => setPreview(null)}>
            Close
          </button>
        </div>
      )}
    </main>
  );
}
