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
  formatNowLabel,
  applyCalendarAction,
  getRecentTransitions,
  rollEngagement,
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

async function insertCharacterMessage(database, conversationId, text, origin, replyToId = null) {
  const [row] = await database.sql`
    INSERT INTO messages (conversation_id, sender, content, origin, reply_to_message_id)
    VALUES (${conversationId}, 'character', ${text}, ${origin}, ${replyToId})
    RETURNING *
  `;
  return row;
}

// Validates that a model-supplied reply_to_id actually refers to a real
// message in this conversation before we trust it — never take the
// model's word for a foreign key.
async function resolveReplyTarget(database, conversationId, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await database.sql`
    SELECT id FROM messages WHERE id = ${id} AND conversation_id = ${conversationId} LIMIT 1
  `;
  return rows.length > 0 ? rows[0].id : null;
}

function describeTransition(ev) {
  const verb = ev.status === "active" ? "just started" : "just ended";
  return `"${ev.title}" ${verb}${ev.details ? ` (${ev.details})` : ""}`;
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

  const label = formatNowLabel();
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
    ? aiResult.messages.filter((m) => m && typeof m.text === "string" && m.text.trim().length > 0)
    : [];

  const characterMessageRows = [];
  for (const msg of outgoingMessages) {
    const replyToId = await resolveReplyTarget(database, conversation.id, msg.reply_to_id);
    characterMessageRows.push(
      await insertCharacterMessage(database, conversation.id, msg.text.trim(), "chat", replyToId)
    );
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

// The heartbeat's "nothing pending" path. Only actually asks the model
// anything if a calendar event transitioned (started/ended) since the
// last check — otherwise it's a deterministic, free no-op. This keeps
// spontaneous messages tied to something real happening rather than
// firing on a timer regardless of state.
export async function deliverSpontaneousCheck({ character, conversation }) {
  await syncCalendar(character.id);
  const activeEvent = await getActiveEvent(character.id);

  if (!rollEngagement(activeEvent ? activeEvent.availability : 100)) {
    return { messaged: false, reason: "unavailable" };
  }

  const since = conversation.last_heartbeat_at || new Date(Date.now() - 60 * 60 * 1000);
  const transitions = await getRecentTransitions(character.id, since);
  if (transitions.length === 0) {
    return { messaged: false, reason: "no_trigger" };
  }
  const trigger = transitions.slice(0, 2).map(describeTransition).join("; ");

  const database = db();
  const [upcoming, history, memories] = await Promise.all([
    getUpcomingEvents(character.id),
    getRecentMessages(conversation.id, 12),
    getRecentMemories(conversation.id),
  ]);

  const label = formatNowLabel();
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
    trigger,
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

  const systemInstruction = buildAckSystemInstruction({ character, activeEvent, now: formatNowLabel() });
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
