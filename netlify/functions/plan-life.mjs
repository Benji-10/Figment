// A second, separate AI role from the chat AI (persona.mjs / reply.mjs):
// this function decides what the character is *doing*, not what they say.
// It never talks to anyone and has no knowledge of any specific
// conversation — it only looks at the character's own calendar and
// writes calendar_events to fill genuinely open gaps, several hours at a
// time, up to a few days ahead. Only fixed recurring commitments are
// hand-seeded (schema.mjs); everything else in a day — chores, downtime,
// errands, seeing friends — originates here, with the AI also deciding
// its own availability score per activity rather than that being
// hardcoded per category.
//
// Runs independently of heartbeat.mjs (which is conversation-scoped) —
// this is character-scoped, since a character's life doesn't depend on
// which conversation is looking at it.

import { db, ensureSchema } from "./_lib/db.mjs";
import {
  syncCalendar,
  findNextGap,
  getRecentPastEvents,
  getUpcomingEvents,
  planActivityChain,
  formatNowLabel,
} from "./_lib/calendar.mjs";
import { generateStructured } from "./_lib/gemini.mjs";
import { buildLifePlanSystemInstruction, lifePlanResponseSchema } from "./_lib/persona.mjs";

const MIN_REPLAN_GAP_MINUTES = 20; // don't re-check the same character more often than this
const BATCH_SIZE = 10; // characters processed per run (this basic build has one)
const MIN_WORTHWHILE_GAP_MINUTES = 10;

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
      const gap = await findNextGap(character.id);

      if (!gap) {
        await database.sql`UPDATE characters SET last_planned_at = now() WHERE id = ${character.id}`;
        results.push({ characterId: character.id, outcome: "fully_planned_through_horizon" });
        continue;
      }

      const gapMinutes = Math.round((gap.end.getTime() - gap.start.getTime()) / 60000);
      if (gapMinutes < MIN_WORTHWHILE_GAP_MINUTES) {
        await database.sql`UPDATE characters SET last_planned_at = now() WHERE id = ${character.id}`;
        results.push({ characterId: character.id, outcome: "gap_too_small", gapMinutes });
        continue;
      }

      const [recentPast, upcoming] = await Promise.all([
        getRecentPastEvents(character.id, 3),
        getUpcomingEvents(character.id, 5),
      ]);

      const systemInstruction = buildLifePlanSystemInstruction({
        character,
        now: formatNowLabel(),
        recentPast,
        upcoming,
        gapStart: gap.start,
        gapEnd: gap.end,
        nextFixedEvent: gap.nextFixedEvent,
      });

      const aiResult = await generateStructured({
        systemInstruction,
        input: "Plan this block of time.",
        schema: lifePlanResponseSchema,
      });

      await database.sql`UPDATE characters SET last_planned_at = now() WHERE id = ${character.id}`;

      const outcome = await planActivityChain(character.id, gap.start, gap.end, aiResult.activities || []);
      results.push({
        characterId: character.id,
        outcome: outcome.status,
        gapMinutes,
        planned: outcome.applied.map((e) => `${e.title} (${e.availability})`),
      });
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
  // Every 20 minutes. Each run can plan several hours ahead in one go, so
  // this cadence is about freshness (picking up newly-created chat
  // events promptly) more than raw planning throughput.
  schedule: "*/20 * * * *",
};
