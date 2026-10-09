import { STATUSES, STATUS_INFO, type TicketStatus } from '../../shared/constants';

export function StatusSelect({
  value,
  disabled,
  onChange,
  id,
  label,
}: {
  value: TicketStatus;
  disabled?: boolean;
  onChange: (status: TicketStatus) => void;
  id?: string;
  label: string;
}) {
  const info = STATUS_INFO[value];
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as TicketStatus)}
      className="cursor-pointer rounded-full border-0 py-1 pl-3 pr-8 text-xs font-bold disabled:cursor-wait disabled:opacity-70"
      style={{ backgroundColor: info.color, color: info.textColor }}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s} style={{ backgroundColor: '#fff', color: '#0f172a' }}>
          {STATUS_INFO[s].label}
        </option>
      ))}
    </select>
  );
}

/** Marking Done emails the reporter, so ask first. */
export function confirmStatusChange(from: TicketStatus, to: TicketStatus, reference: string): boolean {
  if (to === 'DONE') {
    return window.confirm(`Mark ${reference} as Done? The reporter will be emailed that the issue is resolved.`);
  }
  if (from === 'DONE') {
    return window.confirm(`Reopen ${reference} as ${STATUS_INFO[to].label}?`);
  }
  return true;
}
