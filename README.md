# Sam — a persistent AI character chat (basic build)

A Phase 1–2 implementation of the build spec: a WhatsApp/iMessage-style chat UI
backed by a persistent AI character, deployable to Netlify with Netlify
Identity for auth, Netlify Database (Neon Postgres) for storage, and Gemini
for the character's responses.

## What's here vs. what's next

This is the **basic** slice, not the full 30-section spec. It's built so the
rest of the spec (memory decay, multiple characters, urgency-aware
interruption logic beyond availability scores...) can be layered on without
re-architecting anything.

**Implemented:**
- Netlify Identity login/signup, gating the chat behind auth
- Netlify Database (Neon) schema: users, characters, conversations,
  messages, reactions, memories, recurring/calendar events
- A persistent character with a stable persona *and* mutable state
  (`current_mood`, plus a live `current_activity` now driven by the
  calendar — see below) — spec §2
- **Two separate AI roles, not one** — this is the important architectural
  point:
  - **The chat AI** (`persona.mjs`'s chat/heartbeat/ack builders, called
    from `chat.mjs`/`heartbeat.mjs`) only ever talks to a specific person.
    It has no say over what the character is *doing* — it just reacts to
    conversation, and can *propose* a calendar action (agreeing to plans,
    bailing on something) which the app validates before applying.
  - **The life-planner AI** (`plan-life.mjs`, a separate scheduled
    function, new prompt in `persona.mjs`) never talks to anyone and
    doesn't know any specific conversation exists. It walks the
    character's timeline forward from now, finds the next genuinely open
    stretch (properly — by walking the interval list, not just checking
    whether "now" is covered, so it can't be fooled by something already
    scheduled further out), and plans a **chain** of activities into it
    to the minute — a couple hours of class, then a 15-minute bus ride,
    then scrolling, then a shower, then getting ready for whatever's
    next — instead of one isolated activity at a time. It doesn't have to
    fill the whole gap; unstructured time is a valid outcome. It also
    sees what's coming up right after the block, including location, and
    is explicitly told to leave room for getting ready/commuting if that
    next thing is somewhere else — so when the chat AI (or you, by hand)
    creates a dinner plan across town, the *next* planner run naturally
    wraps the preceding time up to it rather than running some unrelated
    activity right up to the second dinner starts. Runs every 20 minutes
    but only spends an AI call when there's an actual gap; each call can
    cover several hours at once, so the schedule reaches a few days of
    real coverage within a handful of cycles, then just keeps pace with
    time passing. Only genuine fixed commitments (class, a paid shift, a
    standing call) are hand-seeded in `recurring_events`; everything else
    in a day originates from this AI, not from hardcoded filler, which is
    what the spec's "avoid manually tuned content" principle actually
    asks for once you take it seriously.
- **Calendar / event engine** (spec §3–4): recurring commitments
  materialize into concrete dated events automatically, on a real IANA
  timezone (`CHARACTER_TIMEZONE`, default `America/Chicago`) — "2pm" in
  the schedule means 2pm there, not 2pm UTC. Either AI can create/move/
  cancel/extend events through the same structured `calendar_action`
  shape, validated and executed deterministically by the app. Overlapping
  creates/moves are caught before they're applied — the app detects the
  conflict, asks the model in-character how it wants to resolve it (keep
  the new plan and cancel the old one, or drop the new plan), and applies
  whichever it picks, the same "clash flow" the spec walks through.
  `extend` handles realistic drift (a shift running long) without needing
  AI involvement — that's pure arithmetic, so the app just does it.
- **Availability score, not a busy/free flag**: every event (recurring or
  AI-generated) carries a 0–100 availability score instead of a boolean.
  Mechanically it's a weighted coin flip (`rollEngagement`, in
  `calendar.mjs`) that decides, per incoming message, whether the
  character responds immediately in full or the message gets deferred —
  so a low-availability event (an exam, a shift) is *mostly* unresponsive
  but not absolutely silent, and a high-availability one (folding
  laundry, watching TV) responds close to normally. This directly
  replaces an earlier hard busy/free gate that made the character
  unreachable for the entire length of any "busy" event — the score is
  set by whichever AI created the event (the planner decides how
  reachable "getting coffee with a friend" realistically is; you can also
  hand-set it on the seeded recurring rows).
- **Response-session batching** (spec §7–8): when the availability roll
  doesn't land on "respond now," at most one short acknowledgment goes
  out (only if the app's quick urgency check thinks it's worth
  interrupting for), and the actual reply is deferred. Multiple messages
  sent during that window all get answered together in **one** reply once
  the character is free again (or the next favorable roll), instead of
  one delayed reply per message — and that reply can use per-message
  reply-threading (`reply_to_id`) to point at a specific earlier message
  when there were several distinct unanswered things, the way the spec
  describes (§8). The deferred delivery piggybacks on the heartbeat
  (below), so it shows up automatically via the existing polling — no
  extra client-side wiring.
- **Low-effort by default, not maximally helpful**: the chat AI is
  explicitly told to favor one short message over a burst, skip
  elaboration, and mostly not ask questions — asking should be the
  exception, not something it defaults to just to keep a conversation
  going. It can also send **zero messages** for a given turn (optionally
  still reacting with just an emoji) when a reply genuinely wouldn't add
  anything — the read receipt still updates, so it reads as "saw it,
  didn't feel like replying" rather than a bug.
- Chat UI: bubbles, grouping, date separators, typing indicator sized to
  message length, read receipts, reply-to-message and emoji reactions
  both via one long-press action menu on any bubble (works the same on
  touch and mouse)
- The chat AI replies with **structured output** (message bubbles, an
  optional reaction, an optional new memory, an optional calendar action)
  rather than free text — the app owns delivery timing/mechanics and
  calendar validation, the model owns interpretation, per the spec's
  central architectural principle
- A flat per-conversation memory list fed back into every prompt (spec §9,
  without the decay/forgetting-curve refinement in §11)
- A **scheduled function** (`heartbeat.mjs`, every 15 min, conversation-
  scoped) that does two jobs: delivers batched replies for conversations
  with pending messages once the availability roll allows it, and — for
  conversations with nothing pending — checks whether a calendar event
  actually transitioned (started or ended) since the last check, and only
  then asks the model whether it's worth a spontaneous text (a zero-cost
  no-op with no AI call at all if nothing transitioned, and gated by the
  same availability roll). This keeps spontaneous messages tied to
  something real happening — "my shift just ended" — rather than firing
  on a timer regardless of state.
- A **second scheduled function** (`plan-life.mjs`, every 20 min,
  character-scoped, not conversation-scoped) — the life-planner described
  above, keeping the schedule filled a few days ahead; paced by
  `characters.last_planned_at` so it doesn't replan on every tick.
- Lightweight polling (every 7s while the tab is visible) so a spontaneous
  or deferred message shows up without a websocket/Blobs realtime setup;
  the header status line also refreshes every 60s so "current activity"
  stays live as the character's day progresses

**Deliberately left out / stubbed for later phases** (see the original
spec for the full design):
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
- The life-planner's commute/prep awareness comes from prompt guidance
  (seeing the next fixed event's location and being told to leave buffer
  time), not a dedicated "travel time" calculation — it's a judgment call
  the AI makes each time, not a deterministic distance/mode-of-transport
  model

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

The character's persona and fixed weekly commitments live in the
`characters` and `recurring_events` tables, seeded automatically the first
time the app runs (see `netlify/functions/_lib/schema.mjs` — `db/schema.sql`
has the same DDL if you'd rather run it by hand in Neon's SQL editor
first). Easiest way to tweak either: open Neon's SQL editor (or any
Postgres client):
- Edit the `sam` row in `characters` for persona/mood/tagline.
- Edit rows in `recurring_events` for genuinely fixed commitments —
  `availability` (0-100) controls how likely an immediate reply is during
  that event; low values (seminar/shift are seeded at 8/20) mean mostly-
  deferred, high values mean close to normal. Everything else in the
  day — chores, downtime, seeing friends — is generated by the
  life-planner AI on its own; you don't need to seed it.
- Events show up in `calendar_events` tagged by `source`: `recurring`
  (materialized from a template), `generated` (the life-planner filling a
  gap), or `planned` (the chat AI making/agreeing to something
  mid-conversation).

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

Two scheduled functions run independently: `heartbeat.mjs` (every 15 min,
checks up to 5 recently-active conversations, skips any it already checked
in the last 25 min) and `plan-life.mjs` (every 20 min, checks up to 10
characters, skips any it already planned for in the last 20 min and does
nothing at all — no AI call — once the schedule is filled through the
3-day horizon). Each `plan-life.mjs` call that does run can plan several
hours in one go (up to 10 chained activities), so reaching multi-day
coverage takes a bounded handful of cycles, not one call per activity —
after that it's just topping up the trailing edge as time passes, which is
usually one small call per cycle or a no-op. Both functions stay cheap as
usage grows, at the cost of things sometimes landing later than the spec's
ideal cadence (worst case for a batched reply: up to ~25 minutes after
availability improves; worst case for freshly-created plans not yet having
commute buffer around them: up to ~20 minutes). If you deploy this for real
usage, those batch sizes/intervals are the first knobs to revisit. A
calendar conflict adds one extra Gemini call (only when a conflict actually
occurs), so it's rare in practice.

## File map

```
db/schema.sql                               reference DDL (optional — app self-applies this)
netlify/functions/_lib/db.mjs               Neon connection + self-applying schema
netlify/functions/_lib/schema.mjs           table DDL + seed character/recurring events
netlify/functions/_lib/auth.mjs             Identity verification
netlify/functions/_lib/conversation.mjs     character/conversation/message lookups
netlify/functions/_lib/calendar.mjs         calendar engine: materialize, conflicts, actions, availability rolls
netlify/functions/_lib/gemini.mjs           Gemini Interactions API client
netlify/functions/_lib/persona.mjs          system prompts + response JSON schemas (both AI roles)
netlify/functions/_lib/reply.mjs            shared reply/ack/spontaneous delivery logic (chat AI)
netlify/functions/me.mjs                    GET  /api/me       bootstrap + live status
netlify/functions/messages.mjs              GET  /api/messages history/polling
netlify/functions/chat.mjs                  POST /api/chat     send a message (availability-gated)
netlify/functions/react.mjs                 POST /api/react    toggle a reaction
netlify/functions/heartbeat.mjs             scheduled          batched replies + spontaneous messages (chat AI)
netlify/functions/plan-life.mjs             scheduled          fills calendar gaps (life-planner AI)
src/app.js                                  client logic (bundled to public/)
public/index.html, public/styles.css        chat UI
```
