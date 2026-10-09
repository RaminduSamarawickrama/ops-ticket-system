import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

// Return DATE and TIME columns as plain strings ("2026-10-09", "14:30:00") instead of JS Dates,
// so incident dates never shift because of server time zones.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1083, (v) => v);

export function createPool(connectionString: string): Db {
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(connectionString);
  return new pg.Pool({
    connectionString,
    // Serverless functions should hold few connections; use the provider's pooled URL in production.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: isLocal || /sslmode=disable/.test(connectionString) ? undefined : { rejectUnauthorized: true },
  });
}

/** Run fn inside a transaction; rolls back on any error. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
