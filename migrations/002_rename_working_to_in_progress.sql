-- Rename the WORKING status to IN_PROGRESS.
-- Step 1: drop the old check constraint, update rows, add new constraint.

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;

UPDATE tickets SET status = 'IN_PROGRESS' WHERE status = 'WORKING';

ALTER TABLE tickets
  ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE'));

-- Step 2: patch historical event rows so the audit trail stays consistent.
UPDATE ticket_events SET from_status = 'IN_PROGRESS' WHERE from_status = 'WORKING';
UPDATE ticket_events SET to_status   = 'IN_PROGRESS' WHERE to_status   = 'WORKING';
