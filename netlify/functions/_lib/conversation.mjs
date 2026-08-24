import { db } from "./db.mjs";

const HISTORY_LIMIT = 24; // how many recent messages we feed to the model
const MEMORY_LIMIT = 8; // how many recent memories we feed to the model

// Every character belongs to whoever created them, reached only through
// a conversation the requesting user actually owns — there's no more
// single global "the" character. ch.* first so the character's own `id`
// isn't shadowed by the conversation's `id`.
export async function getConversationForUser(userId, conversationId) {
  const database = db();
  const rows = await database.sql`
    SELECT ch.*,
           c.id AS conversation_id,
           c.state AS conversation_state,
           c.last_activity_at AS conversation_last_activity_at,
           c.last_heartbeat_at AS conversation_last_heartbeat_at
    FROM conversations c
    JOIN characters ch ON ch.id = c.character_id
    WHERE c.id = ${conversationId} AND c.user_id = ${userId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    character: row,
    conversation: {
      id: row.conversation_id,
      user_id: userId,
      state: row.conversation_state,
      last_activity_at: row.conversation_last_activity_at,
      last_heartbeat_at: row.conversation_last_heartbeat_at,
    },
  };
}

// The person's chat list: every character they have a conversation with
// (regardless of who created the character), most recently active first,
// with a preview of the last message.
export async function listConversationsForUser(userId) {
  const database = db();
  const rows = await database.sql`
    SELECT
      ch.id AS character_id, ch.name, ch.avatar_emoji, ch.tagline,
      ch.persona, ch.communication_style, ch.timezone,
      ch.current_activity, ch.current_mood,
      c.id AS conversation_id, c.last_activity_at,
      lm.content AS last_message_content,
      lm.sender AS last_message_sender,
      lm.created_at AS last_message_at
    FROM conversations c
    JOIN characters ch ON ch.id = c.character_id
    LEFT JOIN LATERAL (
      SELECT content, sender, created_at FROM messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE c.user_id = ${userId}
    ORDER BY c.last_activity_at DESC
  `;
  return rows;
}

// Creates (or returns the existing) conversation between this user and
// this character. Used right after a new character is saved.
export async function ensureConversation(userId, characterId) {
  const database = db();

  const existing = await database.sql`
    SELECT * FROM conversations
    WHERE user_id = ${userId} AND character_id = ${characterId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return existing[0];
  }

  const created = await database.sql`
    INSERT INTO conversations (user_id, character_id)
    VALUES (${userId}, ${characterId})
    ON CONFLICT (user_id, character_id) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING *
  `;
  return created[0];
}

export async function getRecentMessages(conversationId, limit = HISTORY_LIMIT) {
  const database = db();
  const rows = await database.sql`
    SELECT m.*,
           r.emoji AS user_reaction,
           rc.emoji AS character_reaction
    FROM messages m
    LEFT JOIN reactions r ON r.message_id = m.id AND r.reactor = 'user'
    LEFT JOIN reactions rc ON rc.message_id = m.id AND rc.reactor = 'character'
    WHERE m.conversation_id = ${conversationId}
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}

export async function getRecentMemories(conversationId, limit = MEMORY_LIMIT) {
  const database = db();
  const rows = await database.sql`
    SELECT * FROM memories
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}

export async function touchConversation(conversationId, { heartbeat = false } = {}) {
  const database = db();
  if (heartbeat) {
    await database.sql`
      UPDATE conversations
      SET last_heartbeat_at = now()
      WHERE id = ${conversationId}
    `;
  } else {
    await database.sql`
      UPDATE conversations
      SET last_activity_at = now(), state = 'active'
      WHERE id = ${conversationId}
    `;
  }
}

export async function markActivity(conversationId) {
  const database = db();
  await database.sql`
    UPDATE conversations
    SET last_activity_at = now(), last_heartbeat_at = now(), state = 'active'
    WHERE id = ${conversationId}
  `;
}
