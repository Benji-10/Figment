import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { db } from "./_lib/db.mjs";
import { getConversationForUser } from "./_lib/conversation.mjs";
import { syncCalendar, getActiveEvent, rollEngagement } from "./_lib/calendar.mjs";
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

    const conversationId = body.conversationId;
    if (!conversationId) throw new HttpError(400, "conversationId is required.");

    const content = (body.content || "").trim();
    if (!content) throw new HttpError(400, "Message can't be empty.");
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(400, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
    }

    const found = await getConversationForUser(user.id, conversationId);
    if (!found) throw new HttpError(404, "Conversation not found.");
    const { character, conversation } = found;

    const database = db();
    const replyToId = await resolveReplyTo(conversation.id, body.replyToMessageId);

    const [userMessageRow] = await database.sql`
      INSERT INTO messages (conversation_id, sender, content, reply_to_message_id, origin)
      VALUES (${conversation.id}, 'user', ${content}, ${replyToId}, 'chat')
      RETURNING *
    `;

    // Response-session gating (spec §7-8): each event has a 0-100
    // "availability" score rather than a hard busy/free flag, so this is
    // a weighted coin flip, not a wall — even during a low-availability
    // event there's some chance of a normal, immediate reply, and during
    // a high-availability one (most of the day, via the life-planner)
    // it's close to guaranteed. When the roll doesn't land on "respond
    // now", at most a short acknowledgment goes out (only if this
    // message seems urgent enough to warrant one), and the rest of the
    // pending messages wait for the heartbeat to answer as one batched
    // reply once the character is free again.
    await syncCalendar(character.id, character.timezone);
    const activeEvent = await getActiveEvent(character.id);
    const respondNow = rollEngagement(activeEvent ? activeEvent.availability : 100);

    let characterMessageRows = [];
    let reaction = null;

    if (!respondNow && activeEvent) {
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
      busy: !respondNow && Boolean(activeEvent),
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
