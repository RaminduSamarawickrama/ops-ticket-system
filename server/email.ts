export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Lets the provider drop an accidental duplicate of the same send attempt. */
  idempotencyKey?: string;
}

/** Outcome of handing a message to the provider. "accepted" is not proof of inbox delivery. */
export type SendResult = { ok: true; providerMessageId: string | null } | { ok: false; error: string };

export interface Mailer {
  send(message: EmailMessage): Promise<SendResult>;
}

/** Resend (https://resend.com) over its REST API. No SDK needed. */
export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(message) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
        if (!res.ok) {
          return { ok: false, error: `Email provider returned ${res.status}: ${body.message ?? body.name ?? 'unknown error'}` };
        }
        return { ok: true, providerMessageId: body.id ?? null };
      } catch (err) {
        const e = err as Error;
        return { ok: false, error: e.name === 'TimeoutError' ? 'Email provider timed out' : `Could not reach email provider: ${e.message}` };
      }
    },
  };
}

/** Development helper: prints the email instead of sending it. */
export function consoleMailer(): Mailer {
  return {
    async send(message) {
      console.log(`\n[EMAIL_DRY_RUN] To: ${message.to.join(', ')}\nSubject: ${message.subject}\n${message.text}\n`);
      return { ok: true, providerMessageId: null };
    },
  };
}

/** Used when email is not configured: every send fails with a clear reason that admins can see. */
export function unconfiguredMailer(reason: string): Mailer {
  return {
    async send() {
      return { ok: false, error: reason };
    },
  };
}
