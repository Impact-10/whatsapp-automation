CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS pets (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  pet_name TEXT NOT NULL,
  UNIQUE (client_id, pet_name)
);

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  vaccine TEXT NOT NULL,
  first_visit_date DATE NOT NULL,
  frequency_days INTEGER NOT NULL DEFAULT 30,
  last_visited_date DATE,
  next_due_date DATE NOT NULL,
  visited BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pet_id, vaccine)
);

CREATE TABLE IF NOT EXISTS visit_history (
  id SERIAL PRIMARY KEY,
  reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  visited_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  session_name TEXT PRIMARY KEY,
  session_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_queue (
  id BIGSERIAL PRIMARY KEY,
  reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  reminder_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  send_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone, reminder_date)
);

CREATE TABLE IF NOT EXISTS message_logs (
  id SERIAL PRIMARY KEY,
  queue_id BIGINT REFERENCES message_queue(id) ON DELETE SET NULL,
  reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_message_logs_phone_sent_at ON message_logs (phone, sent_at);
CREATE INDEX IF NOT EXISTS idx_message_queue_status_send_after ON message_queue (status, send_after, queued_at);
CREATE INDEX IF NOT EXISTS idx_reminders_next_due ON reminders (next_due_date);

-- ── Migrations (idempotent) ─────────────────────────────────────────────────

-- Add new columns if upgrading from old schema
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS first_visit_date DATE;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS frequency_days INTEGER NOT NULL DEFAULT 30;

-- Migrate existing rows: set first_visit_date from next_due_date
UPDATE reminders SET first_visit_date = next_due_date WHERE first_visit_date IS NULL;

-- Recalculate next_due_date for all rows based on the frequency model
UPDATE reminders
SET next_due_date = COALESCE(last_visited_date, first_visit_date) + (frequency_days * INTERVAL '1 day')
WHERE next_due_date = first_visit_date AND last_visited_date IS NULL;

-- Deduplicate: keep only one row per (pet_id, vaccine) before adding new unique constraint
DELETE FROM reminders
WHERE id NOT IN (
  SELECT MAX(id) FROM reminders GROUP BY pet_id, vaccine
);

-- Swap unique constraint: (pet_id, vaccine, next_due_date) → (pet_id, vaccine)
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_pet_id_vaccine_next_due_date_key;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reminders_pet_id_vaccine_key'
      AND conrelid = 'reminders'::regclass
  ) THEN
    ALTER TABLE reminders ADD CONSTRAINT reminders_pet_id_vaccine_key UNIQUE (pet_id, vaccine);
  END IF;
END $$;

-- Add follow_up_count column
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS follow_up_count INTEGER NOT NULL DEFAULT 0;

-- Create visit_history table if not exists (handled above, idempotent)

-- Seed default settings
INSERT INTO app_settings (key, value)
VALUES
  ('follow_up_interval_days', '5'),
  ('max_follow_ups', '3'),
  ('overdue_message_template', 'Hello {ownerName},

This is an overdue reminder from Vet Clinic.

{petName} was due for the {vaccine} vaccine on {nextDueDate} and is now overdue.

Please visit the clinic as soon as possible.

Thank you.')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_visit_history_reminder ON visit_history (reminder_id, visited_date DESC);
