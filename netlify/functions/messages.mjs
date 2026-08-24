import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { db } from "./_lib/db.mjs";
import { getConversationForUser } from "./_lib/conversation.mjs";

export default async (req, context) => {
  try {
    const user = await requireUser();

    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId");
    if (!conversationId) throw new HttpError(400, "conversationId is required.");

    const found = await getConversationForUser(user.id, conversationId);
    if (!found) throw new HttpError(404, "Conversation not found.");
    const { character, conversation } = found;

    const rawAfterId = url.searchParams.get("after_id");
    const afterId = rawAfterId && /^\d+$/.test(rawAfterId) ? rawAfterId : null;
    const limit = Math.min(
      Number(url.searchParams.get("limit")) || 60,
      200
    );

    const database = db();
    const rows = afterId
      ? await database.sql`
          SELECT m.*, r.emoji AS user_reaction, rc.emoji AS character_reaction
          FROM messages m
          LEFT JOIN reactions r ON r.message_id = m.id AND r.reactor = 'user'
          LEFT JOIN reactions rc ON rc.message_id = m.id AND rc.reactor = 'character'
          WHERE m.conversation_id = ${conversation.id} AND m.id > ${afterId}::bigint
          ORDER BY m.created_at ASC
        `
      : await database.sql`
          SELECT * FROM (
            SELECT m.*, r.emoji AS user_reaction, rc.emoji AS character_reaction
            FROM messages m
            LEFT JOIN reactions r ON r.message_id = m.id AND r.reactor = 'user'
            LEFT JOIN reactions rc ON rc.message_id = m.id AND rc.reactor = 'character'
            WHERE m.conversation_id = ${conversation.id}
            ORDER BY m.created_at DESC
            LIMIT ${limit}
          ) recent
          ORDER BY created_at ASC
        `;

    return Response.json({
      messages: rows.map(serializeMessage),
      characterName: character.name,
    });
  } catch (error) {
    return jsonError(error);
  }
};

function serializeMessage(m) {
  return {
    id: String(m.id),
    sender: m.sender,
    content: m.content,
    replyToMessageId: m.reply_to_message_id ? String(m.reply_to_message_id) : null,
    origin: m.origin,
    createdAt: m.created_at,
    readAt: m.read_at,
    userReaction: m.user_reaction || null,
    characterReaction: m.character_reaction || null,
  };
}

export const config = {
  path: "/api/messages",
  method: "GET",
};
