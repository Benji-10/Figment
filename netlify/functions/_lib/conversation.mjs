import { db } from "./db.mjs";

const CHARACTER_SLUG = process.env.CHARACTER_SLUG || "sam";
const HISTORY_LIMIT = 24; // how many recent messages we feed to the model
const MEMORY_LIMIT = 8; // how many recent memories we feed to the model

export async function getCharacter() {
  const database = db();
  const rows = await database.sql`
    SELECT * FROM characters WHERE slug = ${CHARACTER_SLUG} LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error(
      `No character with slug "${CHARACTER_SLUG}" found. Did the 0001_init migration run?`
    );
  }
  return rows[0];
}

// Finds (or lazily creates) the single conversation between this user
// and the default character. Basic version supports one character;
// see README for how to extend this to multiple characters.
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
