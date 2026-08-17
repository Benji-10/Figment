import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { db } from "./_lib/db.mjs";
import {
  getCharacter,
  ensureConversation,
  getRecentMessages,
  getRecentMemories,
  markActivity,
} from "./_lib/conversation.mjs";
import { generateStructured } from "./_lib/gemini.mjs";
import {
  buildChatSystemInstruction,
  chatResponseSchema,
  renderTranscript,
} from "./_lib/persona.mjs";

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

    const [history, memories] = await Promise.all([
      getRecentMessages(conversation.id),
      getRecentMemories(conversation.id),
    ]);

    const systemInstruction = buildChatSystemInstruction({
      character,
      memories,
      now: new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" }),
    });
    const input = renderTranscript(history, character.name);

    const aiResult = await generateStructured({
      systemInstruction,
      input,
      schema: chatResponseSchema,
    });

    const outgoingMessages = Array.isArray(aiResult.messages)
      ? aiResult.messages.filter((m) => typeof m === "string" && m.trim().length > 0)
      : [];

    const characterMessageRows = [];
    for (const text of outgoingMessages) {
      const [row] = await database.sql`
        INSERT INTO messages (conversation_id, sender, content, origin)
        VALUES (${conversation.id}, 'character', ${text.trim()}, 'chat')
        RETURNING *
      `;
      characterMessageRows.push(row);
    }

    let reaction = null;
    if (aiResult.reaction_emoji) {
      const [row] = await database.sql`
        INSERT INTO reactions (message_id, reactor, emoji)
        VALUES (${userMessageRow.id}, 'character', ${aiResult.reaction_emoji})
        ON CONFLICT (message_id, reactor) DO UPDATE SET emoji = EXCLUDED.emoji
        RETURNING *
      `;
      reaction = { messageId: String(row.message_id), emoji: row.emoji };
    }

    if (aiResult.new_memory) {
      await database.sql`
        INSERT INTO memories (conversation_id, content)
        VALUES (${conversation.id}, ${aiResult.new_memory})
      `;
    }

    await database.sql`
      UPDATE messages SET read_at = now()
      WHERE conversation_id = ${conversation.id} AND sender = 'user' AND read_at IS NULL
    `;
    await markActivity(conversation.id);

    return Response.json({
      userMessage: serializeMessage(userMessageRow),
      characterMessages: characterMessageRows.map(serializeMessage),
      reaction,
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
