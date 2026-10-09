export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (body as { error?: string }).error ?? `Request failed (${res.status}).`,
      (body as { fields?: Record<string, string> }).fields ?? {},
    );
  }
  return body as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`/api${path}`, { credentials: 'same-origin' }));
}

export async function apiSend<T>(method: 'POST' | 'PATCH', path: string, body: unknown = {}): Promise<T> {
  return parse<T>(
    await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function apiForm<T>(path: string, form: FormData): Promise<{ status: number; data: T }> {
  const res = await fetch(`/api${path}`, { method: 'POST', body: form, credentials: 'same-origin' });
  return { status: res.status, data: await parse<T>(res) };
}

// --- Shapes returned by the admin API --------------------------------------------------------------

import type { NotificationKind, NotificationStatus, Priority, TicketStatus } from '../shared/constants';

export interface TicketListItem {
  id: string;
  reference: string;
  subject: string;
  priority: Priority;
  reporterEmail: string;
  affectedSystem: string;
  incidentDate: string;
  incidentTime: string;
  createdAt: string;
  status: TicketStatus;
  resolvedAt: string | null;
  hasNotificationProblem: boolean;
}

export interface TicketList {
  tickets: TicketListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Summary {
  total: number;
  open: number;
  working: number;
  done: number;
  openP1: number;
  ticketsWithNotificationProblems: number;
  configWarnings: string[];
}

export interface NotificationInfo {
  id: string;
  kind: NotificationKind;
  cycle: number;
  recipients: string[];
  status: NotificationStatus;
  lastError: string | null;
  attempts: number;
  providerMessageId: string | null;
  updatedAt: string;
}

export interface TicketDetail {
  id: string;
  reference: string;
  subject: string;
  priority: Priority;
  reporterEmail: string;
  description: string;
  incidentDate: string;
  incidentTime: string;
  affectedSystem: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  attachments: Array<{ id: string; name: string; contentType: string; sizeBytes: number; url: string }>;
  notifications: NotificationInfo[];
  events: Array<{
    id: string;
    type: string;
    fromStatus: TicketStatus | null;
    toStatus: TicketStatus | null;
    adminUsername: string | null;
    detail: string | null;
    createdAt: string;
  }>;
}

export interface StatusChangeResult {
  changed: boolean;
  status: TicketStatus;
  notification: { id: string; kind: NotificationKind; status: NotificationStatus; error?: string } | null;
}
