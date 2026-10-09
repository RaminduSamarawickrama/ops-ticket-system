import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JPEG_BYTES,
  PNG_BYTES,
  jsonRequest,
  login,
  newSubmissionId,
  setup,
  submitRequest,
  validFields,
} from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  if (ctx) await ctx.db.end();
  ctx = await setup();
});
afterAll(async () => {
  await ctx?.db.end();
});

async function submit(fields = validFields(), files: Parameters<typeof submitRequest>[1] = []) {
  const res = await ctx.handle(submitRequest(fields, files));
  return { res, body: (await res.json()) as { reference?: string; error?: string; fields?: Record<string, string> } };
}

describe('public ticket submission', () => {
  it('creates a ticket with a reference, persists it, and emails reporter and ops', async () => {
    const { res, body } = await submit();
    expect(res.status).toBe(201);
    expect(body.reference).toMatch(/^OPS-\d{4}-00001$/);

    const row = (await ctx.db.query('SELECT * FROM tickets')).rows[0];
    expect(row.reference).toBe(body.reference);
    expect(row.status).toBe('OPEN');
    expect(row.reporter_email).toBe('reporter@example.com');
    expect(row.incident_date).toBe('2026-10-09');

    expect(ctx.mailer.sent).toHaveLength(2);
    const ops = ctx.mailer.sent.find((m) => m.to.includes('ops@example.com'))!;
    expect(ops.to).toEqual(['ops@example.com', 'supervisor@example.com']);
    expect(ops.subject).toBe(`[P1 - EMERGENCY] ${body.reference} - Payment System Down`);
    expect(ops.html).toContain(`https://ops.example.com/admin/tickets/${row.id}`);
    const reporter = ctx.mailer.sent.find((m) => m.to.includes('reporter@example.com'))!;
    expect(reporter.subject).toContain(body.reference!);
    expect(reporter.text).toContain('operations team has been notified');

    const n = await ctx.db.query(`SELECT kind, status FROM notifications ORDER BY kind`);
    expect(n.rows).toEqual([
      { kind: 'OPS_NEW_TICKET', status: 'SENT' },
      { kind: 'REPORTER_CREATED', status: 'SENT' },
    ]);
    const ev = await ctx.db.query(`SELECT event_type FROM ticket_events`);
    expect(ev.rows.map((r) => r.event_type)).toEqual(['CREATED']);
  });

  it('issues sequential references and never duplicates them under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) => submit(validFields({ subject: `Concurrent ${i}` }))),
    );
    const refs = results.map((r) => r.body.reference!);
    expect(new Set(refs).size).toBe(15);
    const numbers = refs.map((r) => Number(r.split('-')[2])).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('treats a repeated submission id as the same ticket (no double tickets or emails)', async () => {
    const submissionId = newSubmissionId();
    const fields = validFields({ submissionId });
    const [a, b] = await Promise.all([submit(fields), submit(fields)]);
    expect(a.body.reference).toBe(b.body.reference);
    const c = await submit(fields);
    expect(c.res.status).toBe(200);
    expect(c.body.reference).toBe(a.body.reference);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(1);
    expect(ctx.mailer.sent).toHaveLength(2);
  });

  it('returns field errors for invalid input and saves nothing', async () => {
    const { res, body } = await submit(validFields({ reporterEmail: 'nope', priority: 'P9', subject: '' }));
    expect(res.status).toBe(422);
    expect(Object.keys(body.fields!)).toEqual(expect.arrayContaining(['reporterEmail', 'priority', 'subject']));
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n).toBe(0);
  });

  it('stores screenshots privately under generated keys', async () => {
    const { res } = await submit(validFields(), [
      { bytes: PNG_BYTES, name: '../../evil name.png' },
      { bytes: JPEG_BYTES, name: 'photo.jpg', type: 'image/jpeg' },
    ]);
    expect(res.status).toBe(201);
    const rows = (await ctx.db.query('SELECT * FROM attachments ORDER BY original_name')).rows;
    expect(rows.map((r) => r.original_name)).toEqual(['evil name.png', 'photo.jpg']);
    for (const r of rows) {
      expect(r.storage_key).toMatch(/^tickets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg)$/);
      expect(ctx.storage.files.has(r.storage_key)).toBe(true);
    }
  });

  it('rejects files that are not real images, whatever their name or declared type', async () => {
    const { res, body } = await submit(validFields(), [
      { bytes: new TextEncoder().encode('<svg onload="alert(1)"/>'), name: 'shot.png', type: 'image/png' },
    ]);
    expect(res.status).toBe(422);
    expect(body.fields?.screenshots).toBeDefined();
    expect(ctx.storage.files.size).toBe(0);
  });

  it('rejects too many or too large screenshots', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ bytes: PNG_BYTES, name: `s${i}.png` }));
    expect((await submit(validFields(), six)).res.status).toBe(422);

    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set(PNG_BYTES);
    expect((await submit(validFields(), [{ bytes: big, name: 'big.png' }])).res.status).toBe(422);
  });

  it('still saves the ticket when email sending fails, and records the failure', async () => {
    ctx.mailer.fail('Email provider returned 500: boom');
    const { res, body } = await submit();
    expect(res.status).toBe(201);
    expect(body.reference).toBeDefined();
    const n = await ctx.db.query(`SELECT status, last_error FROM notifications`);
    expect(n.rows.every((r) => r.status === 'FAILED' && r.last_error.includes('boom'))).toBe(true);
    const ev = await ctx.db.query(`SELECT count(*)::int AS n FROM ticket_events WHERE event_type = 'NOTIFICATION_FAILED'`);
    expect(ev.rows[0].n).toBe(2);
  });

  it('rate limits public submissions per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await ctx.handle(submitRequest(validFields({ subject: `Spam ${i}` }), [], '203.0.113.5'));
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('missing operations email configuration', () => {
  it('skips the ops email, still emails the reporter, and warns admins', async () => {
    await ctx.db.end();
    ctx = await setup({ OPERATIONS_NOTIFICATION_EMAIL: '' });
    const { res } = await submit();
    expect(res.status).toBe(201);
    expect(ctx.mailer.sent).toHaveLength(1);
    const ops = (await ctx.db.query(`SELECT status, last_error FROM notifications WHERE kind = 'OPS_NEW_TICKET'`)).rows[0];
    expect(ops.status).toBe('SKIPPED');
    expect(ops.last_error).toContain('OPERATIONS_NOTIFICATION_EMAIL');

    const cookie = await login(ctx.handle);
    const summary = await (await ctx.handle(jsonRequest('GET', '/admin/summary', undefined, cookie))).json();
    expect(summary.configWarnings.join(' ')).toContain('OPERATIONS_NOTIFICATION_EMAIL');
    expect(summary.ticketsWithNotificationProblems).toBe(1);
  });
});
