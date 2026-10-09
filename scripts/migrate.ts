// Usage: npm run db:migrate   (reads DATABASE_URL, e.g. from .env.local)
// Prefers DATABASE_URL_UNPOOLED (set by the Neon integration): schema changes and the migration
// lock need a direct connection rather than the transaction pooler.
import { createPool } from '../server/db.js';
import { runMigrations } from '../server/migrate.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  if (process.argv.includes('--if-configured')) {
    // Used by the Vercel build: skip quietly until a database is connected.
    console.warn('DATABASE_URL is not set; skipping database migrations.');
    process.exit(0);
  }
  console.error('DATABASE_URL is not set. Add it to .env.local or your shell environment.');
  process.exit(1);
}
const db = createPool(url);
try {
  await runMigrations(db);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
