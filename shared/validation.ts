import { z } from 'zod';
import { FIELD_LIMITS, PRIORITIES, STATUSES } from './constants.js';

// Practical email check: one @, no spaces, a dot in the domain, sane length.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isValidEmail(value: string): boolean {
  return value.length <= FIELD_LIMITS.email && EMAIL_RE.test(value);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Strip ASCII control characters except tab and newline, then trim.
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

const requiredText = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .transform(clean)
    .pipe(
      z
        .string()
        .min(1, `${label} is required.`)
        .max(max, `${label} must be ${max} characters or fewer.`),
    );

export const ticketInputSchema = z.object({
  subject: requiredText('Ticket subject', FIELD_LIMITS.subject).refine((v) => !/[\r\n]/.test(v), {
    message: 'Ticket subject must be a single line.',
  }),
  priority: z.enum(PRIORITIES, { error: 'Choose a priority.' }),
  reporterEmail: z
    .string({ error: 'Email address is required.' })
    .transform((v) => clean(v).toLowerCase())
    .pipe(
      z
        .string()
        .min(1, 'Email address is required.')
        .refine(isValidEmail, { message: 'Enter a valid email address.' }),
    ),
  description: requiredText('Incident description', FIELD_LIMITS.description),
  incidentDate: z
    .string({ error: 'Incident date is required.' })
    .refine(isRealDate, { message: 'Enter a valid incident date.' }),
  incidentTime: z
    .string({ error: 'Incident time is required.' })
    .refine((v) => TIME_RE.test(v), { message: 'Enter a valid incident time.' }),
  affectedSystem: requiredText('Affected system', FIELD_LIMITS.affectedSystem),
});

export type TicketInput = z.infer<typeof ticketInputSchema>;

export const statusUpdateSchema = z.object({
  status: z.enum(STATUSES, { error: 'Choose a valid status.' }),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.').max(64),
  password: z.string().min(1, 'Password is required.').max(256),
});

/** Turn a Zod error into { field: firstMessage } for display next to form fields. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
