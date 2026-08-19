// The calendar/event engine (build spec §3–4). Deterministic on purpose:
// the app owns event status transitions, conflict detection, and time
// arithmetic; the model only ever proposes an *action* (create/move/
// cancel/extend) through structured output, which this module validates
// and applies. See persona.mjs for the schema the model fills in, and
// reply.mjs for how a detected conflict gets resolved.

import { db } from "./db.mjs";

const MATERIALIZE_WINDOW_DAYS = 4; // how far ahead recurring events get generated
const UPCOMING_LIMIT = 6;

// The character's own timezone — "2pm" in a recurring event means 2pm
// here, not 2pm UTC. Override with CHARACTER_TIMEZONE if you deploy this
// somewhere else. Must be a valid IANA zone name.
export const CHARACTER_TIMEZONE = process.env.CHARACTER_TIMEZONE || "America/Chicago";

/* ===================== Timezone-aware time helpers ===================== */
//
// JS Date has no concept of "construct this wall-clock time in timezone
// X" — only UTC or the server's own local zone. These helpers implement
// the standard trick: format a UTC guess in the target zone, measure how
// far off it read, and correct. DST-safe to within one extra pass at the
// transition hour itself.

function zonedYMD(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// A calendar date, as a UTC-midnight instant used purely for day
// arithmetic and day-of-week — never treated as an actual moment in time.
function ymdAnchor({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysToYMD(ymd, days) {
  const anchor = ymdAnchor(ymd);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
}

function dayOfWeekForYMD(ymd) {
  return ymdAnchor(ymd).getUTCDay();
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

// The actual UTC instant for "HH:MM on this Y-M-D, as read on a clock in
// `timeZone`" — e.g. (2026, 8, 19, 14, 0, "America/Chicago") → the UTC
// timestamp that displays as 2:00 PM in Chicago that day.
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = timeZoneOffsetMs(guess, timeZone);
  let corrected = new Date(guess.getTime() - offset);
  const offset2 = timeZoneOffsetMs(corrected, timeZone);
  if (offset2 !== offset) corrected = new Date(guess.getTime() - offset2);
  return corrected;
}

// Turns the model's { day_offset, hour, minute } into a real UTC Date,
// where day_offset is relative to "today" in the character's own
// timezone (0 = today, 1 = tomorrow, ...).
export function resolveDateTime(dayOffset, hour, minute, referenceNow = new Date()) {
  const targetYmd = addDaysToYMD(zonedYMD(referenceNow, CHARACTER_TIMEZONE), dayOffset);
  return zonedWallTimeToUtc(targetYmd.year, targetYmd.month, targetYmd.day, hour, minute, CHARACTER_TIMEZONE);
}

function describeDay(date, now) {
  const dayDiff = Math.round(
    (ymdAnchor(zonedYMD(date, CHARACTER_TIMEZONE)).getTime() -
      ymdAnchor(zonedYMD(now, CHARACTER_TIMEZONE)).getTime()) /
      86400000
  );
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short", timeZone: CHARACTER_TIMEZONE });
}

function formatClockTime(isoOrDate) {
  const d = new Date(isoOrDate);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CHARACTER_TIMEZONE });
}

// "Full weekday, month day, year, time" in the character's own timezone —
// what gets shown to the model as "current date/time".
export function formatNowLabel(date = new Date()) {
  return date.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: CHARACTER_TIMEZONE });
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
  const todayYmd = zonedYMD(now, CHARACTER_TIMEZONE);

  const templates = await database.sql`
    SELECT * FROM recurring_events WHERE character_id = ${characterId} AND active = true
  `;

  for (let offset = 0; offset < MATERIALIZE_WINDOW_DAYS; offset++) {
    const targetYmd = addDaysToYMD(todayYmd, offset);
    const targetDow = dayOfWeekForYMD(targetYmd);
    const recurrenceDate = `${targetYmd.year}-${String(targetYmd.month).padStart(2, "0")}-${String(targetYmd.day).padStart(2, "0")}`;

    for (const tpl of templates) {
      if (tpl.day_of_week !== targetDow) continue;
      const [sh, sm] = String(tpl.start_time_of_day).split(":").map(Number);
      const [eh, em] = String(tpl.end_time_of_day).split(":").map(Number);
      const startTime = zonedWallTimeToUtc(targetYmd.year, targetYmd.month, targetYmd.day, sh, sm, CHARACTER_TIMEZONE);
      const endTime = zonedWallTimeToUtc(targetYmd.year, targetYmd.month, targetYmd.day, eh, em, CHARACTER_TIMEZONE);

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

// Which events for this character transitioned (started or ended) since
// `since`? Used to gate spontaneous heartbeat messages on something
// actually having happened, rather than firing on a timer regardless of
// state — see reply.mjs's deliverSpontaneousCheck.
export async function getRecentTransitions(characterId, since) {
  const database = db();
  const rows = await database.sql`
    SELECT * FROM calendar_events
    WHERE character_id = ${characterId}
      AND status IN ('active', 'completed')
      AND updated_at > ${since ? new Date(since).toISOString() : new Date(0).toISOString()}
    ORDER BY updated_at DESC
  `;
  return rows;
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
