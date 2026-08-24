import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { generateStructured } from "./_lib/gemini.mjs";
import {
  buildCharacterGenerationInstruction,
  characterGenerationSchema,
  BASE_COMMUNICATION_STYLE,
} from "./_lib/persona.mjs";
import { DEFAULT_TIMEZONE } from "./_lib/calendar.mjs";

const MAX_SEED_LENGTH = 300;

export default async (req, context) => {
  try {
    await requireUser(); // just needs to be logged in; doesn't write anything

    let body = {};
    try {
      body = await req.json();
    } catch {
      // an empty/missing body is fine — that's "surprise me"
    }

    const seedPrompt = typeof body.seedPrompt === "string" ? body.seedPrompt.trim().slice(0, MAX_SEED_LENGTH) : "";

    const systemInstruction = buildCharacterGenerationInstruction({ seedPrompt: seedPrompt || null });
    const aiResult = await generateStructured({
      systemInstruction,
      input: seedPrompt ? `Starting idea: ${seedPrompt}` : "Invent a character.",
      schema: characterGenerationSchema,
    });

    return Response.json({
      draft: {
        name: safe(aiResult.name, 60) || "Unnamed",
        avatarEmoji: safe(aiResult.avatar_emoji, 8) || "🙂",
        tagline: safe(aiResult.tagline, 120) || "",
        persona: safe(aiResult.persona, 4000) || "",
        communicationStyle: safe(aiResult.communication_style, 4000) || BASE_COMMUNICATION_STYLE,
        currentActivity: safe(aiResult.current_activity, 200) || "just getting started",
        currentMood: safe(aiResult.current_mood, 200) || "settling in",
        timezone: safe(aiResult.timezone, 60) || DEFAULT_TIMEZONE,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
};

function safe(v, maxLen) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}

export const config = {
  path: "/api/generate-character",
  method: "POST",
};
