// The calendar/event engine (build spec §3–4). Deterministic on purpose:
// the app owns event status transitions, conflict detection, and time
// arithmetic; the model only ever proposes an *action* (create/move/
// cancel/extend) through structured output, which this module validates
// and applies. See persona.mjs for the schema the model fills in, and
// reply.mjs for how a detected conflict gets resolved.
//
// Simplification: there's no per-character timezone modeling — all times
// are treated as a single implicit "wall clock" (UTC). Fine for a basic
// build; a real deployment would want a timezone per character.

import { db } from "./db.mjs";

const MATERIALIZE_WINDOW_DAYS = 4; // how far ahead recurring events get generated
const UPCOMING_LIMIT = 6;

/* ===================== Time helpers ===================== */

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function combineDateAndTimeOfDay(date, timeOfDay) {
  const [h, m, s] = String(timeOfDay).split(":").map(Number);
  const d = new Date(date);
  d.setUTCHours(h, m, s || 0, 0);
  return d;
}

// Turns the model's { day_offset, start_hour, start_minute } into a Date,
// relative to "today" at UTC midnight.
export function resolveDateTime(dayOffset, hour, minute, referenceNow = new Date()) {
  const base = startOfUtcDay(referenceNow);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

function describeDay(date, now) {
  const diffDays = Math.round(
    (startOfUtcDay(date).getTime() - startOfUtcDay(now).getTime()) / 86400000
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function formatClockTime(isoOrDate) {
  const d = new Date(isoOrDate);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

export function formatEventTimeRange(event, now) {
  const start = new Date(event.start_time);
  return `${describeDay(start, now)} ${formatClockTime(event.start_time)}–${formatClockTime(event.end_time)}`;
}

/* ===================== Validation ===================== */

function safeString(v, maxLen = 300) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}
const isValidDayOffset = (v) => Number.isInteger(v) && v >= 0 && v <= 6;
const isValidHour = (v) => Number.isInteger(v) && v >= 0 && v <= 23;
const isValidMinute = (v) => Number.isInteger(v) && v >= 0 && v <= 59;
const isValidPositiveDuration = (v) => Number.isInteger(v) && v >= 1 && v <= 1440;
const isValidDeltaMinutes = (v) => Number.isInteger(v) && v !== 0 && Math.abs(v) <= 720;
const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/* ===================== Materialization + status refresh ===================== */

// Generates concrete calendar_events from active recurring_events
// templates for the next MATERIALIZE_WINDOW_DAYS days (idempotent), then
// flips scheduled → active → completed based on the current time. Cheap
// to call on every request that needs an accurate "current activity".
export async function syncCalendar(characterId) {
  const database = db();
  const now = new Date();
  const today = startOfUtcDay(now);

  const templates = await database.sql`
    SELECT * FROM recurring_events WHERE character_id = ${characterId} AND active = true
  `;

  for (let offset = 0; offset < MATERIALIZE_WINDOW_DAYS; offset++) {
    const targetDate = addDays(today, offset);
    const targetDow = targetDate.getUTCDay();
    const recurrenceDate = targetDate.toISOString().slice(0, 10);

    for (const tpl of templates) {
      if (tpl.day_of_week !== targetDow) continue;
      const startTime = combineDateAndTimeOfDay(targetDate, tpl.start_time_of_day);
      const endTime = combineDateAndTimeOfDay(targetDate, tpl.end_time_of_day);

      await database.sql`
        INSERT INTO calendar_events
          (character_id, title, start_time, end_time, status, location, details, source, busy, recurring_event_id, recurrence_date)
        VALUES
          (${characterId}, ${tpl.title}, ${startTime.toISOString()}, ${endTime.toISOString()}, 'scheduled', ${tpl.location}, ${tpl.details}, 'recurring', ${tpl.busy}, ${tpl.id}, ${recurrenceDate})
        ON CONFLICT (recurring_event_id, recurrence_date) DO NOTHING
      `;
    }
  }

  await database.sql`
    UPDATE calendar_events SET status = 'active', updated_at = now()
    WHERE character_id = ${characterId} AND status = 'scheduled'
      AND start_time <= now() AND end_time > now()
  `;
  await database.sql`
    UPDATE calendar_events SET status = 'completed', updated_at = now()
    WHERE character_id = ${characterId} AND status IN ('scheduled', 'active') AND end_time <= now()
  `;
}

export async function getActiveEvent(characterId) {
  const database = db();
  const rows = await database.sql`
    SELECT * FROM calendar_events
    WHERE character_id = ${characterId} AND status = 'active'
    ORDER BY start_time DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function getUpcomingEvents(characterId, limit = UPCOMING_LIMIT) {
  const database = db();
  const rows = await database.sql`
    SELECT * FROM calendar_events
    WHERE character_id = ${characterId} AND status = 'scheduled' AND start_time > now()
    ORDER BY start_time
    LIMIT ${limit}
  `;
  return rows;
}

// What goes in the chat header / into "Currently doing" in the prompt.
export function describeCurrentActivity(character, activeEvent) {
  if (!activeEvent) return character.current_activity;
  return activeEvent.location ? `${activeEvent.title} @ ${activeEvent.location}` : activeEvent.title;
}

export function formatCalendarForPrompt({ activeEvent, upcoming }, now = new Date()) {
  const lines = [];
  if (activeEvent) {
    lines.push(
      `Right now (until ${formatClockTime(activeEvent.end_time)}): ${activeEvent.title}` +
        (activeEvent.details ? ` — ${activeEvent.details}` : "") +
        (activeEvent.location ? ` @ ${activeEvent.location}` : "")
    );
  }
  if (upcoming.length === 0) {
    lines.push("Nothing else on the calendar in the next few days.");
  } else {
    lines.push("Coming up (reference by [id N] if you need to move/cancel/extend one):");
    for (const ev of upcoming) {
      lines.push(
        `  [id ${ev.id}] ${formatEventTimeRange(ev, now)} — ${ev.title}` +
          (ev.details ? ` (${ev.details})` : "") +
          (ev.location ? ` @ ${ev.location}` : "")
      );
    }
  }
  return lines.join("\n");
}

/* ===================== Conflict detection ===================== */

async function findConflicts(characterId, startTime, endTime, excludeEventId = null) {
  const database = db();
  const rows = await database.sql`
    SELECT * FROM calendar_events
    WHERE character_id = ${characterId}
      AND status IN ('scheduled', 'active')
      AND id != ${excludeEventId ?? -1}
      AND start_time < ${endTime.toISOString()}
      AND end_time > ${startTime.toISOString()}
    ORDER BY start_time
  `;
  return rows;
}

/* ===================== Applying AI-proposed actions ===================== */

// Validates and applies a `calendar_action` object from the model's
// structured output. Returns one of:
//   { status: "ignored" }                       — missing/invalid fields, silently skipped
//   { status: "not_found", action }              — event_id didn't resolve to a live event
//   { status: "conflict", action, proposed, conflictingEvents } — needs a resolution round-trip
//   { status: "applied", action, event }          — done
//
// Pass `{ overrideConflicts: true, cancelEventIds: [...] }` on a second
// call to force it through after a conflict has been resolved (see
// reply.mjs) — this cancels the given events first, then applies without
// re-checking for overlaps against them.
export async function applyCalendarAction(characterId, action, opts = {}) {
  const { overrideConflicts = false, cancelEventIds = [] } = opts;
  if (!action || typeof action !== "object") return { status: "ignored" };
  const database = db();
  const kind = action.action;

  async function cancelPriorConflicts() {
    for (const id of cancelEventIds) {
      await database.sql`
        UPDATE calendar_events SET status = 'cancelled', updated_at = now()
        WHERE id = ${id} AND character_id = ${characterId}
      `;
    }
  }

  if (kind === "create") {
    const title = safeString(action.title);
    if (
      !title ||
      !isValidDayOffset(action.day_offset) ||
      !isValidHour(action.start_hour) ||
      !isValidMinute(action.start_minute) ||
      !isValidPositiveDuration(action.duration_minutes)
    ) {
      return { status: "ignored", action: "create" };
    }

    const startTime = resolveDateTime(action.day_offset, action.start_hour, action.start_minute);
    const endTime = new Date(startTime.getTime() + action.duration_minutes * 60000);
    const details = safeString(action.details) || "";
    const location = safeString(action.location);

    if (!overrideConflicts) {
      const conflicts = await findConflicts(characterId, startTime, endTime);
      if (conflicts.length > 0) {
        return {
          status: "conflict",
          action: "create",
          proposed: { title, startTime, endTime, details, location },
          conflictingEvents: conflicts,
        };
      }
    } else {
      await cancelPriorConflicts();
    }

    const [row] = await database.sql`
      INSERT INTO calendar_events (character_id, title, start_time, end_time, status, location, details, source, busy)
      VALUES (${characterId}, ${title}, ${startTime.toISOString()}, ${endTime.toISOString()}, 'scheduled', ${location}, ${details}, 'planned', false)
      RETURNING *
    `;
    return { status: "applied", action: "create", event: row };
  }

  if (kind === "move") {
    const eventId = toPositiveInt(action.event_id);
    if (
      !eventId ||
      !isValidDayOffset(action.day_offset) ||
      !isValidHour(action.start_hour) ||
      !isValidMinute(action.start_minute)
    ) {
      return { status: "ignored", action: "move" };
    }

    const [existing] = await database.sql`
      SELECT * FROM calendar_events
      WHERE id = ${eventId} AND character_id = ${characterId} AND status IN ('scheduled', 'active')
    `;
    if (!existing) return { status: "not_found", action: "move" };

    const originalDurationMs = new Date(existing.end_time).getTime() - new Date(existing.start_time).getTime();
    const startTime = resolveDateTime(action.day_offset, action.start_hour, action.start_minute);
    const durationMs = isValidPositiveDuration(action.duration_minutes)
      ? action.duration_minutes * 60000
      : originalDurationMs;
    const endTime = new Date(startTime.getTime() + durationMs);

    if (!overrideConflicts) {
      const conflicts = await findConflicts(characterId, startTime, endTime, eventId);
      if (conflicts.length > 0) {
        return {
          status: "conflict",
          action: "move",
          proposed: {
            title: existing.title,
            startTime,
            endTime,
            details: existing.details,
            location: existing.location,
            eventId,
          },
          conflictingEvents: conflicts,
        };
      }
    } else {
      await cancelPriorConflicts();
    }

    const [row] = await database.sql`
      UPDATE calendar_events
      SET start_time = ${startTime.toISOString()}, end_time = ${endTime.toISOString()}, updated_at = now()
      WHERE id = ${eventId}
      RETURNING *
    `;
    return { status: "applied", action: "move", event: row };
  }

  if (kind === "cancel") {
    const eventId = toPositiveInt(action.event_id);
    if (!eventId) return { status: "ignored", action: "cancel" };

    const [row] = await database.sql`
      UPDATE calendar_events SET status = 'cancelled', updated_at = now()
      WHERE id = ${eventId} AND character_id = ${characterId} AND status IN ('scheduled', 'active')
      RETURNING *
    `;
    if (!row) return { status: "not_found", action: "cancel" };
    return { status: "applied", action: "cancel", event: row };
  }

  if (kind === "extend") {
    const eventId = toPositiveInt(action.event_id);
    if (!eventId || !isValidDeltaMinutes(action.duration_minutes)) {
      return { status: "ignored", action: "extend" };
    }
    const intervalStr = `${action.duration_minutes} minutes`;

    const [row] = await database.sql`
      UPDATE calendar_events
      SET end_time = end_time + ${intervalStr}::interval, updated_at = now()
      WHERE id = ${eventId} AND character_id = ${characterId} AND status IN ('scheduled', 'active')
      RETURNING *
    `;
    if (!row) return { status: "not_found", action: "extend" };
    return { status: "applied", action: "extend", event: row };
  }

  return { status: "ignored" };
}
