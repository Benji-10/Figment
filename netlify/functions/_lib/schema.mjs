// Schema for the app, applied by the app itself (see ensureSchema() in
// db.mjs) rather than through Netlify's built-in migration runner — that
// runner requires the "Database" account feature, which isn't available on
// every plan. This way the app works with *any* Postgres connection string,
// Neon or otherwise.
//
// Each entry is a single statement (the Neon HTTP driver's sql.query()
// takes one statement at a time). Safe to run repeatedly: everything is
// IF NOT EXISTS / ON CONFLICT DO NOTHING.

const DEFAULT_PERSONA =
  "You are a 23-year-old grad student, sociable and a little scattered. You genuinely like your friends and get excited about small stuff (a good song, a weird dream, decent weather). You procrastinate, you overthink texts sometimes, and you have your own life going on -- classes, a part-time job, a group chat that is always chaotic. You are warm and curious about people but you are not endlessly available or agreeable; you have moods and a life outside this conversation.";

const DEFAULT_STYLE =
  "Lowercase most of the time, casual punctuation, occasional typo left uncorrected, sparing but genuine emoji use (not one on every message). Sends short messages more often than long ones, and will split a thought into 2-3 quick texts instead of one paragraph when that is how the thought actually comes out.";

export const SCHEMA_STATEMENTS = [
  {
    text: `CREATE TABLE IF NOT EXISTS app_users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL,
      display_name  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    text: `CREATE TABLE IF NOT EXISTS characters (
      id                   SERIAL PRIMARY KEY,
      slug                 TEXT UNIQUE NOT NULL,
      name                 TEXT NOT NULL,
      avatar_emoji         TEXT NOT NULL DEFAULT '🙂',
      tagline              TEXT NOT NULL DEFAULT '',
      persona              TEXT NOT NULL,
      communication_style  TEXT NOT NULL,
      current_activity     TEXT NOT NULL DEFAULT 'just going about their day',
      current_mood         TEXT NOT NULL DEFAULT 'pretty normal',
      status_updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    text: `CREATE TABLE IF NOT EXISTS conversations (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      character_id       INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      state              TEXT NOT NULL DEFAULT 'active',
      last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_heartbeat_at  TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, character_id)
    )`,
  },
  { text: `CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id)` },
  { text: `CREATE INDEX IF NOT EXISTS idx_conversations_last_activity ON conversations(last_activity_at DESC)` },
  {
    text: `CREATE TABLE IF NOT EXISTS messages (
      id                    BIGSERIAL PRIMARY KEY,
      conversation_id       UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender                TEXT NOT NULL CHECK (sender IN ('user', 'character')),
      content               TEXT NOT NULL,
      reply_to_message_id   BIGINT REFERENCES messages(id) ON DELETE SET NULL,
      origin                TEXT NOT NULL DEFAULT 'chat',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at               TIMESTAMPTZ
    )`,
  },
  { text: `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)` },
  {
    text: `CREATE TABLE IF NOT EXISTS reactions (
      id            BIGSERIAL PRIMARY KEY,
      message_id    BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reactor       TEXT NOT NULL CHECK (reactor IN ('user', 'character')),
      emoji         TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (message_id, reactor)
    )`,
  },
  {
    text: `CREATE TABLE IF NOT EXISTS memories (
      id                BIGSERIAL PRIMARY KEY,
      conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content           TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  { text: `CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id, created_at DESC)` },
  {
    text: `CREATE TABLE IF NOT EXISTS recurring_events (
      id                  BIGSERIAL PRIMARY KEY,
      character_id        INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      slug                TEXT NOT NULL,
      title               TEXT NOT NULL,
      day_of_week         INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
      start_time_of_day   TIME NOT NULL,
      end_time_of_day     TIME NOT NULL,
      details             TEXT NOT NULL DEFAULT '',
      location            TEXT,
      busy                BOOLEAN NOT NULL DEFAULT false,
      active              BOOLEAN NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (character_id, slug)
    )`,
  },
  {
    text: `CREATE TABLE IF NOT EXISTS calendar_events (
      id                   BIGSERIAL PRIMARY KEY,
      character_id         INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title                TEXT NOT NULL,
      start_time           TIMESTAMPTZ NOT NULL,
      end_time             TIMESTAMPTZ NOT NULL,
      status               TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
      location             TEXT,
      details              TEXT NOT NULL DEFAULT '',
      source               TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('recurring', 'planned', 'generated', 'inferred')),
      busy                 BOOLEAN NOT NULL DEFAULT false,
      recurring_event_id   BIGINT REFERENCES recurring_events(id) ON DELETE SET NULL,
      recurrence_date      DATE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (recurring_event_id, recurrence_date)
    )`,
  },
  { text: `CREATE INDEX IF NOT EXISTS idx_calendar_events_character_time ON calendar_events(character_id, start_time)` },
  {
    text: `INSERT INTO characters
      (slug, name, avatar_emoji, tagline, persona, communication_style, current_activity, current_mood)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (slug) DO NOTHING`,
    params: [
      "sam",
      "Sam",
      "🌙",
      "probably procrastinating something right now",
      DEFAULT_PERSONA,
      DEFAULT_STYLE,
      "half-watching a show, half-doing laundry",
      "pretty relaxed, a little tired",
    ],
  },
  // Seed a believable weekly rhythm for Sam. Recurring templates are
  // materialized into concrete calendar_events by ensureCalendar()
  // (see _lib/calendar.mjs) — nothing else needs to run these.
  ...seedRecurringEvent("seminar-mon", "Methods seminar", 1, "10:00", "11:30", {
    details: "a required grad seminar, kind of dry but the prof notices who skips",
    location: "Social Sciences building",
    busy: true,
  }),
  ...seedRecurringEvent("seminar-wed", "Methods seminar", 3, "10:00", "11:30", {
    details: "a required grad seminar, kind of dry but the prof notices who skips",
    location: "Social Sciences building",
    busy: true,
  }),
  ...seedRecurringEvent("seminar-fri", "Methods seminar", 5, "10:00", "11:30", {
    details: "a required grad seminar, kind of dry but the prof notices who skips",
    location: "Social Sciences building",
    busy: true,
  }),
  ...seedRecurringEvent("shift-tue", "coffee shop shift", 2, "14:00", "18:30", {
    details: "part-time barista shift, decent tips, exhausting on your feet by the end",
    location: "the cafe",
    busy: true,
  }),
  ...seedRecurringEvent("shift-thu", "coffee shop shift", 4, "14:00", "18:30", {
    details: "part-time barista shift, decent tips, exhausting on your feet by the end",
    location: "the cafe",
    busy: true,
  }),
  ...seedRecurringEvent("family-call-sun", "family call", 0, "19:00", "19:30", {
    details: "weekly call with mom, sometimes runs long, easy to text through",
    location: null,
    busy: false,
  }),
];

function seedRecurringEvent(slug, title, dayOfWeek, startTime, endTime, { details, location, busy }) {
  return [
    {
      text: `INSERT INTO recurring_events
        (character_id, slug, title, day_of_week, start_time_of_day, end_time_of_day, details, location, busy)
        VALUES ((SELECT id FROM characters WHERE slug = $1), $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (character_id, slug) DO NOTHING`,
      params: ["sam", slug, title, dayOfWeek, startTime, endTime, details || "", location || null, !!busy],
    },
  ];
}
