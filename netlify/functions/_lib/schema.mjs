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
];
