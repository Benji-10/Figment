import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { db } from "./_lib/db.mjs";
import { getCharacter, ensureConversation } from "./_lib/conversation.mjs";
import { syncCalendar, getActiveEvent } from "./_lib/calendar.mjs";
import { deliverChatReply, deliverAckIfWarranted } from "./_lib/reply.mjs";

const MAX_MESSAGE_LENGTH = 2000;

export default async (req, context) => {
  try {
    const user = await requireUser();

    let body;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Expected a JSON body.");
    }

    const content = (body.content || "").trim();
    if (!content) throw new HttpError(400, "Message can't be empty.");
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(400, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
    }

    const character = await getCharacter();
    const conversation = await ensureConversation(user.id, character.id);
    const database = db();

    const replyToId = await resolveReplyTo(conversation.id, body.replyToMessageId);

    const [userMessageRow] = await database.sql`
      INSERT INTO messages (conversation_id, sender, content, reply_to_message_id, origin)
      VALUES (${conversation.id}, 'user', ${content}, ${replyToId}, 'chat')
      RETURNING *
    `;

    // Response-session gating (spec §7-8): if the character is in a
    // low-availability calendar event, don't generate the full reply now.
    // At most send a short acknowledgment (only if this message seems
    // urgent enough to warrant one), and leave the rest of the pending
    // messages for the heartbeat to answer as one batched reply once the
    // character is free again.
    await syncCalendar(character.id);
    const activeEvent = await getActiveEvent(character.id);

    let characterMessageRows = [];
    let reaction = null;
    const busy = Boolean(activeEvent?.busy);

    if (busy) {
      const ack = await deliverAckIfWarranted({ character, conversation, activeEvent });
      if (ack) characterMessageRows = [ack];
      await database.sql`
        UPDATE conversations SET last_activity_at = now() WHERE id = ${conversation.id}
      `;
    } else {
      const result = await deliverChatReply({ character, conversation });
      characterMessageRows = result.characterMessageRows;
      reaction = result.reaction;
    }

    return Response.json({
      userMessage: serializeMessage(userMessageRow),
      characterMessages: characterMessageRows.map(serializeMessage),
      reaction,
      busy,
    });
  } catch (error) {
    return jsonError(error);
  }
};

async function resolveReplyTo(conversationId, rawId) {
  if (!rawId) return null;
  const database = db();
  const rows = await database.sql`
    SELECT id FROM messages WHERE id = ${rawId}::bigint AND conversation_id = ${conversationId} LIMIT 1
  `;
  return rows.length > 0 ? rows[0].id : null;
}

function serializeMessage(m) {
  return {
    id: String(m.id),
    sender: m.sender,
    content: m.content,
    replyToMessageId: m.reply_to_message_id ? String(m.reply_to_message_id) : null,
    origin: m.origin,
    createdAt: m.created_at,
    readAt: m.read_at,
  };
}

export const config = {
  path: "/api/chat",
  method: "POST",
};
