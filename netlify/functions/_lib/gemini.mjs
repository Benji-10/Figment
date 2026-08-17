// Thin wrapper around Google's Gemini "Interactions API"
// (https://ai.google.dev/gemini-api/docs/interactions-overview), the
// current recommended entry point for the Gemini API as of mid-2026.
//
// Note on the model name: the user-requested "gemini-3.1-flash-lite-preview"
// preview model was shut down on 2026-05-25. This uses its GA successor,
// "gemini-3.1-flash-lite", which is a drop-in replacement. Override with
// the GEMINI_MODEL environment variable if that ever changes again.

const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "low";

/**
 * Calls Gemini and returns a parsed JSON object matching `schema`.
 *
 * @param {object} params
 * @param {string} params.systemInstruction - persona / behavior rules
 * @param {string} params.input - the rendered conversation context
 * @param {object} params.schema - JSON Schema for the expected response
 * @param {string} [params.model]
 */
export async function generateStructured({ systemInstruction, input, schema, model }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY environment variable. Set it in Project configuration > Environment variables."
    );
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      system_instruction: systemInstruction,
      input,
      store: false, // we manage conversation history ourselves in Postgres
      generation_config: {
        thinking_level: THINKING_LEVEL,
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema,
      },
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${bodyText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = extractOutputText(data);
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return parseJsonLoosely(text);
}

// Reimplements the Interactions API's `output_text` convenience getter
// (join the trailing run of consecutive text content blocks) for callers
// hitting the REST endpoint directly instead of using the SDK. Falls back
// to `data.output_text` first in case a future API revision starts
// including it directly.
function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  const steps = Array.isArray(data.steps) ? data.steps : [];
  const parts = [];

  for (let i = steps.length - 1; i >= 0; i--) {
    const blocks = Array.isArray(steps[i]?.content) ? steps[i].content : [];
    const textBlocks = blocks.filter(
      (b) => b?.type === "text" && typeof b.text === "string"
    );

    if (textBlocks.length === 0) {
      if (parts.length > 0) break;
      continue;
    }

    parts.unshift(textBlocks.map((b) => b.text).join(""));

    // Stop once we hit a step that mixed in non-text content (e.g. a
    // thought or tool call) — output_text only joins a trailing run of
    // pure text steps.
    if (textBlocks.length !== blocks.length) break;
  }

  return parts.join("");
}

function parseJsonLoosely(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Structured output should already be pure JSON, but if a stray code
    // fence or whitespace sneaks in, salvage the first {...} block.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Could not parse Gemini output as JSON: ${text.slice(0, 300)}`);
  }
}
