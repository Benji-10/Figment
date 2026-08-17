# Sam — a persistent AI character chat (basic build)

A Phase 1–2 implementation of the build spec: a WhatsApp/iMessage-style chat UI
backed by a persistent AI character, deployable to Netlify with Netlify
Identity for auth, Netlify Database (Neon Postgres) for storage, and Gemini
for the character's responses.

## What's here vs. what's next

This is the **basic** slice, not the full 30-section spec. It's built so the
rest of the spec (calendar/event engine, memory decay, response-session
grouping, multiple characters, urgency-aware interruption logic...) can be
layered on without re-architecting anything.

**Implemented:**
- Netlify Identity login/signup, gating the chat behind auth
- Netlify Database (Neon) schema: users, characters, conversations,
  messages, reactions, memories
- A persistent character with a stable persona *and* mutable state
  (`current_activity`, `current_mood`) — spec §2
- Chat UI: bubbles, grouping, date separators, typing indicator sized to
  message length, read receipts, reply-to-message (double-click a bubble,
  or long-press), emoji reactions in both directions (long-press a bubble)
- The AI replies with **structured output** (1–3 message bubbles, an
  optional reaction, an optional new memory) rather than free text — the
  app owns delivery timing/mechanics, the model owns interpretation, per
  the spec's central architectural principle
- A flat per-conversation memory list fed back into every prompt (spec §9,
  without the decay/forgetting-curve refinement in §11)
- A **scheduled function** (`heartbeat.mjs`, every 15 min) that lets the
  character message users on its own when nothing prompted it — the "life
  continues without you" half of the spec (§12), simplified: it checks
  recently-active conversations and asks the model whether it spontaneously
  wants to say something, most of the time landing on "no"
- Lightweight polling (every 7s while the tab is visible) so a spontaneous
  heartbeat message shows up without a websocket/Blobs realtime setup

**Deliberately left out / stubbed for later phases** (see the original spec
for the full design):
- Calendar/event engine, event transitions, conflict resolution (§3–4)
- Conversation response sessions that batch several unanswered messages
  into one decision (§8) — right now each `/api/chat` call handles one
  user message at a time
- Memory decay/forgetting curve and semantic retrieval — memories are a
  flat recency-ordered list, capped at 8 in context (§9, §11)
- Urgency-aware interruption behavior (§7) — the character always responds
  when messaged; there's no "busy right now" gating yet, though
  `current_activity`/`current_mood` are already in the data model to build
  that on top of
- Multiple characters (schema supports it; the app only looks up one slug)

## A note on the model name

The model you asked for, `gemini-3.1-flash-lite-preview`, was shut down by
Google on 2026-05-25. This uses its GA replacement, **`gemini-3.1-flash-lite`**
(same tier — Google's low-latency, cost-efficient text model), via the
Gemini **Interactions API**, which is now the recommended endpoint. Override
the model with the `GEMINI_MODEL` environment variable if that changes again.

## Deploy

1. **Get a Neon Postgres database.** Easiest: create a free project at
   [neon.tech](https://neon.tech) and copy its connection string. (You can
   also use Netlify's "Neon" extension from the Extensions marketplace if
   your account has it — either way you end up with a connection string.)
   Netlify's newer one-click "Database" auto-provisioning feature is **not**
   required and isn't used here — it's gated to certain account plans, which
   is exactly what this setup avoids depending on.
2. **Push this project to a Git repo** (GitHub/GitLab/Bitbucket) and create a
   new Netlify site from it, or run `netlify init` from this folder.
3. **Enable Identity**: Project configuration → Identity → Enable Identity.
   For quick testing without email confirmation, also turn on autoconfirm
   under Identity → Emails → Confirmation template.
4. **Set environment variables**: Project configuration → Environment
   variables → add `DATABASE_URL` (your Neon connection string) and
   `GEMINI_API_KEY` (from https://aistudio.google.com/apikey).
5. **Deploy.** `npm run build` bundles the client; Netlify Functions picks up
   everything in `netlify/functions/` automatically. The app creates its own
   tables and seeds the default character on its very first request — no
   migration step, no CLI database commands.

## Local development

```bash
npm install
netlify link        # or: netlify init
netlify dev
```

Add `DATABASE_URL` and `GEMINI_API_KEY` to a local `.env` file (see
`.env.example`) before running `netlify dev`. It builds the client, serves
`public/`, runs the functions, and reads/writes Identity's session cookies
over `http://localhost` (modern browsers treat localhost as a secure
context, so this works without HTTPS locally).


## Editing the character

The character's persona lives in the `characters` table, seeded
automatically the first time the app runs (see
`netlify/functions/_lib/schema.mjs` — `db/schema.sql` has the same DDL if
you'd rather run it by hand in Neon's SQL editor first). Easiest way to
tweak it: open Neon's SQL editor (or any Postgres client) and update the
`sam` row directly (persona, communication_style, current_activity,
current_mood). To add a second character, insert a new row and point
`CHARACTER_SLUG` (env var) at its `slug`.

## Environment variables

| Variable                | Required | Default                  |
|--------------------------|----------|---------------------------|
| `DATABASE_URL`           | yes      | —                          |
| `GEMINI_API_KEY`         | yes      | —                          |
| `GEMINI_MODEL`           | no       | `gemini-3.1-flash-lite`    |
| `GEMINI_THINKING_LEVEL`  | no       | `low`                      |
| `CHARACTER_SLUG`         | no       | `sam`                      |

Identity's session cookies are wired up automatically by the platform once
Identity is enabled — nothing to configure for that.

## Cost/scale notes

The heartbeat function checks at most 5 recently-active conversations every
15 minutes, and skips any conversation it already checked in the last 25
minutes — so it stays cheap even as users grow, at the cost of spontaneous
messages sometimes landing later than the spec's ideal 3-minute cadence. If
you deploy this for real usage, that batch size/interval in `heartbeat.mjs`
is the first knob to revisit, and a cheap pre-filter before calling Gemini
(e.g. only call the model if a conversation is "due" by some heuristic) would
cut costs further at higher scale.

## File map

```
db/schema.sql                               reference DDL (optional — app self-applies this)
netlify/functions/_lib/                     shared: db, schema, auth, gemini, persona
netlify/functions/me.mjs                    GET  /api/me       bootstrap
netlify/functions/messages.mjs              GET  /api/messages history/polling
netlify/functions/chat.mjs                  POST /api/chat     send a message
netlify/functions/react.mjs                 POST /api/react    toggle a reaction
netlify/functions/heartbeat.mjs             scheduled          spontaneous messages
src/app.js                                  client logic (bundled to public/)
public/index.html, public/styles.css        chat UI
```
