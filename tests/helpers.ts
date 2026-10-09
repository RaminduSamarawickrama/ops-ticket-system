import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
import { loadConfig, type AppConfig } from '../server/config.js';
import { createPool, type Db } from '../server/db.js';
import type { EmailMessage, Mailer, SendResult } from '../server/email.js';
import { runMigrations } from '../server/migrate.js';
import { memoryStorage } from '../server/storage.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/ops_test?sslmode=disable';

export const ADMIN = { username: 'opsadmin', password: 'correct horse battery' };
export const BASE = 'http://ops.test';

/** A mailer that records what was sent and can be told to fail. */
export function fakeMailer() {
  const sent: EmailMessage[] = [];
  let failWith: string | null = null;
  const mailer: Mailer & { sent: EmailMessage[]; fail(reason: string | null): void } = {
    sent,
    fail(reason) {
      failWith = reason;
    },
    async send(message): Promise<SendResult> {
      if (failWith) return { ok: false, error: failWith };
      sent.push(message);
      return { ok: true, providerMessageId: `msg_${sent.length}` };
    },
  };
  return mailer;
}

export async function resetDatabase(db: Db) {
  // Safety net: the tests wipe the database, so only run against one whose name says "test".
  const name = (await db.query<{ db: string }>('SELECT current_database() AS db')).rows[0].db;
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to wipe database "${name}". Point TEST_DATABASE_URL at a database whose name contains "test".`);
  }
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(db, () => {});
  await db.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [
    ADMIN.username,
    await hashPassword(ADMIN.password),
  ]);
}

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    OPERATIONS_NOTIFICATION_EMAIL: 'ops@example.com, supervisor@example.com',
    EMAIL_FROM: 'Ops Portal <portal@example.com>',
    EMAIL_PROVIDER_API_KEY: 're_test',
    APP_BASE_URL: 'https://ops.example.com',
    APP_TIMEZONE: 'Asia/Colombo',
    ...overrides,
  });
}

export async function setup(configOverrides: Partial<Record<string, string>> = {}) {
  const db = createPool(TEST_DATABASE_URL);
  await resetDatabase(db);
  const storage = memoryStorage();
  const mailer = fakeMailer();
  const config = testConfig(configOverrides);
  const handle = createApp({ db, storage, mailer, config });
  return { db, storage, mailer, config, handle };
}

// --- Request helpers -----------------------------------------------------------------------------

// 1x1 PNG, smallest valid JPEG header and WebP header for upload tests.
export const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

export function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    subject: 'Payment System Down',
    priority: 'P1',
    reporterEmail: 'Reporter@Example.com',
    description: 'Card payments fail with error 502 since 09:40.\nAll terminals affected.',
    incidentDate: '2026-10-09',
    incidentTime: '09:40',
    affectedSystem: 'Payment Gateway',
    ...overrides,
  };
}

let ipCounter = 0;
/** Each call gets a fresh client IP so tests don't trip each other's rate limits. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export function submitRequest(
  fields: Record<string, string>,
  files: Array<{ bytes: Uint8Array; name: string; type?: string }> = [],
  ip = freshIp(),
): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append('screenshots', new Blob([f.bytes as Uint8Array<ArrayBuffer>],{ type: f.type ?? 'image/png' }), f.name);
  return new Request(`${BASE}/api/tickets`, { method: 'POST', body: form, headers: { 'x-real-ip': ip } });
}

export function jsonRequest(method: string, path: string, body?: unknown, cookie?: string, ip = freshIp()): Request {
  const headers: Record<string, string> = { 'x-real-ip': ip, host: 'ops.test', origin: BASE };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  return new Request(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function login(handle: (r: Request) => Promise<Response>): Promise<string> {
  const res = await handle(jsonRequest('POST', '/auth/login', ADMIN));
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

export const newSubmissionId = () => randomUUID();
