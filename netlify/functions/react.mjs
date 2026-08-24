import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { db } from "./_lib/db.mjs";
import { getConversationForUser } from "./_lib/conversation.mjs";

export default async (req, context) => {
  try {
    const user = await requireUser();

    let body;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Expected a JSON body.");
    }

    const conversationId = body.conversationId;
    const messageId = body.messageId;
    const emoji = (body.emoji || "").trim();
    if (!conversationId) throw new HttpError(400, "conversationId is required.");
    if (!messageId || !emoji || !/^\d+$/.test(String(messageId))) {
      throw new HttpError(400, "A valid messageId and emoji are required.");
    }

    const found = await getConversationForUser(user.id, conversationId);
    if (!found) throw new HttpError(404, "Conversation not found.");
    const { conversation } = found;
    const database = db();

    // Make sure this message actually belongs to the requesting user's conversation.
    const owned = await database.sql`
      SELECT id FROM messages WHERE id = ${messageId}::bigint AND conversation_id = ${conversation.id} LIMIT 1
    `;
    if (owned.length === 0) {
      throw new HttpError(404, "Message not found.");
    }

    const existing = await database.sql`
      SELECT * FROM reactions WHERE message_id = ${messageId}::bigint AND reactor = 'user' LIMIT 1
    `;

    if (existing.length > 0 && existing[0].emoji === emoji) {
      // Tapping the same emoji again removes it.
      await database.sql`DELETE FROM reactions WHERE id = ${existing[0].id}`;
      return Response.json({ messageId: String(messageId), emoji: null });
    }

    await database.sql`
      INSERT INTO reactions (message_id, reactor, emoji)
      VALUES (${messageId}::bigint, 'user', ${emoji})
      ON CONFLICT (message_id, reactor) DO UPDATE SET emoji = EXCLUDED.emoji
    `;

    return Response.json({ messageId: String(messageId), emoji });
  } catch (error) {
    return jsonError(error);
  }
};

export const config = {
  path: "/api/react",
  method: "POST",
};
