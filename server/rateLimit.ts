import { createHash } from 'node:crypto';
import type { Queryable } from './db.js';

export const hashKey = (value: string) => createHash('sha256').update(value).digest('hex');

function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Add one to the counter for (bucket, key) in the current fixed window and return the new count. */
export async function hit(db: Queryable, bucket: string, key: string, windowSeconds: number, now = new Date()): Promise<number> {
  const res = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, key_hash, window_start, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (bucket, key_hash, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, hashKey(key), windowStart(now, windowSeconds)],
  );
  // Housekeeping: occasionally clear out windows older than a day.
  if (Math.random() < 0.02) {
    await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`).catch(() => {});
  }
  return res.rows[0].count;
}

/** Read the counter without changing it. */
export async function peek(db: Queryable, bucket: string, key: string, windowSeconds: number, now = new Date()): Promise<number> {
  const res = await db.query<{ count: number }>(
    'SELECT count FROM rate_limits WHERE bucket = $1 AND key_hash = $2 AND window_start = $3',
    [bucket, hashKey(key), windowStart(now, windowSeconds)],
  );
  return res.rows[0]?.count ?? 0;
}

export const LIMITS = {
  /** Public ticket submissions per IP address per hour. */
  submitPerIpPerHour: 10,
  /** Login attempts (any outcome) per IP address per 15 minutes. */
  loginPerIpPer15Min: 20,
  /** Failed logins per username per 15 minutes before that account is temporarily locked. */
  loginFailuresPerUserPer15Min: 5,
};
