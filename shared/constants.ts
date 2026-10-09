// Values shared by the browser app and the server API.

export const PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_INFO: Record<
  Priority,
  { label: string; name: string; color: string; textColor: string; description: string }
> = {
  P1: {
    label: 'P1 - Emergency',
    name: 'EMERGENCY',
    color: '#DC2626',
    textColor: '#FFFFFF',
    description: 'A critical system is down or the business is stopped. Needs action right now.',
  },
  P2: {
    label: 'P2 - Immediate',
    name: 'IMMEDIATE',
    color: '#FACC15',
    textColor: '#1F2937',
    description: 'Something important is broken or degraded and needs attention today.',
  },
  P3: {
    label: 'P3 - Information',
    name: 'INFORMATION',
    color: '#2563EB',
    textColor: '#FFFFFF',
    description: 'A question, minor issue or request for information. No urgent impact.',
  },
};

export const STATUSES = ['OPEN', 'WORKING', 'DONE'] as const;
export type TicketStatus = (typeof STATUSES)[number];

export const STATUS_INFO: Record<TicketStatus, { label: string; color: string; textColor: string }> = {
  OPEN: { label: 'Open', color: '#DC2626', textColor: '#FFFFFF' },
  WORKING: { label: 'Working', color: '#EA580C', textColor: '#FFFFFF' },
  DONE: { label: 'Done', color: '#16A34A', textColor: '#FFFFFF' },
};

export const NOTIFICATION_KINDS = ['OPS_NEW_TICKET', 'REPORTER_CREATED', 'REPORTER_RESOLVED'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  OPS_NEW_TICKET: 'Operations team alert',
  REPORTER_CREATED: 'Reporter confirmation',
  REPORTER_RESOLVED: 'Reporter resolution notice',
};

// SENT means the email provider accepted the message. It does not prove delivery to the inbox.
export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_STATUS_LABEL: Record<NotificationStatus, string> = {
  PENDING: 'Pending',
  SENT: 'Accepted by email provider',
  FAILED: 'Failed',
  SKIPPED: 'Not sent',
};

// Screenshot limits. Vercel Functions accept request bodies up to 4.5 MB, so the whole
// submission (form fields plus all images) must stay under that. The browser shrinks large
// images before upload so normal screenshots fit comfortably.
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_TOTAL_UPLOAD_BYTES = 4 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export const FIELD_LIMITS = {
  subject: 150,
  description: 5000,
  affectedSystem: 120,
  email: 254,
} as const;
