# Level One Outreach

Lead management and automated outreach for Level One Digital. Two pipelines,
one command centre:

- **Trades cold calling** — scrape local trades from Google Maps using
  geographic grid partitioning, deduplicate by phone, screen against TPS/CTPS,
  and work the calling list.
- **B2B cold email** — scrape and verify B2B contacts into a lead pool, queue
  them into reusable campaigns, drip them out at a fixed daily limit, track the
  follow-up sequence, and handle AI-classified replies.

## The rule that shapes the system

> **n8n sends every email that reaches a CLIENT.**
> **Resend sends every email that reaches YOU, and nobody else.**

This is enforced structurally: `lib/resend.ts` exports one function that takes
**no recipient argument** — the address comes from `INTERNAL_ALERT_EMAIL`
inside the module, so a client cannot be reached through it even by mistake.
All client email goes through `lib/n8n.ts`.

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in — every var is documented there
npm run dev
```

Then open `/api/health` to confirm PocketBase and your integrations are wired
up. It reports each collection individually and never echoes a key.

## Documentation

| Document | What's in it |
| --- | --- |
| **[docs/OPERATIONS.md](docs/OPERATIONS.md)** | The full operations manual: every event, every Resend alert, every n8n JSON payload, and the API/token checklist. **Start here.** |
| [docs/n8n-workflows.md](docs/n8n-workflows.md) | The five n8n workflows, node by node, with the Gemini prompt. |
| [docs/pocketbase-schema.json](docs/pocketbase-schema.json) | Importable collection definitions. |
| [.env.example](.env.example) | Every environment variable, with what breaks without it. |

## How the grid scraper beats Google's 120-result cap

A single Google Maps search returns at most ~120 results no matter how you page
it. That ceiling is **per search**, not per area — so the scraper runs many
small searches instead of one big one, carving the target into a lattice of
overlapping circular cells (`lib/grid.ts`).

| Search radius | Cell size | Cells | Places calls | Lead ceiling |
| --- | --- | --- | --- | --- |
| 2 km | 1.5 km | 9 | ~243 | 540 |
| 5 km | 1.5 km | 37 | ~999 | **2,220** |
| 5 km | 0.8 km | 101 | ~2,727 | 6,060 |

Runs are background jobs tracked in `scrape_runs`, so closing the tab does not
stop a scrape — the browser only polls for progress.

Note that Google Places does not return email addresses; that is why each lead
card has an inline email field.

## Architecture

```
app/
  trades/     grid scraper + calling board with the call-logger modal
  leads/      B2B lead pool — Apify scraper, filters, add-to-campaign
  b2b/        campaign switcher + send controls + Kanban + import
  inbox/      AI inbox and reply console
  api/        routes and the three inbound webhook receivers
lib/
  n8n.ts          ALL client-facing email
  resend.ts       ONLY internal alerts (structurally incapable of more)
  b2b-dispatch.ts the daily send engine — who gets emailed, and when
  b2b-import.ts   pool writes and campaign enrolment, deliberately separate
  grid.ts         geographic partitioning maths
  places.ts       Google Places client
  apify.ts        Apify actor client
  apify-actors.ts actor profiles — what the scrape form asks for
  tps.ts          pluggable TPS/CTPS screening
  phone.ts        E.164 normalisation — the trades dedupe key
instrumentation.ts  the once-a-minute ticker that drives daily sends
```

## How the daily send limit works

Enrolling a lead does not email it. A lead joins a campaign at stage `queued`
and only moves on when n8n confirms an email actually left:

```
queued ──(daily batch claims it)──▶ sending ──(n8n: success)──▶ sent_1
   ▲                                   │
   └────(n8n: failed, or 2h silence)───┘
```

Each day's batch selects **only `queued` leads**, up to the campaign's
`daily_send_limit`, oldest first. A lead that has been emailed is `sent_1` and
is invisible to that selection — so with 100 leads at 10/day, days 1, 2 and 3
send leads 1-10, 11-20 and 21-30, and nobody receives the first email twice.

The app schedules this itself (see `instrumentation.ts`); n8n is the mail
transport, not the scheduler.

## Compliance note

There is no free or official TPS lookup API — real screening needs a paid
licensed provider. With `TPS_PROVIDER=none`, leads are stored `unchecked` and
badged **UNSCREENED**. The system never marks a number TPS-clear that has not
actually been screened. See
[OPERATIONS.md §2](docs/OPERATIONS.md#about-tpsctps--read-this).

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind 3.4 ·
framer-motion · PocketBase · Resend · Zod

Visual identity — palette, logo, typography and page transitions — is carried
over from the Level One Proposal Engine. The whole theme lives in the custom
properties at the top of `app/globals.css`.
