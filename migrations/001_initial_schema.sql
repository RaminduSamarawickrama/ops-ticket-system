-- Operations Support Portal: initial schema (PostgreSQL 13+; gen_random_uuid is built in).

CREATE TABLE admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL UNIQUE CHECK (username = lower(username) AND char_length(username) BETWEEN 3 AND 64),
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- Only a SHA-256 hash of the session token is stored, so a database leak does not leak live sessions.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  admin_id    uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- One row per year; incremented atomically to produce OPS-YYYY-NNNNN references.
CREATE TABLE ticket_counters (
  year        integer PRIMARY KEY,
  last_value  integer NOT NULL CHECK (last_value > 0)
);

CREATE TABLE tickets (
  id                uuid PRIMARY KEY,
  reference         text NOT NULL UNIQUE,
  submission_id     uuid UNIQUE,  -- browser-generated key that makes double submits harmless
  subject           text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
  priority          text NOT NULL CHECK (priority IN ('P1', 'P2', 'P3')),
  reporter_email    text NOT NULL CHECK (char_length(reporter_email) BETWEEN 3 AND 254),
  description       text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  incident_date     date NOT NULL,
  incident_time     time NOT NULL,
  affected_system   text NOT NULL CHECK (char_length(affected_system) BETWEEN 1 AND 120),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE')),
  resolution_count  integer NOT NULL DEFAULT 0,  -- how many times the ticket has been marked Done
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  CHECK ((status = 'DONE') = (resolved_at IS NOT NULL))
);
CREATE INDEX tickets_status_idx ON tickets (status);
CREATE INDEX tickets_created_at_idx ON tickets (created_at DESC);
CREATE INDEX tickets_priority_idx ON tickets (priority);

CREATE TABLE attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  storage_key    text NOT NULL UNIQUE,
  original_name  text NOT NULL,
  content_type   text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_ticket_id_idx ON attachments (ticket_id);

-- One row per email the system should send. The unique key stops duplicate resolution emails:
-- each time a ticket is marked Done its resolution_count increases and becomes the new cycle.
CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id            uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('OPS_NEW_TICKET', 'REPORTER_CREATED', 'REPORTER_RESOLVED')),
  cycle                integer NOT NULL DEFAULT 0,
  recipients           text[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  provider_message_id  text,
  last_error           text,
  attempts             integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, kind, cycle)
);
CREATE INDEX notifications_status_idx ON notifications (status);

-- Audit trail: creation, status changes (with the admin responsible), resolutions, reopenings,
-- and email failures/retries.
CREATE TABLE ticket_events (
  id              bigserial PRIMARY KEY,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN (
                    'CREATED', 'STATUS_CHANGED', 'RESOLVED', 'REOPENED',
                    'NOTIFICATION_FAILED', 'NOTIFICATION_RETRIED')),
  from_status     text,
  to_status       text,
  admin_id        uuid REFERENCES admins(id) ON DELETE SET NULL,
  admin_username  text,  -- kept even if the admin account is later removed
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_events_ticket_id_idx ON ticket_events (ticket_id, created_at);

-- Fixed-window counters for login and public submission rate limiting.
-- Keys are SHA-256 hashes, so raw IP addresses are never stored.
CREATE TABLE rate_limits (
  bucket        text NOT NULL,
  key_hash      text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL,
  PRIMARY KEY (bucket, key_hash, window_start)
);
CREATE INDEX rate_limits_window_start_idx ON rate_limits (window_start);
