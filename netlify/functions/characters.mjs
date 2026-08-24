import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { db } from "./_lib/db.mjs";
import { listConversationsForUser, ensureConversation } from "./_lib/conversation.mjs";
import { slugify, applyRecurringCommitments, DEFAULT_TIMEZONE } from "./_lib/calendar.mjs";
import { generateStructured } from "./_lib/gemini.mjs";
import {
  buildRecurringCommitmentsInstruction,
  recurringCommitmentsSchema,
  BASE_COMMUNICATION_STYLE,
} from "./_lib/persona.mjs";

const LIMITS = { name: 60, avatarEmoji: 8, tagline: 120, persona: 4000, communicationStyle: 4000, currentActivity: 200, currentMood: 200, timezone: 60 };

function safeString(v, maxLen, fallback = "") {
  if (typeof v !== "string") return fallback;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : fallback;
}

function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function serializeCharacter(row) {
  return {
    id: row.id,
    name: row.name,
    avatarEmoji: row.avatar_emoji,
    tagline: row.tagline,
    persona: row.persona,
    communicationStyle: row.communication_style,
    timezone: row.timezone,
    currentActivity: row.current_activity,
    currentMood: row.current_mood,
  };
}

async function handleList(userId) {
  const rows = await listConversationsForUser(userId);
  return Response.json({
    conversations: rows.map((r) => ({
      conversationId: r.conversation_id,
      characterId: r.character_id,
      name: r.name,
      avatarEmoji: r.avatar_emoji,
      tagline: r.tagline,
      persona: r.persona,
      communicationStyle: r.communication_style,
      timezone: r.timezone,
      currentActivity: r.current_activity,
      currentMood: r.current_mood,
      lastActivityAt: r.last_activity_at,
      lastMessage: r.last_message_content
        ? { content: r.last_message_content, sender: r.last_message_sender, createdAt: r.last_message_at }
        : null,
    })),
  });
}

async function handleCreate(user, body) {
  const name = safeString(body.name, LIMITS.name);
  const persona = safeString(body.persona, LIMITS.persona);
  if (!name || !persona) {
    throw new HttpError(400, "name and persona are required.");
  }
  const communicationStyle = safeString(body.communicationStyle, LIMITS.communicationStyle) || BASE_COMMUNICATION_STYLE;
  const avatarEmoji = safeString(body.avatarEmoji, LIMITS.avatarEmoji) || "🙂";
  const tagline = safeString(body.tagline, LIMITS.tagline);
  const currentActivity = safeString(body.currentActivity, LIMITS.currentActivity) || "just getting started";
  const currentMood = safeString(body.currentMood, LIMITS.currentMood) || "settling in";
  const timezone = isValidTimezone(body.timezone) ? body.timezone : DEFAULT_TIMEZONE;
  const slug = `${slugify(name)}-${Date.now().toString(36)}`;

  const database = db();
  const [character] = await database.sql`
    INSERT INTO characters
      (slug, name, avatar_emoji, tagline, persona, communication_style, timezone, current_activity, current_mood, created_by)
    VALUES (${slug}, ${name}, ${avatarEmoji}, ${tagline}, ${persona}, ${communicationStyle}, ${timezone}, ${currentActivity}, ${currentMood}, ${user.id})
    RETURNING *
  `;

  // Best-effort: propose this character's genuine fixed weekly
  // commitments (see calendar.mjs / persona.mjs). A failure here
  // shouldn't block the character existing — the life-planner will
  // still populate their day-to-day regardless.
  try {
    const instruction = buildRecurringCommitmentsInstruction({ character });
    const aiResult = await generateStructured({
      systemInstruction: instruction,
      input: "Decide their recurring weekly commitments, if any.",
      schema: recurringCommitmentsSchema,
    });
    await applyRecurringCommitments(character.id, aiResult.commitments || []);
  } catch (err) {
    console.error(`Recurring-commitments generation failed for character ${character.id}:`, err);
  }

  const conversation = await ensureConversation(user.id, character.id);

  return Response.json({ character: serializeCharacter(character), conversationId: conversation.id });
}

async function handleUpdate(user, body) {
  const characterId = Number(body.characterId);
  if (!Number.isInteger(characterId)) throw new HttpError(400, "characterId is required.");

  const database = db();
  const owned = await database.sql`
    SELECT 1 FROM conversations WHERE user_id = ${user.id} AND character_id = ${characterId} LIMIT 1
  `;
  if (owned.length === 0) throw new HttpError(404, "Character not found.");

  const fields = [];
  if (typeof body.name === "string") fields.push({ col: "name", val: safeString(body.name, LIMITS.name) || "Unnamed" });
  if (typeof body.avatarEmoji === "string") fields.push({ col: "avatar_emoji", val: safeString(body.avatarEmoji, LIMITS.avatarEmoji) || "🙂" });
  if (typeof body.tagline === "string") fields.push({ col: "tagline", val: safeString(body.tagline, LIMITS.tagline) });
  if (typeof body.persona === "string") {
    const p = safeString(body.persona, LIMITS.persona);
    if (!p) throw new HttpError(400, "persona can't be empty.");
    fields.push({ col: "persona", val: p });
  }
  if (typeof body.communicationStyle === "string") {
    const c = safeString(body.communicationStyle, LIMITS.communicationStyle);
    if (!c) throw new HttpError(400, "communicationStyle can't be empty.");
    fields.push({ col: "communication_style", val: c });
  }
  if (typeof body.currentActivity === "string") fields.push({ col: "current_activity", val: safeString(body.currentActivity, LIMITS.currentActivity) || "just getting started" });
  if (typeof body.currentMood === "string") fields.push({ col: "current_mood", val: safeString(body.currentMood, LIMITS.currentMood) || "settling in" });
  if (typeof body.timezone === "string") {
    if (!isValidTimezone(body.timezone)) throw new HttpError(400, "timezone must be a valid IANA zone name.");
    fields.push({ col: "timezone", val: body.timezone });
  }

  if (fields.length === 0) throw new HttpError(400, "No valid fields to update.");

  const setSql = fields.map((f, i) => `${f.col} = $${i + 2}`).join(", ");
  const params = [characterId, ...fields.map((f) => f.val)];
  const [updated] = await database.sql.query(
    `UPDATE characters SET ${setSql}, status_updated_at = now() WHERE id = $1 RETURNING *`,
    params
  );

  return Response.json({ character: serializeCharacter(updated) });
}

export default async (req, context) => {
  try {
    const user = await requireUser();

    if (req.method === "GET") {
      return await handleList(user.id);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Expected a JSON body.");
    }

    if (req.method === "POST") return await handleCreate(user, body);
    if (req.method === "PATCH") return await handleUpdate(user, body);

    throw new HttpError(405, "Method not allowed.");
  } catch (error) {
    return jsonError(error);
  }
};

export const config = {
  path: "/api/characters",
};
