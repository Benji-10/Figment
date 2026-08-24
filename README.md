# Persistent AI character chat (basic build)

A WhatsApp/iMessage-style chat app backed by persistent AI characters —
each with their own calendar, mood, and independent life — deployable to
Netlify with Netlify Identity for auth, Netlify Database (Neon Postgres)
for storage, and Gemini for the characters' responses.

No character is hardcoded anywhere in this codebase. You create characters
from inside the app — write one yourself, or have AI generate a full
persona from a one-line idea (or nothing at all) and edit it before saving.

## What's here vs. what's next

This is the **basic** slice, not the full 30-section spec. It's built so the
rest of the spec (memory decay, urgency-aware interruption logic beyond
availability scores...) can be layered on without re-architecting anything.

**Implemented:**

- Netlify Identity login/signup, gating the app behind auth
- Netlify Database (Neon) schema: users, characters, conversations,
  messages, reactions, memories, recurring/calendar events — nothing
  seeded, all created at runtime
- **Multi-character support**: a chat-list home screen (like a normal
  messaging app) showing every character you've started a conversation
  with, a "+" to create a new one, and a settings icon inside any chat to
  edit that character. Every character belongs to whoever created them and
  is only reachable through a conversation you actually own — verified
  server-side on every request, not just hidden in the UI (see "Cross-user
  isolation" below).
- **Three separate AI roles, not one** — this is the important
  architectural point:
  - **The character-generation AI** (`generate-character.mjs` +
    `characters.mjs`) invents a full persona — name, backstory,
    personality, a fitting timezone — from an optional one-line seed idea,
    or from scratch if you give it nothing. It also proposes that
    character's genuine fixed weekly commitments (a class, a job, a
    standing call), which get saved as `recurring_events` once, at
    creation time. This is the *only* place any character's content
    originates from, and even then you review and can overwrite every
    field before saving.
  - **The chat AI** (`persona.mjs`'s chat/heartbeat/ack builders, called
    from `chat.mjs`/`heartbeat.mjs`) only ever talks to a specific person.
    It has no say over what the character is *doing* day-to-day — it just
    reacts to conversation, and can *propose* a calendar action (agreeing
    to plans, bailing on something) which the app validates before
    applying.
  - **The life-planner AI** (`plan-life.mjs`, a separate scheduled
    function) never talks to anyone and doesn't know any specific
    conversation exists. It walks each character's timeline forward from
    now, finds the next genuinely open stretch (properly — by walking the
    interval list, not just checking whether "now" is covered, so it
    can't be fooled by something already scheduled further out), and
    plans a **chain** of activities into it to the minute — a couple
    hours of class, then a 15-minute bus ride, then scrolling, then a
    shower, then getting ready for whatever's next — instead of one
    isolated activity at a time. It doesn't have to fill the whole gap;
    unstructured time is a valid outcome. It also sees what's coming up
    right after the block, including location, and is explicitly told to
    leave room for getting ready/commuting if that next thing is
    somewhere else. Runs every 20 minutes but only spends an AI call when
    there's an actual gap; each call can cover several hours at once, so
    the schedule reaches a few days of real coverage within a handful of
    cycles, then just keeps pace with time passing.
- **Calendar / event engine** (spec §3–4): recurring commitments
  materialize into concrete dated events automatically, on each
  character's own IANA timezone — "2pm" in the schedule means 2pm for
  *that character*, not a global default. Any of the three AI roles can
  create/move/cancel/extend events through the same structured
  `calendar_action`/generation shape, validated and executed
  deterministically by the app. Overlapping creates/moves are caught
  before they're applied — the app detects the conflict, asks the model
  in-character how it wants to resolve it (keep the new plan and cancel
  the old one, or drop the new plan), and applies whichever it picks, the
  same "clash flow" the spec walks through. `extend` handles realistic
  drift (a shift running long) without needing AI involvement — that's
  pure arithmetic, so the app just does it.
- **Availability score, not a busy/free flag**: every event (recurring or
  AI-generated) carries a 0–100 availability score instead of a boolean.
  Mechanically it's a weighted coin flip (`rollEngagement`, in
  `calendar.mjs`) that decides, per incoming message, whether the
  character responds immediately in full or the message gets deferred —
  so a low-availability event (an exam, a shift) is *mostly* unresponsive
  but not absolutely silent, and a high-availability one (folding
  laundry, watching TV) responds close to normally. The score is set by
  whichever AI created the event — the planner decides how reachable
  "getting coffee with a friend" realistically is, per activity.
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
  same availability roll).
- A **second scheduled function** (`plan-life.mjs`, every 20 min,
  character-scoped, not conversation-scoped) — the life-planner described
  above, keeping every character's schedule filled a few days ahead;
  paced by `characters.last_planned_at` so it doesn't replan on every tick.
- Lightweight polling (every 7s while a chat is open) so a spontaneous or
  deferred message shows up without a websocket/Blobs realtime setup; the
  header status line also refreshes every 60s so "current activity" stays
  live as the character's day progresses

**Deliberately left out / stubbed for later phases** (see the original
spec for the full design):
- No tentative-vs-confirmed distinction for AI-made plans (spec §6) —
  `calendar_action: create` always makes a concrete, confirmed event
- Memory decay/forgetting curve and semantic retrieval — memories are a
  flat recency-ordered list, capped at 8 in context (§9, §11)
- No `search_calendar`/`search_memory`/`search_messages` tool-calling loop
  — the model gets a compact snapshot of upcoming events and recent
  memories up front rather than being able to query for more on demand
- The life-planner's commute/prep awareness comes from prompt guidance
  (seeing the next fixed event's location and being told to leave buffer
  time), not a dedicated "travel time" calculation — it's a judgment call
  the AI makes each time, not a deterministic distance/mode model
- No character deletion in the UI yet (create and edit are there; you can
  drop a row directly in Neon if you need to remove one)

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
   tables on first request — no migration step, no CLI database commands,
   and no seed data. Log in and use "+ New Character" to create your first one.

### Upgrading an existing deployment

If you deployed an earlier version of this app (single hardcoded character,
`busy` boolean, `CHARACTER_SLUG`/`CHARACTER_TIMEZONE` env vars), just
redeploy — `ensureSchema()` brings the database forward automatically
(drops the old `busy` columns and the `slug` uniqueness constraint, adds
`timezone`/`created_by`/`last_planned_at`) and your existing character(s)
keep working, now reachable from the chat list instead of a single fixed
slug. `CHARACTER_SLUG` and `CHARACTER_TIMEZONE` are no longer read by
anything and can be removed from your environment variables whenever
convenient.

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

## Creating and editing characters

From the chat list, tap **+**. You can:
- Type a one-line idea ("a chaotic art student in Berlin") and hit
  **Generate** — the character-generation AI fills in name, avatar,
  tagline, persona, communication style, starting mood/activity, and a
  fitting timezone. Leave the idea blank and hit Generate for a fully
  random character instead.
- Edit any field it produced, or skip generation entirely and write
  everything yourself.
- Hit **Create** — this saves the character, generates its recurring
  weekly commitments (if any — plenty of characters have none, which is
  normal), and drops you straight into the new chat.

From inside any chat, the pencil icon in the header opens the same form
pre-filled with that character's current values, for editing later.

The **communication style** field defaults to a house texting-style guide
(concise, low-effort-friendly, no forced questions — see
`BASE_COMMUNICATION_STYLE` in `persona.mjs`) if you leave it blank; the
generation AI uses it as a strong reference and adapts it lightly per
character rather than reinventing it each time.

Events show up in `calendar_events` tagged by `source`: `recurring`
(materialized from a template), `generated` (the life-planner filling a
gap), or `planned` (the chat AI making/agreeing to something
mid-conversation). Availability (0-100) on any event controls how likely
an immediate reply is while it's active — you can hand-tune it directly in
Neon's SQL editor on `recurring_events` rows if you want to adjust a
commitment's tone after the fact.

## Cross-user isolation

Every character is tied to `created_by`, and every read/write endpoint
(`/api/me`, `/api/messages`, `/api/chat`, `/api/react`, and the PATCH path
on `/api/characters`) resolves the character strictly through a
conversation row matching *both* the given id and the requesting user —
there's no code path that looks up a character by id alone. A user who
doesn't own a conversation gets a 404, not a permissions error, so
existence isn't leaked either.

## Environment variables

| Variable                | Required | Default                  |
|--------------------------|----------|---------------------------|
| `DATABASE_URL`           | yes      | —                          |
| `GEMINI_API_KEY`         | yes      | —                          |
| `GEMINI_MODEL`           | no       | `gemini-3.1-flash-lite`    |
| `GEMINI_THINKING_LEVEL`  | no       | `low`                      |

Identity's session cookies are wired up automatically by the platform once
Identity is enabled — nothing to configure for that. Timezone and any
other per-character settings now live on the `characters` row itself
(set at creation, editable later) rather than in environment variables.

## Cost/scale notes

Two scheduled functions run independently: `heartbeat.mjs` (every 15 min,
checks up to 5 recently-active conversations, skips any it already checked
in the last 25 min) and `plan-life.mjs` (every 20 min, checks up to 10
characters, skips any it already planned for in the last 20 min and does
nothing at all — no AI call — once a character's schedule is filled
through its 3-day horizon). Each `plan-life.mjs` call that does run can
plan several hours in one go (up to 10 chained activities), so reaching
multi-day coverage takes a bounded handful of cycles per character, not
one call per activity. Both functions stay cheap as usage grows, at the
cost of things sometimes landing later than the spec's ideal cadence
(worst case for a batched reply: up to ~25 minutes after availability
improves). Character creation itself costs two extra Gemini calls
(generation + recurring commitments) — a one-time cost per character, not
per message. A calendar conflict adds one extra Gemini call (only when a
conflict actually occurs), so it's rare in practice.

## File map

```
db/schema.sql                                reference DDL (optional — app self-applies this)
netlify/functions/_lib/db.mjs                Neon connection + self-applying schema
netlify/functions/_lib/schema.mjs            table DDL only — no seed content
netlify/functions/_lib/auth.mjs              Identity verification
netlify/functions/_lib/conversation.mjs      ownership-checked conversation/character lookups
netlify/functions/_lib/calendar.mjs          calendar engine: materialize, conflicts, actions, availability rolls
netlify/functions/_lib/gemini.mjs            Gemini Interactions API client
netlify/functions/_lib/persona.mjs           system prompts + schemas for all three AI roles
netlify/functions/_lib/reply.mjs             shared reply/ack/spontaneous delivery logic (chat AI)
netlify/functions/me.mjs                     GET   /api/me                bootstrap + live status
netlify/functions/messages.mjs               GET   /api/messages         history/polling
netlify/functions/chat.mjs                   POST  /api/chat             send a message (availability-gated)
netlify/functions/react.mjs                  POST  /api/react            toggle a reaction
netlify/functions/characters.mjs             GET/POST/PATCH /api/characters  list, create, edit
netlify/functions/generate-character.mjs     POST  /api/generate-character   AI draft, no DB writes
netlify/functions/heartbeat.mjs              scheduled                   batched replies + spontaneous messages (chat AI)
netlify/functions/plan-life.mjs              scheduled                   fills calendar gaps (life-planner AI)
src/app.js                                   client logic (bundled to public/)
public/index.html, public/styles.css         chat list, character form, and chat UI
```
