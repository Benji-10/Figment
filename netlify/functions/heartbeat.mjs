// Runs on a schedule (see `config.schedule` below). Each candidate
// conversation gets one of three treatments:
//
//   1. Unread user messages are waiting AND the character is free right
//      now  -> deliver one batched reply covering all of them at once
//      (the "response session" from spec §8 — several messages sent
//      while the character was busy get answered together, not one at a
//      time).
//   2. Unread messages are waiting but the character is still busy
//      -> do nothing yet, check again next run.
//   3. Nothing pending -> the normal spontaneous "life continues"
//      check-in (spec §12), skipped entirely while busy.
//
// Netlify scheduled functions have a 30s execution budget, so we only
// look at a small batch of the most recently active conversations per run.

import { db, ensureSchema } from "./_lib/db.mjs";
import { getActiveEvent, rollEngagement } from "./_lib/calendar.mjs";
import { deliverChatReply, deliverSpontaneousCheck } from "./_lib/reply.mjs";

const BATCH_SIZE = 5;
const MIN_GAP_MINUTES = 25; // don't re-check the same conversation more often than this
const ACTIVE_WINDOW_DAYS = 3; // only consider conversations touched in the last N days

export default async (req) => {
  await ensureSchema();
  const database = db();

  const activeWindow = `${ACTIVE_WINDOW_DAYS} days`;
  const minGap = `${MIN_GAP_MINUTES} minutes`;

  // ch.* first so the character's own `id` isn't shadowed by the
  // conversation's `id` — the aliased conversation_* columns come after.
  const candidates = await database.sql`
    SELECT ch.*, c.id AS conversation_id, c.user_id AS conversation_user_id,
           c.state AS conversation_state, c.last_heartbeat_at AS conversation_last_heartbeat_at
    FROM conversations c
    JOIN characters ch ON ch.id = c.character_id
    WHERE c.last_activity_at > now() - ${activeWindow}::interval
      AND (c.last_heartbeat_at IS NULL OR c.last_heartbeat_at < now() - ${minGap}::interval)
    ORDER BY c.last_activity_at DESC
    LIMIT ${BATCH_SIZE}
  `;

  const results = [];

  for (const row of candidates) {
    const character = row;
    const conversation = {
      id: row.conversation_id,
      user_id: row.conversation_user_id,
      state: row.conversation_state,
      last_heartbeat_at: row.conversation_last_heartbeat_at,
    };

    try {
      const [{ count }] = await database.sql`
        SELECT count(*)::int AS count FROM messages
        WHERE conversation_id = ${conversation.id} AND sender = 'user' AND read_at IS NULL
      `;

      if (count > 0) {
        const activeEvent = await getActiveEvent(character.id);
        // Same probabilistic gate as the synchronous chat path — not a
        // hard wall, so a batched reply can still land even mid-event if
        // the roll favors it, and definitely will once availability
        // genuinely improves.
        if (!rollEngagement(activeEvent ? activeEvent.availability : 100)) {
          await database.sql`
            UPDATE conversations SET last_heartbeat_at = now() WHERE id = ${conversation.id}
          `;
          results.push({ conversationId: conversation.id, outcome: "waiting_low_availability", pending: count });
        } else {
          const { characterMessageRows } = await deliverChatReply({ character, conversation });
          results.push({
            conversationId: conversation.id,
            outcome: "batched_reply",
            pending: count,
            sent: characterMessageRows.length,
          });
        }
      } else {
        const outcome = await deliverSpontaneousCheck({ character, conversation });
        results.push({
          conversationId: conversation.id,
          outcome: outcome.messaged ? "spontaneous" : outcome.reason || "quiet",
          sent: outcome.count || 0,
        });
      }
    } catch (error) {
      console.error(`Heartbeat failed for conversation ${conversation.id}:`, error);
      // Still bump last_heartbeat_at so a persistently-failing conversation
      // (e.g. bad state) doesn't get retried every single run.
      await database.sql`
        UPDATE conversations SET last_heartbeat_at = now() WHERE id = ${conversation.id}
      `.catch(() => {});
      results.push({ conversationId: conversation.id, error: String(error.message || error) });
    }
  }

  console.log("Heartbeat run:", JSON.stringify(results));
  return new Response(JSON.stringify({ checked: candidates.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  // Every 15 minutes. Cron runs in UTC; see docs.netlify.com/build/functions/scheduled-functions
  schedule: "*/15 * * * *",
};
