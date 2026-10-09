import { isValidEmail } from '../shared/validation.js';

export interface AppConfig {
  isProduction: boolean;
  /** Public base URL used for links in emails, e.g. https://ops.example.com */
  appBaseUrl: string | null;
  /** IANA time zone used to show timestamps in emails, e.g. Asia/Colombo */
  timeZone: string;
  emailFrom: string | null;
  emailApiKey: string | null;
  /** When true, emails are logged instead of sent (local development only). */
  emailDryRun: boolean;
  opsRecipients: string[];
  /** Human-readable configuration problems shown to administrators. */
  warnings: string[];
  sessionTtlHours: number;
}

/** Parse a comma-separated list of addresses; returns valid unique addresses and the invalid ones. */
export function parseRecipientList(raw: string | undefined): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (isValidEmail(value)) {
      if (!valid.includes(value)) valid.push(value);
    } else {
      invalid.push(value);
    }
  }
  return { valid, invalid };
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const warnings: string[] = [];
  const isProduction = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';

  const ops = parseRecipientList(env.OPERATIONS_NOTIFICATION_EMAIL);
  if (!env.OPERATIONS_NOTIFICATION_EMAIL?.trim()) {
    warnings.push(
      'OPERATIONS_NOTIFICATION_EMAIL is not set, so the operations team is not being emailed about new tickets.',
    );
  } else if (ops.invalid.length > 0) {
    warnings.push(
      `OPERATIONS_NOTIFICATION_EMAIL contains ${ops.invalid.length} invalid address(es) that are being ignored.`,
    );
  }
  if (env.OPERATIONS_NOTIFICATION_EMAIL?.trim() && ops.valid.length === 0) {
    warnings.push('OPERATIONS_NOTIFICATION_EMAIL has no valid addresses.');
  }

  const emailDryRun = env.EMAIL_DRY_RUN === 'true' && !isProduction;
  const emailApiKey = env.EMAIL_PROVIDER_API_KEY?.trim() || null;
  const emailFrom = env.EMAIL_FROM?.trim() || null;
  if (!emailDryRun) {
    if (!emailApiKey) warnings.push('EMAIL_PROVIDER_API_KEY is not set, so no emails can be sent.');
    if (!emailFrom) warnings.push('EMAIL_FROM is not set, so no emails can be sent.');
  } else {
    warnings.push('EMAIL_DRY_RUN is on: emails are written to the server log instead of being sent.');
  }

  let appBaseUrl = env.APP_BASE_URL?.trim().replace(/\/+$/, '') || null;
  if (!appBaseUrl && env.VERCEL_PROJECT_PRODUCTION_URL) {
    appBaseUrl = `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (!appBaseUrl) warnings.push('APP_BASE_URL is not set, so emails cannot include a link to the dashboard.');

  let timeZone = env.APP_TIMEZONE?.trim() || 'UTC';
  if (!validTimeZone(timeZone)) {
    warnings.push(`APP_TIMEZONE "${timeZone}" is not a valid time zone; using UTC.`);
    timeZone = 'UTC';
  }

  const ttl = Number(env.SESSION_TTL_HOURS ?? 12);
  return {
    isProduction,
    appBaseUrl,
    timeZone,
    emailFrom,
    emailApiKey,
    emailDryRun,
    opsRecipients: ops.valid,
    warnings,
    sessionTtlHours: Number.isFinite(ttl) && ttl > 0 && ttl <= 168 ? ttl : 12,
  };
}
