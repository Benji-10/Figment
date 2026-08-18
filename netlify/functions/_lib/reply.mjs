// Everything involved in actually generating and applying a character
// turn lives here, so chat.mjs (immediate replies) and heartbeat.mjs
// (deferred "response session" replies + spontaneous check-ins) share one
// implementation instead of drifting apart.

import { db } from "./db.mjs";
import { getRecentMessages, getRecentMemories, markActivity } from "./conversation.mjs";
import {
  syncCalendar,
  getActiveEvent,
  getUpcomingEvents,
  describeCurrentActivity,
  formatCalendarForPrompt,
  applyCalendarAction,
} from "./calendar.mjs";
import { generateStructured } from "./gemini.mjs";
import {
  buildChatSystemInstruction,
  chatResponseSchema,
  buildHeartbeatSystemInstruction,
  heartbeatResponseSchema,
  buildAckSystemInstruction,
  ackResponseSchema,
  buildConflictResolutionInstruction,
  conflictResolutionSchema,
  renderTranscript,
} from "./persona.mjs";

function nowLabel() {
  return new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
}

function safeFollowUp(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Applies a proposed calendar_action; if it conflicts with something
// already on the calendar, makes one follow-up call asking the character
// to resolve it in-character (spec §3's "clash flow"), optionally
// producing a short follow-up text ("oh wait, I'll skip X...").
async function resolveCalendarAction({ character, action, label }) {
  if (!action || !action.action) {
    return { result: { status: "ignored" }, followUpMessage: null };
  }

  let result = await applyCalendarAction(character.id, action);

  if (result.status !== "conflict") {
    return { result, followUpMessage: null };
  }

  let decision;
  try {
    const instruction = buildConflictResolutionInstruction({
      character,
      proposed: result.proposed,
      conflictingEvents: result.conflictingEvents,
      now: label,
    });
    decision = await generateStructured({
      systemInstruction: instruction,
      input: "Decide how to resolve this scheduling conflict.",
      schema: conflictResolutionSchema,
    });
  } catch (err) {
    console.error("Conflict resolution call failed, defaulting to abandoning the new plan:", err);
    decision = { resolution: "abandon_new_plan", follow_up_message: null };
  }

  if (decision.resolution === "proceed_and_cancel_conflicting") {
    result = await applyCalendarAction(character.id, action, {
      overrideConflicts: true,
      cancelEventIds: result.conflictingEvents.map((e) => e.id),
    });
  } else {
    result = { status: "abandoned", action: result.action };
  }

  return { result, followUpMessage: safeFollowUp(decision.follow_up_message) };
}

async function insertCharacterMessage(database, conversationId, text, origin) {
  const [row] = await database.sql`
    INSERT INTO messages (conversation_id, sender, content, origin)
    VALUES (${conversationId}, 'character', ${text}, ${origin})
    RETURNING *
  `;
  return row;
}

// The full reply pipeline: covers every unread message in the
// conversation at once (the "response session" — spec §8), whether
// called synchronously (character is free right now) or from the
// heartbeat once a busy period ends.
export async function deliverChatReply({ character, conversation }) {
  const database = db();

  await syncCalendar(character.id);
  const [activeEvent, upcoming, history, memories] = await Promise.all([
    getActiveEvent(character.id),
    getUpcomingEvents(character.id),
    getRecentMessages(conversation.id),
    getRecentMemories(conversation.id),
  ]);

  const label = nowLabel();
  const calendarText = formatCalendarForPrompt({ activeEvent, upcoming });
  const effectiveCharacter = {
    ...character,
    current_activity: describeCurrentActivity(character, activeEvent),
  };

  const systemInstruction = buildChatSystemInstruction({
    character: effectiveCharacter,
    memories,
    now: label,
    calendarText,
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
    characterMessageRows.push(await insertCharacterMessage(database, conversation.id, text.trim(), "chat"));
  }

  let reaction = null;
  if (aiResult.reaction_emoji) {
    const [latestUnread] = await database.sql`
      SELECT id FROM messages
      WHERE conversation_id = ${conversation.id} AND sender = 'user' AND read_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;
    if (latestUnread) {
      const [row] = await database.sql`
        INSERT INTO reactions (message_id, reactor, emoji)
        VALUES (${latestUnread.id}, 'character', ${aiResult.reaction_emoji})
        ON CONFLICT (message_id, reactor) DO UPDATE SET emoji = EXCLUDED.emoji
        RETURNING *
      `;
      reaction = { messageId: String(row.message_id), emoji: row.emoji };
    }
  }

  if (aiResult.new_memory) {
    await database.sql`
      INSERT INTO memories (conversation_id, content) VALUES (${conversation.id}, ${aiResult.new_memory})
    `;
  }

  const { followUpMessage } = await resolveCalendarAction({
    character,
    action: aiResult.calendar_action,
    label,
  });
  if (followUpMessage) {
    characterMessageRows.push(
      await insertCharacterMessage(database, conversation.id, followUpMessage, "chat")
    );
  }

  await database.sql`
    UPDATE messages SET read_at = now()
    WHERE conversation_id = ${conversation.id} AND sender = 'user' AND read_at IS NULL
  `;
  await markActivity(conversation.id);

  return { characterMessageRows, reaction };
}

// The heartbeat's "nothing pending" path: decide whether to spontaneously
// text, and/or quietly touch the calendar, without any user message to
// respond to. Skips entirely if the character is currently busy.
export async function deliverSpontaneousCheck({ character, conversation }) {
  await syncCalendar(character.id);
  const activeEvent = await getActiveEvent(character.id);

  if (activeEvent?.busy) {
    return { messaged: false, reason: "busy" };
  }

  const database = db();
  const [upcoming, history, memories] = await Promise.all([
    getUpcomingEvents(character.id),
    getRecentMessages(conversation.id, 12),
    getRecentMemories(conversation.id),
  ]);

  const label = nowLabel();
  const calendarText = formatCalendarForPrompt({ activeEvent, upcoming });
  const effectiveCharacter = {
    ...character,
    current_activity: describeCurrentActivity(character, activeEvent),
  };

  const systemInstruction = buildHeartbeatSystemInstruction({
    character: effectiveCharacter,
    memories,
    now: label,
    calendarText,
  });
  const input = renderTranscript(history, character.name);

  const aiResult = await generateStructured({
    systemInstruction,
    input,
    schema: heartbeatResponseSchema,
  });

  const outgoing = Array.isArray(aiResult.messages)
    ? aiResult.messages.filter((m) => typeof m === "string" && m.trim().length > 0)
    : [];

  let messagedCount = 0;
  if (aiResult.should_message && outgoing.length > 0) {
    for (const text of outgoing) {
      await insertCharacterMessage(database, conversation.id, text.trim(), "heartbeat");
      messagedCount++;
    }
  }

  const { followUpMessage } = await resolveCalendarAction({
    character,
    action: aiResult.calendar_action,
    label,
  });
  if (followUpMessage) {
    await insertCharacterMessage(database, conversation.id, followUpMessage, "heartbeat");
    messagedCount++;
  }

  if (messagedCount > 0) {
    await database.sql`
      UPDATE conversations SET last_activity_at = now(), last_heartbeat_at = now(), state = 'active'
      WHERE id = ${conversation.id}
    `;
  } else {
    await database.sql`UPDATE conversations SET last_heartbeat_at = now() WHERE id = ${conversation.id}`;
  }

  return { messaged: messagedCount > 0, count: messagedCount };
}

// Called synchronously when a message arrives while the character is
// busy. Sends at most one short "saw this, will reply properly later"
// line, and only if the message seems worth interrupting for — otherwise
// stays silent and leaves the message for deliverChatReply() to pick up
// once the busy period ends (via the heartbeat).
export async function deliverAckIfWarranted({ character, conversation, activeEvent }) {
  const database = db();

  const [alreadyAcked] = await database.sql`
    SELECT id FROM messages
    WHERE conversation_id = ${conversation.id} AND origin = 'ack'
      AND created_at >= ${new Date(activeEvent.start_time).toISOString()}
    LIMIT 1
  `;
  if (alreadyAcked) return null;

  const pending = await database.sql`
    SELECT * FROM messages
    WHERE conversation_id = ${conversation.id} AND sender = 'user' AND read_at IS NULL
    ORDER BY created_at ASC
  `;
  if (pending.length === 0) return null;

  const systemInstruction = buildAckSystemInstruction({ character, activeEvent, now: nowLabel() });
  const input = pending.map((m) => `Friend: ${m.content}`).join("\n");

  const aiResult = await generateStructured({
    systemInstruction,
    input,
    schema: ackResponseSchema,
  });

  if (!aiResult.should_acknowledge || typeof aiResult.acknowledgment !== "string") return null;
  const text = aiResult.acknowledgment.trim();
  if (!text) return null;

  return insertCharacterMessage(database, conversation.id, text, "ack");
}
