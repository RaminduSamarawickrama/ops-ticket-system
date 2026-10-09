import {
  NOTIFICATION_STATUS_LABEL,
  PRIORITY_INFO,
  STATUS_INFO,
  type NotificationStatus,
  type Priority,
  type TicketStatus,
} from '../../shared/constants';

function Pill({ label, bg, fg, title }: { label: string; bg: string; fg: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold"
      style={{ backgroundColor: bg, color: fg }}
    >
      {label}
    </span>
  );
}

export function PriorityBadge({ priority, short = false }: { priority: Priority; short?: boolean }) {
  const p = PRIORITY_INFO[priority];
  return <Pill label={short ? priority : p.label} bg={p.color} fg={p.textColor} title={p.label} />;
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const s = (STATUS_INFO as Record<string, { label: string; color: string; textColor: string } | undefined>)[status];
  return <Pill label={s?.label ?? status} bg={s?.color ?? '#94A3B8'} fg={s?.textColor ?? '#FFFFFF'} />;
}

const NOTIF_COLORS: Record<NotificationStatus, [string, string]> = {
  SENT: ['#DCFCE7', '#166534'],
  PENDING: ['#E2E8F0', '#334155'],
  FAILED: ['#FEE2E2', '#991B1B'],
  SKIPPED: ['#FEF3C7', '#92400E'],
};

export function NotificationBadge({ status }: { status: NotificationStatus }) {
  const [bg, fg] = NOTIF_COLORS[status];
  return <Pill label={NOTIFICATION_STATUS_LABEL[status]} bg={bg} fg={fg} />;
}
