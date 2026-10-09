import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, BASE, PNG_BYTES, jsonRequest, login, setup, submitRequest, validFields } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  if (ctx) await ctx.db.end();
  ctx = await setup();
});
afterAll(async () => {
  await ctx?.db.end();
});

async function createTicket(overrides: Record<string, string> = {}, files: Parameters<typeof submitRequest>[1] = []) {
  const res = await ctx.handle(submitRequest(validFields(overrides), files));
  const { reference } = await res.json();
  const row = (await ctx.db.query('SELECT id FROM tickets WHERE reference = $1', [reference])).rows[0];
  return { id: row.id as string, reference: reference as string };
}

const setStatus = (id: string, status: string, cookie: string) =>
  ctx.handle(jsonRequest('PATCH', `/admin/tickets/${id}/status`, { status }, cookie));

describe('authentication and authorization', () => {
  it('refuses every admin endpoint without a session', async () => {
    const t = await createTicket({}, [{ bytes: PNG_BYTES, name: 'a.png' }]);
    const att = (await ctx.db.query('SELECT id FROM attachments')).rows[0].id;
    const notif = (await ctx.db.query('SELECT id FROM notifications LIMIT 1')).rows[0].id;
    const attempts = [
      jsonRequest('GET', '/admin/summary'),
      jsonRequest('GET', '/admin/tickets'),
      jsonRequest('GET', `/admin/tickets/${t.id}`),
      jsonRequest('PATCH', `/admin/tickets/${t.id}/status`, { status: 'DONE' }),
      jsonRequest('POST', `/admin/notifications/${notif}/retry`, {}),
      jsonRequest('GET', `/admin/attachments/${att}`),
      jsonRequest('GET', '/admin/tickets', undefined, 'ops_session=forged-token'),
    ];
    for (const req of attempts) {
      expect((await ctx.handle(req)).status, req.url).toBe(401);
    }
    expect((await ctx.db.query('SELECT status FROM tickets')).rows[0].status).toBe('OPEN');
  });

  it('logs in with a secure HttpOnly session cookie and logs out', async () => {
    const res = await ctx.handle(jsonRequest('POST', '/auth/login', ADMIN));
    expect(res.status).toBe(200);
    const cookieHeader = res.headers.get('set-cookie')!;
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Lax/);
    expect(cookieHeader).toMatch(/Max-Age=\d+/);
    const cookie = cookieHeader.split(';')[0];

    // Only a hash of the token is stored.
    const stored = (await ctx.db.query('SELECT token_hash FROM sessions')).rows[0].token_hash;
    expect(cookie).not.toContain(stored);

    expect((await ctx.handle(jsonRequest('GET', '/auth/me', undefined, cookie))).status).toBe(200);
    expect((await ctx.handle(jsonRequest('POST', '/auth/logout', {}, cookie))).status).toBe(200);
    expect((await ctx.handle(jsonRequest('GET', '/admin/summary', undefined, cookie))).status).toBe(401);
  });

  it('rejects wrong passwords and locks the username after repeated failures', async () => {
    const wrong = { username: ADMIN.username, password: 'wrong password!!' };
    for (let i = 0; i < 5; i++) {
      expect((await ctx.handle(jsonRequest('POST', '/auth/login', wrong))).status).toBe(401);
    }
    // Even the right password is refused while locked.
    expect((await ctx.handle(jsonRequest('POST', '/auth/login', ADMIN))).status).toBe(429);
  });

  it('does not reveal whether a username exists', async () => {
    const a = await ctx.handle(jsonRequest('POST', '/auth/login', { username: 'nobody', password: 'x' }));
    const b = await ctx.handle(jsonRequest('POST', '/auth/login', { username: ADMIN.username, password: 'x' }));
    expect(a.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });

  it('blocks cross-site state-changing requests', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket();
    const req = new Request(`${BASE}/api/admin/tickets/${t.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, host: 'ops.test', origin: 'https://evil.example' },
      body: JSON.stringify({ status: 'DONE' }),
    });
    expect((await ctx.handle(req)).status).toBe(403);
  });

  it('expires sessions', async () => {
    const cookie = await login(ctx.handle);
    await ctx.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect((await ctx.handle(jsonRequest('GET', '/admin/summary', undefined, cookie))).status).toBe(401);
  });
});

describe('dashboard and ticket management', () => {
  it('lists, searches, filters and sorts tickets with unresolved P1 first', async () => {
    const cookie = await login(ctx.handle);
    const p3 = await createTicket({ priority: 'P3', subject: 'Daily Report Query', affectedSystem: 'Reports' });
    const p1 = await createTicket({ priority: 'P1', subject: 'Payment System Down' });
    const p2 = await createTicket({ priority: 'P2', subject: 'Booking Errors', reporterEmail: 'anna@corp.example' });
    const p1done = await createTicket({ priority: 'P1', subject: 'Old outage' });
    await setStatus(p1done.id, 'DONE', cookie);

    const list = async (qs = '') =>
      (await (await ctx.handle(jsonRequest('GET', `/admin/tickets${qs}`, undefined, cookie))).json()) as {
        tickets: Array<{ reference: string }>;
        total: number;
      };

    expect((await list()).tickets.map((t) => t.reference)).toEqual([p1.reference, p2.reference, p3.reference, p1done.reference]);
    expect((await list('?q=anna@corp')).tickets.map((t) => t.reference)).toEqual([p2.reference]);
    expect((await list(`?q=${p3.reference}`)).total).toBe(1);
    expect((await list('?q=reports')).tickets[0].reference).toBe(p3.reference);
    expect((await list('?priority=P1')).total).toBe(2);
    expect((await list('?status=DONE')).tickets.map((t) => t.reference)).toEqual([p1done.reference]);
    expect((await list('?sort=oldest')).tickets[0].reference).toBe(p3.reference);
    // LIKE wildcards in the search are treated literally.
    expect((await list('?q=%25')).total).toBe(0);

    const summary = await (await ctx.handle(jsonRequest('GET', '/admin/summary', undefined, cookie))).json();
    expect(summary).toMatchObject({ total: 4, open: 3, working: 0, done: 1, openP1: 1 });
  });

  it('serves screenshots only to signed-in admins', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket({}, [{ bytes: PNG_BYTES, name: 'a.png' }]);
    const detail = await (await ctx.handle(jsonRequest('GET', `/admin/tickets/${t.id}`, undefined, cookie))).json();
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0].url).toMatch(/^\/api\/admin\/attachments\//);
    const img = await ctx.handle(jsonRequest('GET', detail.attachments[0].url.replace('/api', ''), undefined, cookie));
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('moves Open → Working → Done, records history, and emails the reporter once', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket({ subject: 'Payment System Down' });
    ctx.mailer.sent.length = 0;

    const r1 = await (await setStatus(t.id, 'WORKING', cookie)).json();
    expect(r1).toMatchObject({ changed: true, status: 'WORKING', notification: null });
    const r2 = await (await setStatus(t.id, 'DONE', cookie)).json();
    expect(r2.changed).toBe(true);
    expect(r2.notification.status).toBe('SENT');

    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0].to).toEqual(['reporter@example.com']);
    expect(ctx.mailer.sent[0].subject).toBe(`[${t.reference}] Resolved - Payment System Down`);

    // Saving Done again changes nothing and sends nothing.
    const r3 = await (await setStatus(t.id, 'DONE', cookie)).json();
    expect(r3).toMatchObject({ changed: false, notification: null });
    expect(ctx.mailer.sent).toHaveLength(1);

    const detail = await (await ctx.handle(jsonRequest('GET', `/admin/tickets/${t.id}`, undefined, cookie))).json();
    expect(detail.status).toBe('DONE');
    expect(detail.resolvedAt).not.toBeNull();
    const history = detail.events.map((e: { type: string; fromStatus: string; toStatus: string; adminUsername: string }) =>
      [e.type, e.fromStatus, e.toStatus, e.adminUsername].join(':'),
    );
    expect(history).toEqual([
      'CREATED::OPEN:',
      `STATUS_CHANGED:OPEN:WORKING:${ADMIN.username}`,
      `RESOLVED:WORKING:DONE:${ADMIN.username}`,
    ]);
  });

  it('sends only one resolution email when two admins mark Done at the same time', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket();
    ctx.mailer.sent.length = 0;
    const results = await Promise.all([setStatus(t.id, 'DONE', cookie), setStatus(t.id, 'DONE', cookie)]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.filter((b) => b.changed)).toHaveLength(1);
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('allows reopening, and a second resolution sends a new email', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket();
    ctx.mailer.sent.length = 0;
    await setStatus(t.id, 'DONE', cookie);
    await setStatus(t.id, 'OPEN', cookie);
    const reopened = (await ctx.db.query('SELECT status, resolved_at FROM tickets')).rows[0];
    expect(reopened).toEqual({ status: 'OPEN', resolved_at: null });
    await setStatus(t.id, 'DONE', cookie);
    expect(ctx.mailer.sent).toHaveLength(2);
    const types = (await ctx.db.query(`SELECT event_type FROM ticket_events ORDER BY id`)).rows.map((r) => r.event_type);
    expect(types).toEqual(['CREATED', 'RESOLVED', 'REOPENED', 'RESOLVED']);
  });

  it('keeps the status change when the resolution email fails, and the email can be retried', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket();
    ctx.mailer.sent.length = 0;
    ctx.mailer.fail('Email provider timed out');
    const r = await (await setStatus(t.id, 'DONE', cookie)).json();
    expect(r.changed).toBe(true);
    expect(r.notification).toMatchObject({ status: 'FAILED', error: 'Email provider timed out' });
    expect((await ctx.db.query('SELECT status FROM tickets')).rows[0].status).toBe('DONE');

    const list = await (await ctx.handle(jsonRequest('GET', '/admin/tickets', undefined, cookie))).json();
    expect(list.tickets[0].hasNotificationProblem).toBe(true);

    const notifId = (await ctx.db.query(`SELECT id FROM notifications WHERE kind = 'REPORTER_RESOLVED'`)).rows[0].id;
    ctx.mailer.fail(null);
    const retry = await ctx.handle(jsonRequest('POST', `/admin/notifications/${notifId}/retry`, {}, cookie));
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe('SENT');
    expect(ctx.mailer.sent).toHaveLength(1);

    // A sent email cannot be "retried" into a duplicate.
    const again = await ctx.handle(jsonRequest('POST', `/admin/notifications/${notifId}/retry`, {}, cookie));
    expect(again.status).toBe(409);
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('rejects invalid statuses and unknown tickets', async () => {
    const cookie = await login(ctx.handle);
    const t = await createTicket();
    expect((await setStatus(t.id, 'CLOSED', cookie)).status).toBe(422);
    expect((await setStatus('00000000-0000-0000-0000-000000000000', 'DONE', cookie)).status).toBe(404);
    expect((await setStatus('not-a-uuid', 'DONE', cookie)).status).toBe(404);
  });
});

describe('error handling', () => {
  it('returns 404 JSON for unknown routes and does not leak internals', async () => {
    const res = await ctx.handle(jsonRequest('GET', '/nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.' });
  });

  it('routes rewritten Vercel paths', async () => {
    const res = await ctx.handle(new Request(`${BASE}/api/index?__path=health`));
    expect(await res.json()).toEqual({ ok: true });
  });
});
