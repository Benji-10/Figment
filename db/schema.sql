-- Optional. The app creates this schema automatically on its first
-- request (see netlify/functions/_lib/schema.mjs), so you do not need to
-- run this manually. No character content is seeded here — characters
-- are created at runtime (AI-generated or user-authored) via the app's
-- "+ New Character" flow, never hardcoded.
-- (Generated from schema.mjs so the two never drift apart.)

CREATE TABLE IF NOT EXISTS app_users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL,
      display_name  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

CREATE TABLE IF NOT EXISTS characters (
      id                   SERIAL PRIMARY KEY,
      slug                 TEXT,
      name                 TEXT NOT NULL,
      avatar_emoji         TEXT NOT NULL DEFAULT '🙂',
      tagline              TEXT NOT NULL DEFAULT '',
      persona              TEXT NOT NULL,
      communication_style  TEXT NOT NULL,
      timezone             TEXT NOT NULL DEFAULT 'America/Chicago',
      current_activity     TEXT NOT NULL DEFAULT 'just getting started',
      current_mood         TEXT NOT NULL DEFAULT 'settling in',
      status_updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by           TEXT REFERENCES app_users(id) ON DELETE SET NULL,
      last_planned_at      TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

ALTER TABLE characters ADD COLUMN IF NOT EXISTS last_planned_at TIMESTAMPTZ;

ALTER TABLE characters ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Chicago';

ALTER TABLE characters ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL;

ALTER TABLE characters ALTER COLUMN slug DROP NOT NULL;

ALTER TABLE characters DROP CONSTRAINT IF EXISTS characters_slug_key;

CREATE TABLE IF NOT EXISTS conversations (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      character_id       INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      state              TEXT NOT NULL DEFAULT 'active',
      last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_heartbeat_at  TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, character_id)
    );

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

CREATE INDEX IF NOT EXISTS idx_conversations_last_activity ON conversations(last_activity_at DESC);

CREATE TABLE IF NOT EXISTS messages (
      id                    BIGSERIAL PRIMARY KEY,
      conversation_id       UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender                TEXT NOT NULL CHECK (sender IN ('user', 'character')),
      content               TEXT NOT NULL,
      reply_to_message_id   BIGINT REFERENCES messages(id) ON DELETE SET NULL,
      origin                TEXT NOT NULL DEFAULT 'chat',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at               TIMESTAMPTZ
    );

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS reactions (
      id            BIGSERIAL PRIMARY KEY,
      message_id    BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reactor       TEXT NOT NULL CHECK (reactor IN ('user', 'character')),
      emoji         TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (message_id, reactor)
    );

CREATE TABLE IF NOT EXISTS memories (
      id                BIGSERIAL PRIMARY KEY,
      conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content           TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recurring_events (
      id                  BIGSERIAL PRIMARY KEY,
      character_id        INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      slug                TEXT NOT NULL,
      title               TEXT NOT NULL,
      day_of_week         INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
      start_time_of_day   TIME NOT NULL,
      end_time_of_day     TIME NOT NULL,
      details             TEXT NOT NULL DEFAULT '',
      location            TEXT,
      availability        INTEGER NOT NULL DEFAULT 100 CHECK (availability BETWEEN 0 AND 100),
      active              BOOLEAN NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (character_id, slug)
    );

ALTER TABLE recurring_events ADD COLUMN IF NOT EXISTS availability INTEGER NOT NULL DEFAULT 100 CHECK (availability BETWEEN 0 AND 100);

ALTER TABLE recurring_events DROP COLUMN IF EXISTS busy;

CREATE TABLE IF NOT EXISTS calendar_events (
      id                   BIGSERIAL PRIMARY KEY,
      character_id         INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title                TEXT NOT NULL,
      start_time           TIMESTAMPTZ NOT NULL,
      end_time             TIMESTAMPTZ NOT NULL,
      status               TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
      location             TEXT,
      details              TEXT NOT NULL DEFAULT '',
      source               TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('recurring', 'planned', 'generated', 'inferred')),
      availability         INTEGER NOT NULL DEFAULT 100 CHECK (availability BETWEEN 0 AND 100),
      recurring_event_id   BIGINT REFERENCES recurring_events(id) ON DELETE SET NULL,
      recurrence_date      DATE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (recurring_event_id, recurrence_date)
    );

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS availability INTEGER NOT NULL DEFAULT 100 CHECK (availability BETWEEN 0 AND 100);

ALTER TABLE calendar_events DROP COLUMN IF EXISTS busy;

CREATE INDEX IF NOT EXISTS idx_calendar_events_character_time ON calendar_events(character_id, start_time);
