import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { consoleMailer, resendMailer, unconfiguredMailer } from './email.js';
import { storageFromEnv } from './storage.js';

let handler: ((req: Request) => Promise<Response>) | null = null;

/** Build the real app from environment variables once per function instance. */
export function getHandler(): (req: Request) => Promise<Response> {
  if (handler) return handler;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return async () =>
      new Response(JSON.stringify({ error: 'The server is not configured yet (DATABASE_URL is missing).' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
  }
  const config = loadConfig();
  const mailer = config.emailDryRun
    ? consoleMailer()
    : config.emailApiKey && config.emailFrom
      ? resendMailer(config.emailApiKey, config.emailFrom)
      : unconfiguredMailer('Email is not configured (set EMAIL_PROVIDER_API_KEY and EMAIL_FROM).');
  handler = createApp({ db: createPool(databaseUrl), storage: storageFromEnv(), mailer, config });
  return handler;
}
