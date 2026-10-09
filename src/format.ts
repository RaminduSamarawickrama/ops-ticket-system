const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}

/** Incident date/time is stored exactly as the reporter entered it (no time zone conversion). */
export function formatIncident(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
  return `${String(d).padStart(2, '0')} ${month} ${y}, ${time.slice(0, 5)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
