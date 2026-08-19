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
  messages, reactions, memories, recurring/calendar events
- A persistent character with a stable persona *and* mutable state
  (`current_mood`, plus a live `current_activity` now driven by the
  calendar — see below) — spec §2
- **Calendar / event engine** (spec §3–4): recurring weekly events
  (seminar, work shift, family call) materialize into concrete dated
  events automatically, on a real IANA timezone (`CHARACTER_TIMEZONE`,
  default `America/Chicago`) — "2pm" in the schedule means 2pm there, not
  2pm UTC. The model can create/move/cancel/extend events through
  structured output (`calendar_action`), validated and executed
  deterministically by the app. Overlapping creates/moves are caught
  before they're applied — the app detects the conflict, asks the model
  in-character how it wants to resolve it (keep the new plan and cancel
  the old one, or drop the new plan), and applies whichever it picks, the
  same "clash flow" the spec walks through. `extend` handles realistic
  drift (a shift running long) without needing AI involvement — that's
  pure arithmetic, so the app just does it.
- **Response-session batching** (spec §7–8): each recurring/calendar
  event can be marked "busy." While the character is in a busy event,
  incoming messages don't get an immediate full reply — at most one short
  acknowledgment (only if the app's quick urgency check thinks it's worth
  interrupting for), and the actual reply is deferred. Multiple messages
  sent during that window all get answered together in **one** reply once
  the character is free again, instead of one delayed reply per message —
  and that reply can use per-message reply-threading (`reply_to_id`) to
  point at a specific earlier message when there were several distinct
  unanswered things, the way the spec describes (§8). The deferred
  delivery piggybacks on the heartbeat (below), so it shows up
  automatically via the existing polling — no extra client-side wiring.
- Chat UI: bubbles, grouping, date separators, typing indicator sized to
  message length, read receipts, reply-to-message and emoji reactions
  both via one long-press action menu on any bubble (works the same on
  touch and mouse)
- The AI replies with **structured output** (message bubbles, an optional
  reaction, an optional new memory, an optional calendar action) rather
  than free text — the app owns delivery timing/mechanics and calendar
  validation, the model owns interpretation, per the spec's central
  architectural principle
- A flat per-conversation memory list fed back into every prompt (spec §9,
  without the decay/forgetting-curve refinement in §11)
- A **scheduled function** (`heartbeat.mjs`, every 15 min) that does two
  jobs: delivers batched replies for conversations with pending messages
  once the character is free, and — for conversations with nothing
  pending — checks whether a calendar event actually transitioned
  (started or ended) since the last check, and only then asks the model
  whether it's worth a spontaneous text (skipped entirely while busy, and
  a zero-cost no-op with no AI call at all if nothing transitioned). This
  keeps spontaneous messages tied to something real happening — "my shift
  just ended" — rather than firing on a timer regardless of state. Either
  way it can also quietly touch the calendar (e.g. tentatively planning
  something) even without sending a message. The prompt also explicitly
  discourages reflexively ending every message with a question.
- Lightweight polling (every 7s while the tab is visible) so a spontaneous
  or deferred message shows up without a websocket/Blobs realtime setup;
  the header status line also refreshes every 60s so "current activity"
  stays live as the character's day progresses

**Deliberately left out / stubbed for later phases** (see the original
spec for the full design):
- Conversation response sessions batch by *busy status*, not by a
  message-priority/urgency model that can interrupt anything — the spec's
  fuller picture (§7) has urgency potentially overriding almost any
  activity; here "busy" is a fixed per-event flag and only urgent messages
  get even a short acknowledgment, full replies always wait
- No tentative-vs-confirmed distinction for AI-made plans (spec §6) —
  `calendar_action: create` always makes a concrete, confirmed event
- Timezone is a single value for the whole character (`CHARACTER_TIMEZONE`),
  not per-user — fine for one character with one life, not for "the user
  is in Tokyo and the character is in Chicago" scenarios
- Memory decay/forgetting curve and semantic retrieval — memories are a
  flat recency-ordered list, capped at 8 in context (§9, §11)
- No `search_calendar`/`search_memory`/`search_messages` tool-calling loop
  — the model gets a compact snapshot of upcoming events and recent
  memories up front rather than being able to query for more on demand
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


## Editing the character / calendar

The character's persona and weekly rhythm live in the `characters` and
`recurring_events` tables, seeded automatically the first time the app runs
(see `netlify/functions/_lib/schema.mjs` — `db/schema.sql` has the same DDL
if you'd rather run it by hand in Neon's SQL editor first). Easiest way to
tweak either: open Neon's SQL editor (or any Postgres client):
- Edit the `sam` row in `characters` for persona/mood/tagline.
- Edit rows in `recurring_events` for the weekly schedule — `busy = true`
  means messages during that event get deferred and batched (response
  sessions); `busy = false` means the character replies normally even
  during it (like the seeded Sunday family call).
- One-off plans the AI makes show up in `calendar_events` with
  `source = 'planned'`; recurring-derived ones have `source = 'recurring'`.

To add a second character, insert a new row and point `CHARACTER_SLUG` (env
var) at its `slug`.

## Environment variables

| Variable                | Required | Default                  |
|--------------------------|----------|---------------------------|
| `DATABASE_URL`           | yes      | —                          |
| `GEMINI_API_KEY`         | yes      | —                          |
| `GEMINI_MODEL`           | no       | `gemini-3.1-flash-lite`    |
| `GEMINI_THINKING_LEVEL`  | no       | `low`                      |
| `CHARACTER_SLUG`         | no       | `sam`                      |
| `CHARACTER_TIMEZONE`     | no       | `America/Chicago`          |

Identity's session cookies are wired up automatically by the platform once
Identity is enabled — nothing to configure for that.

## Cost/scale notes

The heartbeat function checks at most 5 recently-active conversations every
15 minutes, and skips any conversation it already checked in the last 25
minutes — so it stays cheap even as users grow, at the cost of spontaneous
and deferred-batch messages sometimes landing later than the spec's ideal
3-minute cadence (worst case for a batched reply: up to ~25 minutes after a
busy event ends). If you deploy this for real usage, that batch size/interval
in `heartbeat.mjs` is the first knob to revisit, and a cheap pre-filter
before calling Gemini (e.g. only call the model if a conversation is "due"
by some heuristic) would cut costs further at higher scale. A calendar
conflict adds one extra Gemini call (only when a conflict actually occurs),
so it's rare in practice.

## File map

```
db/schema.sql                               reference DDL (optional — app self-applies this)
netlify/functions/_lib/db.mjs               Neon connection + self-applying schema
netlify/functions/_lib/schema.mjs           table DDL + seed character/recurring events
netlify/functions/_lib/auth.mjs             Identity verification
netlify/functions/_lib/conversation.mjs     character/conversation/message lookups
netlify/functions/_lib/calendar.mjs         calendar engine: materialize, conflicts, actions
netlify/functions/_lib/gemini.mjs           Gemini Interactions API client
netlify/functions/_lib/persona.mjs          system prompts + response JSON schemas
netlify/functions/_lib/reply.mjs            shared reply/ack/spontaneous delivery logic
netlify/functions/me.mjs                    GET  /api/me       bootstrap + live status
netlify/functions/messages.mjs              GET  /api/messages history/polling
netlify/functions/chat.mjs                  POST /api/chat     send a message (busy-gated)
netlify/functions/react.mjs                 POST /api/react    toggle a reaction
netlify/functions/heartbeat.mjs             scheduled          batched replies + spontaneous messages
src/app.js                                  client logic (bundled to public/)
public/index.html, public/styles.css        chat UI
```
