// A second, separate AI role from the chat AI (persona.mjs / reply.mjs):
// this function decides what the character is *doing*, not what they say.
// It never talks to anyone and has no knowledge of any specific
// conversation — it only looks at the character's own calendar and
// writes calendar_events to fill genuinely open gaps. Only fixed
// recurring commitments are hand-seeded (schema.mjs); everything else in
// a day — chores, downtime, errands, seeing friends — originates here,
// one gap at a time, with the AI also deciding its own availability
// score rather than that being hardcoded per activity type.
//
// Runs independently of heartbeat.mjs (which is conversation-scoped) —
// this is character-scoped, since a character's life doesn't depend on
// which conversation is looking at it.

import { db, ensureSchema } from "./_lib/db.mjs";
import {
  syncCalendar,
  hasNearTermGap,
  getRecentPastEvents,
  getUpcomingEvents,
  planActivity,
  formatNowLabel,
} from "./_lib/calendar.mjs";
import { generateStructured } from "./_lib/gemini.mjs";
import { buildLifePlanSystemInstruction, lifePlanResponseSchema } from "./_lib/persona.mjs";

const LOOKAHEAD_MINUTES = 90; // only plan if nothing covers "now" through this window
const MIN_REPLAN_GAP_MINUTES = 20; // don't re-check the same character more often than this
const BATCH_SIZE = 10; // characters processed per run (this basic build has one)

export default async (req) => {
  await ensureSchema();
  const database = db();

  const minGap = `${MIN_REPLAN_GAP_MINUTES} minutes`;
  const characters = await database.sql`
    SELECT * FROM characters
    WHERE last_planned_at IS NULL OR last_planned_at < now() - ${minGap}::interval
    LIMIT ${BATCH_SIZE}
  `;

  const results = [];

  for (const character of characters) {
    try {
      await syncCalendar(character.id);
      const gapExists = await hasNearTermGap(character.id, LOOKAHEAD_MINUTES);

      if (!gapExists) {
        await database.sql`UPDATE characters SET last_planned_at = now() WHERE id = ${character.id}`;
        results.push({ characterId: character.id, outcome: "already_covered" });
        continue;
      }

      const [recentPast, upcoming] = await Promise.all([
        getRecentPastEvents(character.id, 3),
        getUpcomingEvents(character.id, 4),
      ]);

      const systemInstruction = buildLifePlanSystemInstruction({
        character,
        now: formatNowLabel(),
        recentPast,
        upcoming,
      });

      const aiResult = await generateStructured({
        systemInstruction,
        input: "Decide what happens next.",
        schema: lifePlanResponseSchema,
      });

      await database.sql`UPDATE characters SET last_planned_at = now() WHERE id = ${character.id}`;

      if (!aiResult.should_plan || !aiResult.activity) {
        results.push({ characterId: character.id, outcome: "left_unstructured" });
        continue;
      }

      const a = aiResult.activity;
      const outcome = await planActivity(character.id, {
        title: a.title,
        startInMinutes: Number.isInteger(a.start_in_minutes) ? a.start_in_minutes : 0,
        durationMinutes: a.duration_minutes,
        details: a.details,
        location: a.location,
        availability: a.availability,
      });

      results.push({ characterId: character.id, outcome: outcome.status, title: a.title });
    } catch (error) {
      console.error(`Life planning failed for character ${character.id}:`, error);
      await database.sql`
        UPDATE characters SET last_planned_at = now() WHERE id = ${character.id}
      `.catch(() => {});
      results.push({ characterId: character.id, error: String(error.message || error) });
    }
  }

  console.log("Life-planner run:", JSON.stringify(results));
  return new Response(JSON.stringify({ checked: characters.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  // Every 20 minutes — doesn't need to be as tight as message-checking.
  schedule: "*/20 * * * *",
};
