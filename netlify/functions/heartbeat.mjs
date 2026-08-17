// Runs on a schedule (see `config.schedule` below) and gives the
// character a chance to spontaneously text users who've talked to it
// recently — the "life continues even when you're not chatting" half of
// the build spec. Most runs should be a no-op for most conversations;
// the model is explicitly told that in `buildHeartbeatSystemInstruction`.
//
// Netlify scheduled functions have a 30s execution budget, so we only
// look at a small batch of the most recently active conversations per
// run rather than the whole table.

import { db } from "./_lib/db.mjs";
import { getRecentMessages, getRecentMemories } from "./_lib/conversation.mjs";
import { generateStructured } from "./_lib/gemini.mjs";
import {
  buildHeartbeatSystemInstruction,
  heartbeatResponseSchema,
  renderTranscript,
} from "./_lib/persona.mjs";

const BATCH_SIZE = 5;
const MIN_GAP_MINUTES = 25; // don't re-check the same conversation more often than this
const ACTIVE_WINDOW_DAYS = 3; // only consider conversations touched in the last N days

export default async (req) => {
  const database = db();

  const activeWindow = `${ACTIVE_WINDOW_DAYS} days`;
  const minGap = `${MIN_GAP_MINUTES} minutes`;

  const candidates = await database.sql`
    SELECT c.id AS conversation_id, ch.*
    FROM conversations c
    JOIN characters ch ON ch.id = c.character_id
    WHERE c.last_activity_at > now() - ${activeWindow}::interval
      AND (c.last_heartbeat_at IS NULL OR c.last_heartbeat_at < now() - ${minGap}::interval)
    ORDER BY c.last_activity_at DESC
    LIMIT ${BATCH_SIZE}
  `;

  const results = [];

  for (const row of candidates) {
    const conversationId = row.conversation_id;
    try {
      const [history, memories] = await Promise.all([
        getRecentMessages(conversationId, 12),
        getRecentMemories(conversationId),
      ]);

      const systemInstruction = buildHeartbeatSystemInstruction({
        character: row,
        memories,
        now: new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" }),
      });
      const input = renderTranscript(history, row.name);

      const aiResult = await generateStructured({
        systemInstruction,
        input,
        schema: heartbeatResponseSchema,
      });

      const outgoing = Array.isArray(aiResult.messages)
        ? aiResult.messages.filter((m) => typeof m === "string" && m.trim().length > 0)
        : [];

      if (aiResult.should_message && outgoing.length > 0) {
        for (const text of outgoing) {
          await database.sql`
            INSERT INTO messages (conversation_id, sender, content, origin)
            VALUES (${conversationId}, 'character', ${text.trim()}, 'heartbeat')
          `;
        }
        await database.sql`
          UPDATE conversations
          SET last_activity_at = now(), last_heartbeat_at = now(), state = 'active'
          WHERE id = ${conversationId}
        `;
        results.push({ conversationId, messaged: true, count: outgoing.length });
      } else {
        await database.sql`
          UPDATE conversations SET last_heartbeat_at = now() WHERE id = ${conversationId}
        `;
        results.push({ conversationId, messaged: false });
      }
    } catch (error) {
      console.error(`Heartbeat failed for conversation ${conversationId}:`, error);
      // Still bump last_heartbeat_at so a persistently-failing conversation
      // (e.g. bad state) doesn't get retried every single run.
      await database.sql`
        UPDATE conversations SET last_heartbeat_at = now() WHERE id = ${conversationId}
      `.catch(() => {});
      results.push({ conversationId, error: String(error.message || error) });
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
