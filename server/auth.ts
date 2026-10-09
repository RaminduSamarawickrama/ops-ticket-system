import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Queryable } from './db.js';
import { HttpError, parseCookies, serializeCookie } from './http.js';

export const SESSION_COOKIE = 'ops_session';
const BCRYPT_COST = 12;
export const MIN_PASSWORD_LENGTH = 12;

// Compared against when the username does not exist, so response time doesn't reveal valid usernames.
// Created on first use to keep cold starts fast.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_COST));

export interface AdminSession {
  adminId: string;
  username: string;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  // bcrypt only reads the first 72 bytes, so refuse longer passwords rather than silently truncating.
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer.';
  return null;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Check credentials. Returns the admin on success, null on failure. */
export async function verifyCredentials(
  db: Queryable,
  username: string,
  password: string,
): Promise<{ id: string; username: string } | null> {
  const res = await db.query<{ id: string; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM admins WHERE username = $1',
    [normalizeUsername(username)],
  );
  const admin = res.rows[0];
  const ok = await bcrypt.compare(password, admin?.password_hash ?? (await getDummyHash()));
  return admin && ok ? { id: admin.id, username: admin.username } : null;
}

export async function createSession(
  db: Queryable,
  adminId: string,
  ttlHours: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.query('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(token),
    adminId,
    expiresAt,
  ]);
  await db.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [adminId]);
  // Housekeeping: remove expired sessions.
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, expiresAt };
}

export async function getSession(db: Queryable, req: Request): Promise<AdminSession | null> {
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const res = await db.query<{ admin_id: string; username: string }>(
    `SELECT s.admin_id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  return row ? { adminId: row.admin_id, username: row.username } : null;
}

/** Every admin route calls this on the server. Hiding pages in the browser is not relied on. */
export async function requireAdmin(db: Queryable, req: Request): Promise<AdminSession> {
  const session = await getSession(db, req);
  if (!session) throw new HttpError(401, 'Please sign in to continue.');
  return session;
}

export async function destroySession(db: Queryable, req: Request): Promise<void> {
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: (expiresAt.getTime() - Date.now()) / 1000, secure });
}

export function clearSessionCookie(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure });
}
