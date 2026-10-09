import { describe, expect, it } from 'vitest';
import { loadConfig, parseRecipientList } from '../server/config.js';
import { opsNewTicketEmail, reporterResolvedEmail, type TicketForEmail } from '../server/emailTemplates.js';
import { safeDisplayName, sniffImageType } from '../server/images.js';
import { formatReference } from '../server/tickets.js';
import { isValidEmail, ticketInputSchema } from '../shared/validation.js';
import { JPEG_BYTES, PNG_BYTES, validFields } from './helpers.js';

describe('ticket input validation', () => {
  it('accepts a valid ticket and normalises the email', () => {
    const r = ticketInputSchema.safeParse(validFields());
    expect(r.success).toBe(true);
    expect(r.success && r.data.reporterEmail).toBe('reporter@example.com');
  });

  it.each([
    ['subject', ''],
    ['subject', '   '],
    ['subject', 'x'.repeat(151)],
    ['priority', 'P4'],
    ['reporterEmail', 'not-an-email'],
    ['reporterEmail', 'a@b'],
    ['description', ''],
    ['incidentDate', '2026-02-30'],
    ['incidentDate', '09/10/2026'],
    ['incidentTime', '24:00'],
    ['incidentTime', '9:5'],
    ['affectedSystem', ''],
  ])('rejects %s = %j', (field, value) => {
    const r = ticketInputSchema.safeParse(validFields({ [field]: value }));
    expect(r.success).toBe(false);
  });

  it('rejects a subject containing line breaks', () => {
    expect(ticketInputSchema.safeParse(validFields({ subject: 'a\nBcc: x@y.com' })).success).toBe(false);
  });

  it('validates emails', () => {
    expect(isValidEmail('ops@example.com')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.co.uk')).toBe(true);
    expect(isValidEmail('no spaces@example.com')).toBe(false);
    expect(isValidEmail('<x>@example.com')).toBe(false);
  });
});

describe('image sniffing', () => {
  it('identifies real images by their bytes', () => {
    expect(sniffImageType(PNG_BYTES)).toBe('image/png');
    expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });
  it('rejects other content even when named like an image', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
  });
  it('cleans display names', () => {
    expect(safeDisplayName('../../etc/passwd')).toBe('passwd');
    expect(safeDisplayName('C:\\Users\\me\\shot<1>.png')).toBe('shot1.png');
    expect(safeDisplayName('')).toBe('screenshot');
  });
});

describe('configuration', () => {
  it('parses comma-separated recipients and reports invalid ones', () => {
    expect(parseRecipientList(' Ops@Example.com, bad, sup@example.com ,ops@example.com')).toEqual({
      valid: ['ops@example.com', 'sup@example.com'],
      invalid: ['bad'],
    });
  });
  it('warns when the operations email is missing', () => {
    const c = loadConfig({ EMAIL_FROM: 'a@example.com', EMAIL_PROVIDER_API_KEY: 'k' });
    expect(c.opsRecipients).toEqual([]);
    expect(c.warnings.some((w) => w.includes('OPERATIONS_NOTIFICATION_EMAIL'))).toBe(true);
  });
  it('never allows dry-run email in production', () => {
    expect(loadConfig({ EMAIL_DRY_RUN: 'true', VERCEL_ENV: 'production' }).emailDryRun).toBe(false);
  });
});

describe('references and email content', () => {
  it('formats references', () => {
    expect(formatReference(2026, 1)).toBe('OPS-2026-00001');
    expect(formatReference(2026, 123456)).toBe('OPS-2026-123456');
  });

  const ticket: TicketForEmail = {
    id: '00000000-0000-0000-0000-000000000001',
    reference: 'OPS-2026-00001',
    subject: 'Payment <b>System</b> Down',
    priority: 'P1',
    reporterEmail: 'r@example.com',
    description: '<script>alert(1)</script>',
    incidentDate: '2026-10-09',
    incidentTime: '09:40:00',
    affectedSystem: 'Gateway',
    status: 'OPEN',
    createdAt: new Date('2026-10-09T04:15:00Z'),
    resolvedAt: new Date('2026-10-09T06:00:00Z'),
  };

  it('builds the ops subject with priority and reference, escaping user input in HTML', () => {
    const e = opsNewTicketEmail(ticket, { timeZone: 'Asia/Colombo', dashboardUrl: 'https://x.test/admin/tickets/1' });
    expect(e.subject).toBe('[P1 - EMERGENCY] OPS-2026-00001 - Payment <b>System</b> Down');
    expect(e.html).toContain('P1 EMERGENCY');
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.html).toContain('09 Oct 2026, 09:45 (Asia/Colombo)');
    expect(e.text).toContain('Reporter: r@example.com');
  });

  it('builds the resolution subject', () => {
    const e = reporterResolvedEmail(ticket, { timeZone: 'UTC' });
    expect(e.subject).toBe('[OPS-2026-00001] Resolved - Payment <b>System</b> Down');
    expect(e.text).toContain('Final status: Done');
  });
});
