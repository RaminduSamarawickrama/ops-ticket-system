import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PRIORITIES, PRIORITY_INFO, STATUSES, STATUS_INFO, type TicketStatus } from '../../shared/constants';
import { ApiError, apiGet, apiSend, type StatusChangeResult, type Summary, type TicketList, type TicketListItem } from '../api';
import { useAdmin } from '../components/AdminShell';
import { PriorityBadge } from '../components/Badges';
import { Alert, Spinner } from '../components/Layout';
import { StatusSelect, confirmStatusChange } from '../components/StatusSelect';
import { formatDateTime, formatIncident } from '../format';

function SummaryCard({ label, value, accent, to }: { label: string; value: number | undefined; accent?: string; to: string }) {
  return (
    <Link to={to} className="card block p-4 hover:border-slate-300">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-bold" style={accent ? { color: accent } : undefined}>
        {value ?? '–'}
      </p>
    </Link>
  );
}

export default function AdminDashboard() {
  const { onUnauthorized } = useAdmin();
  const [params, setParams] = useSearchParams();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [list, setList] = useState<TicketList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'warning'; text: string } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('q') ?? '');

  const q = params.get('q') ?? '';
  const priority = params.get('priority') ?? '';
  const status = params.get('status') ?? '';
  const sort = params.get('sort') ?? 'default';
  const page = Number(params.get('page') ?? '1') || 1;

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && !(key === 'sort' && value === 'default')) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ q, priority, status, sort, page: String(page) });
    for (const [k, v] of [...qs]) if (!v) qs.delete(k);
    try {
      const [s, l] = await Promise.all([apiGet<Summary>('/admin/summary'), apiGet<TicketList>(`/admin/tickets?${qs}`)]);
      setSummary(s);
      setList(l);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [q, priority, status, sort, page, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce typing in the search box.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => updateParam('q', search.trim()), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function changeStatus(t: TicketListItem, to: TicketStatus) {
    if (to === t.status || !confirmStatusChange(t.status, to, t.reference)) return;
    setSavingId(t.id);
    setNotice(null);
    try {
      const r = await apiSend<StatusChangeResult>('PATCH', `/admin/tickets/${t.id}/status`, { status: to });
      if (r.notification && r.notification.status !== 'SENT') {
        setNotice({
          kind: 'warning',
          text: `${t.reference} is now ${STATUS_INFO[to].label}, but the resolution email was not sent (${r.notification.error ?? 'unknown error'}). Open the ticket to retry.`,
        });
      } else {
        setNotice({
          kind: 'success',
          text: `${t.reference} is now ${STATUS_INFO[to].label}.${r.notification ? ' The reporter has been emailed.' : ''}`,
        });
      }
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setSavingId(null);
    }
  }

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const filtered = q || priority || status;

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-semibold">Tickets</h1>
        <button type="button" className="btn-secondary px-3 py-1.5" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {summary?.configWarnings.map((w) => (
        <Alert key={w} kind="warning">
          <strong>Configuration: </strong>
          {w}
        </Alert>
      ))}
      {summary && summary.ticketsWithNotificationProblems > 0 && (
        <Alert kind="warning">
          {summary.ticketsWithNotificationProblems} ticket(s) have emails that failed or were not sent. They are marked
          with ⚠ below; open a ticket to see the error and retry.
        </Alert>
      )}
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Summary">
        <SummaryCard label="Total tickets" value={summary?.total} to="/admin" />
        <SummaryCard label="Open" value={summary?.open} accent={STATUS_INFO.OPEN.color} to="/admin?status=OPEN" />
        <SummaryCard label="Working" value={summary?.working} accent={STATUS_INFO.WORKING.color} to="/admin?status=WORKING" />
        <SummaryCard label="Done" value={summary?.done} accent={STATUS_INFO.DONE.color} to="/admin?status=DONE" />
        <Link
          to="/admin?priority=P1"
          className={`card block p-4 ${summary && summary.openP1 > 0 ? 'border-red-300 bg-red-50' : 'hover:border-slate-300'}`}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-red-700">Open P1 emergencies</p>
          <p className="mt-1 text-3xl font-bold text-red-600">{summary?.openP1 ?? '–'}</p>
        </Link>
      </section>

      <section className="card">
        <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <div>
            <label htmlFor="search" className="sr-only">
              Search
            </label>
            <input
              id="search"
              type="search"
              className="input"
              placeholder="Search reference, subject, email or system"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select aria-label="Filter by priority" className="input" value={priority} onChange={(e) => updateParam('priority', e.target.value)}>
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_INFO[p].label}
              </option>
            ))}
          </select>
          <select aria-label="Filter by status" className="input" value={status} onChange={(e) => updateParam('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_INFO[s].label}
              </option>
            ))}
          </select>
          <select aria-label="Sort" className="input" value={sort} onChange={(e) => updateParam('sort', e.target.value)}>
            <option value="default">Unresolved &amp; urgent first</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="priority">Priority (P1 first)</option>
          </select>
        </div>

        {loading && !list ? (
          <div className="p-8 text-center">
            <Spinner label="Loading tickets" />
          </div>
        ) : list && list.tickets.length === 0 ? (
          <div className="p-10 text-center text-slate-600">
            {filtered ? 'No tickets match these filters.' : 'No tickets yet. New submissions will appear here.'}
          </div>
        ) : (
          list && (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Reference</th>
                    <th className="px-4 py-3 font-medium">Subject</th>
                    <th className="px-4 py-3 font-medium">Priority</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Reporter</th>
                    <th className="px-4 py-3 font-medium">System</th>
                    <th className="px-4 py-3 font-medium">Incident</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-100 ${loading ? 'opacity-60' : ''}`}>
                  {list.tickets.map((t) => {
                    const urgent = t.priority === 'P1' && t.status !== 'DONE';
                    return (
                      <tr key={t.id} className={urgent ? 'bg-red-50/70' : 'hover:bg-slate-50'}>
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-semibold">
                          <span className={urgent ? 'border-l-4 border-red-600 pl-2' : ''}>{t.reference}</span>
                        </td>
                        <td className="min-w-[12rem] max-w-xs px-4 py-3">
                          <Link to={`/admin/tickets/${t.id}`} className="line-clamp-2 font-medium hover:underline">
                            {t.subject}
                          </Link>
                          {t.hasNotificationProblem && (
                            <span className="mt-0.5 block text-xs text-amber-700" title="An email for this ticket failed or was not sent">
                              ⚠ Email problem
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <PriorityBadge priority={t.priority} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusSelect
                            label={`Status of ${t.reference}`}
                            value={t.status}
                            disabled={savingId === t.id}
                            onChange={(s) => changeStatus(t, s)}
                          />
                        </td>
                        <td className="max-w-[12rem] truncate px-4 py-3 text-slate-700" title={t.reporterEmail}>
                          {t.reporterEmail}
                        </td>
                        <td className="max-w-[10rem] truncate px-4 py-3 text-slate-700" title={t.affectedSystem}>
                          {t.affectedSystem}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatIncident(t.incidentDate, t.incidentTime)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatDateTime(t.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <Link to={`/admin/tickets/${t.id}`} className="btn-secondary px-3 py-1 text-xs">
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {list && list.total > list.pageSize && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-600">
              Page {page} of {totalPages} · {list.total} tickets
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary px-3 py-1" disabled={page <= 1} onClick={() => updateParam('page', String(page - 1))}>
                Previous
              </button>
              <button
                type="button"
                className="btn-secondary px-3 py-1"
                disabled={page >= totalPages}
                onClick={() => updateParam('page', String(page + 1))}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
