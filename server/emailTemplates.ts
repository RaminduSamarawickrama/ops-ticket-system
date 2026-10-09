import { PRIORITY_INFO, STATUS_INFO, type Priority, type TicketStatus } from '../shared/constants.js';

export interface TicketForEmail {
  id: string;
  reference: string;
  subject: string;
  priority: Priority;
  reporterEmail: string;
  description: string;
  incidentDate: string; // YYYY-MM-DD
  incidentTime: string; // HH:MM or HH:MM:SS
  affectedSystem: string;
  status: TicketStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Subjects are plain text; just make sure user input can't add header line breaks. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function formatDateTime(d: Date, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${text} (${timeZone})`;
}

export function formatIncident(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${String(d).padStart(2, '0')} ${month} ${y}, ${time.slice(0, 5)}`;
}

function badge(label: string, bg: string, fg: string): string {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:700;letter-spacing:.02em">${esc(label)}</span>`;
}

function row(label: string, valueHtml: string): string {
  return `<tr><td style="padding:8px 12px 8px 0;color:#64748b;font-size:13px;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:8px 0;color:#0f172a;font-size:14px;vertical-align:top">${valueHtml}</td></tr>`;
}

function layout(opts: { banner?: string; heading: string; intro: string; rows: string; footer?: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
${opts.banner ?? ''}
<tr><td style="padding:24px 24px 8px"><div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.08em">Operations Support Portal</div>
<h1 style="margin:6px 0 8px;font-size:20px;color:#0f172a">${opts.heading}</h1>
<p style="margin:0;color:#334155;font-size:14px;line-height:1.5">${opts.intro}</p></td></tr>
<tr><td style="padding:8px 24px 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e2e8f0">${opts.rows}</table></td></tr>
${opts.footer ? `<tr><td style="padding:0 24px 24px">${opts.footer}</td></tr>` : ''}
</table>
<p style="color:#94a3b8;font-size:12px;margin:12px 0 0">This is an automated message from the Operations Support Portal.</p>
</td></tr></table></body></html>`;
}

function descriptionHtml(text: string): string {
  return `<div style="white-space:pre-wrap;word-break:break-word">${esc(text)}</div>`;
}

export function opsNewTicketEmail(t: TicketForEmail, opts: { timeZone: string; dashboardUrl: string | null }): EmailContent {
  const p = PRIORITY_INFO[t.priority];
  const s = STATUS_INFO[t.status];
  const subject = oneLine(`[${t.priority} - ${p.name}] ${t.reference} - ${t.subject}`);
  const isP1 = t.priority === 'P1';
  const banner = isP1
    ? `<tr><td style="background:${p.color};color:#ffffff;padding:16px 24px;font-size:18px;font-weight:700">&#9888; P1 EMERGENCY: immediate action required</td></tr>`
    : `<tr><td style="background:${p.color};height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>`;
  const submitted = formatDateTime(t.createdAt, opts.timeZone);
  const incident = formatIncident(t.incidentDate, t.incidentTime);
  const rows = [
    row('Reference', `<strong>${esc(t.reference)}</strong>`),
    row('Priority', badge(p.label, p.color, p.textColor)),
    row('Subject', esc(t.subject)),
    row('Reporter', esc(t.reporterEmail)),
    row('Affected system', esc(t.affectedSystem)),
    row('Incident date/time', esc(incident)),
    row('Submitted', esc(submitted)),
    row('Status', badge(s.label, s.color, s.textColor)),
    row('Description', descriptionHtml(t.description)),
  ].join('');
  const footer = opts.dashboardUrl
    ? `<a href="${esc(opts.dashboardUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:700">Open ticket in dashboard</a><p style="color:#64748b;font-size:12px;margin:8px 0 0">You will be asked to sign in. Screenshots, if any, are only visible in the dashboard.</p>`
    : undefined;
  const html = layout({
    banner,
    heading: `New ${esc(p.label)} ticket: ${esc(t.subject)}`,
    intro: isP1
      ? '<strong>An emergency ticket has been raised.</strong> Please respond immediately.'
      : 'A new ticket has been raised through the Operations Support Portal.',
    rows,
    footer,
  });
  const text = [
    isP1 ? '*** P1 EMERGENCY: IMMEDIATE ACTION REQUIRED ***\n' : '',
    `New ticket ${t.reference}`,
    `Priority: ${p.label}`,
    `Subject: ${t.subject}`,
    `Reporter: ${t.reporterEmail}`,
    `Affected system: ${t.affectedSystem}`,
    `Incident date/time: ${incident}`,
    `Submitted: ${submitted}`,
    `Status: ${s.label}`,
    '',
    'Description:',
    t.description,
    '',
    opts.dashboardUrl ? `Open in dashboard (sign-in required): ${opts.dashboardUrl}` : '',
  ].join('\n');
  return { subject, html, text };
}

export function reporterCreatedEmail(t: TicketForEmail, opts: { timeZone: string }): EmailContent {
  const p = PRIORITY_INFO[t.priority];
  const s = STATUS_INFO[t.status];
  const subject = oneLine(`[${t.reference}] Ticket received - ${t.subject}`);
  const submitted = formatDateTime(t.createdAt, opts.timeZone);
  const incident = formatIncident(t.incidentDate, t.incidentTime);
  const rows = [
    row('Reference', `<strong>${esc(t.reference)}</strong>`),
    row('Subject', esc(t.subject)),
    row('Priority', badge(p.label, p.color, p.textColor)),
    row('Affected system', esc(t.affectedSystem)),
    row('Incident date/time', esc(incident)),
    row('Submitted', esc(submitted)),
    row('Status', badge(s.label, s.color, s.textColor)),
    row('Description', descriptionHtml(t.description)),
  ].join('');
  const html = layout({
    banner: `<tr><td style="background:${p.color};height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>`,
    heading: 'We have received your ticket',
    intro: `Thank you. Your ticket <strong>${esc(t.reference)}</strong> has been logged and the operations team has been notified. Please quote the reference if you contact the team about this issue.`,
    rows,
  });
  const text = [
    'We have received your ticket.',
    `The operations team has been notified. Please quote reference ${t.reference} if you contact the team.`,
    '',
    `Reference: ${t.reference}`,
    `Subject: ${t.subject}`,
    `Priority: ${p.label}`,
    `Affected system: ${t.affectedSystem}`,
    `Incident date/time: ${incident}`,
    `Submitted: ${submitted}`,
    `Status: ${s.label}`,
    '',
    'Description:',
    t.description,
  ].join('\n');
  return { subject, html, text };
}

export function reporterResolvedEmail(t: TicketForEmail, opts: { timeZone: string }): EmailContent {
  const p = PRIORITY_INFO[t.priority];
  const done = STATUS_INFO.DONE;
  const subject = oneLine(`[${t.reference}] Resolved - ${t.subject}`);
  const resolved = formatDateTime(t.resolvedAt ?? new Date(), opts.timeZone);
  const rows = [
    row('Reference', `<strong>${esc(t.reference)}</strong>`),
    row('Subject', esc(t.subject)),
    row('Priority', badge(p.label, p.color, p.textColor)),
    row('Final status', badge(done.label, done.color, done.textColor)),
    row('Resolved', esc(resolved)),
  ].join('');
  const html = layout({
    banner: `<tr><td style="background:${done.color};height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>`,
    heading: 'Your ticket has been resolved',
    intro: `The operations team has marked ticket <strong>${esc(t.reference)}</strong> as resolved. If the problem continues, please raise a new ticket and mention this reference.`,
    rows,
  });
  const text = [
    `Your ticket ${t.reference} has been resolved.`,
    'The operations team has marked this issue as resolved. If the problem continues, raise a new ticket and mention this reference.',
    '',
    `Reference: ${t.reference}`,
    `Subject: ${t.subject}`,
    `Priority: ${p.label}`,
    `Final status: ${done.label}`,
    `Resolved: ${resolved}`,
  ].join('\n');
  return { subject, html, text };
}
