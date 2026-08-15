# Level One Outreach — Operations Manual

Everything this system does, what data moves, when it moves, and what you need
to supply to make it work.

---

## Contents

1. [The one architectural rule](#1-the-one-architectural-rule)
2. [What you need — APIs and tokens](#2-what-you-need--apis-and-tokens)
3. [PocketBase setup](#3-pocketbase-setup)
4. [Operations: the trades pipeline, event by event](#4-operations-the-trades-pipeline-event-by-event)
5. [Operations: the B2B pipeline, event by event](#5-operations-the-b2b-pipeline-event-by-event)
6. [Resend — every internal alert](#6-resend--every-internal-alert)
7. [n8n — every outbound webhook payload](#7-n8n--every-outbound-webhook-payload)
8. [Inbound webhooks — what to POST to us](#8-inbound-webhooks--what-to-post-to-us)
9. [Deployment](#9-deployment)
10. [Adding a login later](#10-adding-a-login-later)

---

## 1. The one architectural rule

> **n8n sends every email that reaches a CLIENT.**
> **Resend sends every email that reaches YOU, and nobody else.**

This is not a convention you have to remember — it is enforced by the shape of
the code. `lib/resend.ts` exports a single function, `sendInternalAlert`, and
that function **takes no recipient argument**. The `to` address is read from
`INTERNAL_ALERT_EMAIL` inside the module. A route that mistakenly tries to
email a lead through Resend has nowhere to put the address.

Every client-facing email goes through `lib/n8n.ts`, which has one function per
webhook and refuses to pretend: a missing webhook URL is a hard error surfaced
in the UI, never a silent no-op.

**Ordering rule for anything client-facing.** Routes call n8n *first*, and only
record success in PocketBase afterwards. If the webhook fails you get an error
and nothing is marked as sent. The alternative — recording first — would leave
leads permanently flagged "meeting sent" when the client received nothing.

---

## 2. What you need — APIs and tokens

| Service | Env vars | What breaks without it | Where to get it |
| --- | --- | --- | --- |
| **PocketBase** | `NEXT_PUBLIC_POCKETBASE_URL` | Everything. This is the database. | Self-hosted (Coolify) |
| **Google Places** | `GOOGLE_PLACES_API_KEY`, `PLACES_MAX_CELLS` | Trades grid scraper returns 503. | [console.cloud.google.com](https://console.cloud.google.com/apis/library/places-backend.googleapis.com) — enable **Places API** *and* billing |
| **Apify** | `APIFY_TOKEN`, `APIFY_LINKEDIN_ACTOR_ID`, `APIFY_RUN_TIMEOUT_SECONDS` | B2B scraping returns 503. CSV import still works. | [console.apify.com/settings/integrations](https://console.apify.com/settings/integrations) |
| **Email verifier** | `EMAIL_VERIFIER_PROVIDER`, `EMAIL_VERIFIER_API_KEY`, `EMAIL_VERIFIER_MIN_SCORE` | Contacts import flagged **unverified** instead of being checked. | [EmailAwesome](https://emailawesome.com) or [MyEmailVerifier](https://myemailverifier.com) |
| **Resend** | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `INTERNAL_ALERT_EMAIL` | You get no alerts. Client email unaffected. | [resend.com/api-keys](https://resend.com/api-keys) — the from-domain must be verified |
| **n8n** | 4 × `N8N_WEBHOOK_*` (+ optional `N8N_WEBHOOK_CANCEL_NUDGE`) | **No client ever receives an email.** | Your own n8n instance |
| **TPS/CTPS** | `TPS_PROVIDER`, `TPS_API_URL`, `TPS_API_KEY`, `TPS_BLOCK_LISTED` | Leads stored `unchecked` with an amber **UNSCREENED** badge. | Paid licensed provider — see below |
| **Gemini** | *(none here)* | Replies never get classified or drafted. | Configured **inside n8n**, not in this app |
| **App** | `APP_BASE_URL`, `WEBHOOK_SHARED_SECRET`, `DISCOVERY_CALL_LINK`, `TRADES_MEETING_LINK` | Broken deep links; unprotected webhooks. | Yours |

### About TPS/CTPS — read this

There is **no free or official TPS lookup API**. The register is licensed
commercially. Real screening requires a paid provider — Data8, TPS Services, or
a DMA TPS Assured feed.

Until you supply one, `TPS_PROVIDER=none` and every scraped lead is saved with
`tps_status: "unchecked"` and shown with an amber **UNSCREENED** badge. The
system will never mark a number TPS-clear that has not actually been screened,
because a false "clear" is exactly how you would make an unlawful call believing
you were compliant. Calling a TPS-registered number without prior consent
breaches PECR regulation 21 and is enforced by the ICO with fines.

To enable screening, set `TPS_PROVIDER=http` and point `TPS_API_URL` at your
provider. The app POSTs:

```json
{ "phone": "+441614960000", "registers": ["tps", "ctps"] }
```

with `TPS_API_KEY` as a Bearer token, and reads a boolean from any of
`listed` / `isListed` / `onTps` / `tps` / `registered` in the reply.

### About Google Places cost

Each grid cell costs 1–3 Nearby Search calls, and **every unique result costs
one Place Details call** — that is where the phone number comes from. Real
numbers from the grid generator:

| Search radius | Cell size | Cells | Approx. Places calls | Lead ceiling |
| --- | --- | --- | --- | --- |
| 2 km | 1.5 km | 9 | ~243 | 540 |
| 5 km | 1.5 km | 37 | ~999 | 2,220 |
| 5 km | 0.8 km | 101 | ~2,727 | 6,060 |
| 20 km | 3 km | 113 | ~3,051 | 6,780 |

Compare the right-hand column to the **120 results** a single Google Maps search
returns. That gap is the entire point of the grid.

`PLACES_MAX_CELLS` (default 120) is the safety cap that stops a mistyped radius
from becoming a surprise invoice.

### Google Places does not return email addresses

Google does not hold them. That is why every trades lead card has an inline
email field — you fill it in from the business's website as you work the list.
This is expected behaviour, not a gap.

---

## 3. PocketBase setup

Six collections. Import `docs/pocketbase-schema.json` via **Settings → Import
collections**, or create them by hand from the tables below.

Every collection needs its **List, View, Create and Update** API rules set to
**public** (an empty rule). Anything else returns 403 on every request.

### `trades_leads`

| Field | Type | Notes |
| --- | --- | --- |
| `company_name` | Text | |
| `location` | Text | |
| `phone` | Text | **UNIQUE INDEX** — stored E.164 (`+441614960000`) |
| `tps_verified` | Bool | True only when a provider confirmed *not registered* |
| `tps_status` | Select | `unchecked` \| `clear` \| `listed` \| `error` |
| `email` | Text | Typed in by you; Places cannot supply it |
| `website` | Text | |
| `call_date_time` | Date | |
| `status` | Select | `scraped` \| `negative` \| `no_answer` \| `positive` |
| `meeting_sent` | Bool | |
| `place_id` | Text | **UNIQUE INDEX** — secondary dedupe key |
| `grid_cell` | Text | Which cell found this lead |

### `b2b_contacts`

| Field | Type | Notes |
| --- | --- | --- |
| `email` | Email | **UNIQUE INDEX** — the deduplication key |
| `contact_name` | Text | |
| `company_name` | Text | |
| `website` | Text | |
| `linkedin_url` | Text | |
| `email_verified` | Bool | |
| `verification_score` | Number | 0–100 |
| `niche` | Text | Your label for the batch that found them — the pool's filter |
| `source` | Select | `apify` \| `paste` \| `api` |
| `scrape_run` | Text | The `scrape_runs` id that produced them |
| `pool_status` | Select | `new` \| `in_campaign` \| `suppressed` |

### `b2b_campaigns`

| Field | Type | Notes |
| --- | --- | --- |
| `title` | Text | |
| `offer_description` | Editor | |
| `from_email` | Text | |
| `active` | Bool | |
| `daily_send_limit` | Number | First emails per day. Default 10 |
| `send_time` | Text | `"09:00"`, 24-hour |
| `send_timezone` | Text | IANA zone, e.g. `Europe/London` |
| `sending_active` | Bool | The Start/Pause switch. **Default false** |
| `last_dispatch_date` | Text | `"YYYY-MM-DD"` — the once-a-day lock |

### `b2b_outreach`

| Field | Type | Notes |
| --- | --- | --- |
| `contact` | Relation → `b2b_contacts` | single |
| `campaign` | Relation → `b2b_campaigns` | single |
| `kanban_stage` | Select | `queued` \| `sending` \| `sent_1` \| `followup_2d` \| `followup_5d` \| `replied` \| `send_failed` |
| `reply_sentiment` | Select | `pending` \| `positive` \| `negative` \| `no_reply` |
| `ai_draft_reply` | Text | |
| `call_booked` | Bool | default false |
| `call_booked_at` | Date | |
| `last_email_sent_at` | Date | **Empty until n8n confirms the send** |
| `archived` | Bool | default false |
| `send_attempts` | Number | 3 failures parks the lead |
| `queued_at` | Date | FIFO ordering for the daily batch |
| `dispatched_at` | Date | When it went to n8n; drives the stale sweep |
| `send_error` | Text | |

The three stages that matter for the send limit are `queued` (never emailed),
`sending` (handed to n8n, unconfirmed) and `sent_1` (confirmed). Only `queued`
is ever selected for a batch — that is the no-double-send guarantee, and it is
enforced by the stage value, not by any counter.

Add a **composite UNIQUE index on `(contact, campaign)`**. This is what stops a
re-import double-enrolling someone, while still allowing the same contact in a
*different* campaign — which is the whole lead-reuse model.

### `messages`

`outreach_run` (Relation → `b2b_outreach`) · `direction` (Select: `inbound` \| `outbound`) · `subject` (Text) · `body` (Text) · `sent_at` (Date)

### `scrape_runs`

`kind` (Select: `trades` \| `b2b`) · `status` (Select: `queued` \| `running` \| `complete` \| `failed`) · `params` (JSON) · `cells_total`, `cells_done`, `found`, `imported`, `duplicates`, `blocked` (Number) · `error` (Text) · `started_at`, `finished_at` (Date)

> **Indexes are not optional.** PocketBase does not infer them. Without the
> unique index on `trades_leads.phone`, two concurrent imports can both pass the
> in-memory duplicate check and you get double entries. The code catches the
> index violation and counts it as a duplicate — but only if the index exists.

**Verify the whole setup** by opening `/api/health` after deploying. It reports
every collection individually and which integrations are wired up, without ever
echoing a key.

---

## 4. Operations: the trades pipeline, event by event

### 4.1 You start a grid scrape

**You do:** Trades → *Scrape Leads* → enter trade ("plumber"), location
("Manchester" or a postcode), search radius, cell size.

**System does:**

1. Geocodes your location text into coordinates (Google Geocoding).
2. `lib/grid.ts` divides the area into a lattice of overlapping circular cells.
   Cell spacing is `cellRadius × √2 × 0.9` — the spacing at which neighbouring
   circles fully cover the squares between them, with a further 10% overlap so
   a business sitting on a boundary is not lost to rounding. Cells are sorted
   centre-outwards, so a capped run still covers the heart of your target area.
3. Creates a `scrape_runs` record and **returns immediately** with its id.
4. Processes cells in a detached server-side loop. Per cell: Nearby Search (up
   to 3 pages, with the 2s pause Google requires between page tokens) → drop
   `place_id`s already seen → Place Details per new result for phone + website.
5. Each cell's batch goes through the import pipeline (below) and progress is
   written to the run record.

**You see:** a live progress bar — cell N of M, found / imported / duplicates /
blocked. **Closing the tab does not stop the scrape**, because none of its state
lives in the browser.

**Emails sent:** none.

### 4.2 A lead is imported

For every scraped business, in this order:

1. **Normalise** the phone to E.164. Google writes the same number as
   `0161 496 0000`, `+44 161 496 0000`, `(0161) 4960000` and `00441614960000` —
   all four collapse to `+441614960000`. Unparseable numbers are rejected
   outright rather than saved looking valid.
2. **Deduplicate** against the database *and* within the batch, on phone and on
   `place_id`. Duplicates are counted, not saved. This happens before screening
   so you never pay a TPS provider to check a number you already hold.
3. **TPS/CTPS screen** the survivors. With `TPS_BLOCK_LISTED=true` (default),
   registered numbers are discarded at import.
4. **Save** with `status: "scraped"`.

**Emails sent:** none. If the run crashes, a `system_error` Resend alert fires.

### 4.3 You log a call

**You do:** *Call Made* → Negative / No Answer / Positive.

**System does:** updates `status`. That is all. The card animates out of the
current tab and the badge counts adjust.

**Emails sent:** none — deliberately. Logging a call and emailing a client are
two separate decisions. Collapsing them would mean a mis-click on "Positive"
fires a meeting invite at someone you have not agreed a time with.

### 4.4 You send the meeting email

**You do:** on the Positive tab, fill in the email field if empty, then
*Send Meeting Email*.

**System does, in order:**

1. **n8n** → `N8N_WEBHOOK_TRADES_MEETING` sends the client their meeting link.
2. Only on success: `meeting_sent = true`.
3. **Resend** → alert **#1** to you.

If step 1 fails you get the reason on screen and nothing is marked sent.

---

## 5. Operations: the B2B pipeline, event by event

The B2B side is three separate stages, and keeping them separate is the point:
**scrape into a pool → put pooled leads in a campaign's queue → the app sends
that queue at a fixed pace.** Nothing skips a stage; in particular, no import
and no scrape ever sends an email.

### 5.0 You scrape a niche (`/leads`)

**You do:** pick a scraper, name the niche, fill in its fields, Start.

**System does:** starts the Apify actor, polls it to completion inside this app
(not in n8n), pulls the dataset, normalises it, verifies the addresses and
writes contacts to the **lead pool** tagged with your niche. No campaign is
touched and nobody is enrolled.

Results with no email address are dropped — an address is the whole point of a
cold-email lead. If an actor returns results but *none* carry an email, the run
is marked failed and says so, because a silently empty pool looks identical to
a broken scrape.

### 5.1 You create a campaign

Title, offer description, the address it sends from, and its **pace**: emails
per day, the time of day they leave, and the timezone that time is read in. A
campaign is **one offer from one sender at one pace**. Contacts are stored
separately — which is what lets you re-target a lead from six months ago with a
new offer without duplicating their contact record.

A new campaign is created **paused**. Sending starts when you press Start.

### 5.2 Contacts enter a campaign's QUEUE

Two doors, one pipeline:

- **From the pool** (`/leads` → select → *Add to campaign*) — the normal path
- **Paste import** (B2B → *Import*, CSV or TSV with a header row)

**System does:**

1. Lowercase, trim, de-duplicate within the batch.
2. **Verify** deliverability. Below `EMAIL_VERIFIER_MIN_SCORE` (default 80) the
   address is rejected. `catch_all` scores 70 — deliberately just under, because
   the domain accepts everything so the address is unproven.
3. **Contact**: reuse if the email already exists (filling only blank fields —
   a later scrape never erases a good company name), otherwise create.
4. **Enrol**: create a `b2b_outreach` row at stage **`queued`**, with
   `last_email_sent_at` empty. Already in this campaign → skipped.
   **Re-importing the same list is safe and never double-emails anyone.**

**Nothing is emailed here.** Tip 500 leads into a campaign that sends 10 a day
and exactly 10 go out at the next send time.

**You see:** `X queued · Y existing contacts reused · Z already in campaign ·
N rejected`, followed by how long that will take at the campaign's pace.

### 5.2b The daily batch goes out

A ticker inside the app (`instrumentation.ts`) wakes every minute and asks each
active campaign whether it is due. When it is:

1. **Sweep** — anything stuck in `sending` for over 2 hours (n8n never
   confirmed it) goes back to `queued`.
2. **Claim the day** — `last_dispatch_date` is written *before* sending. The
   ticker fires 1440 times a day; this field is what makes "once a day" true.
3. **Take the front of the queue** — up to `daily_send_limit` runs at stage
   `queued`, oldest first.
4. **Claim each lead** — flip to `sending`, so a second tick cannot take the
   same leads.
5. **Send** — one webhook call to n8n with just that batch.
6. **Confirm** — n8n POSTs each result to `/api/webhooks/email-sent`; success
   moves the lead to `sent_1` and stamps `last_email_sent_at`.

**Why a lead never gets the same first email twice:** selection only ever looks
at `queued`. A lead that has been emailed is `sent_1`, which is invisible to
selection; a lead mid-flight is `sending`, also invisible. The only way back to
`queued` is a reported failure or the stale sweep — both of which mean the
email genuinely did not arrive.

*"Send next batch"* on the board runs the same code with the clock and the day
lock bypassed. It still honours the daily limit and still only takes `queued`
leads, so pressing it twice sends one batch and then finds nothing to do.

### 5.3 The sequence runs

n8n owns the follow-up timers. Cards move `sent_1` → `followup_2d` (day 2) →
`followup_5d` (day 5) as each email actually goes out. Follow-ups are **not**
counted against the daily limit — that limit governs first emails, which are
the ones that grow the campaign.

### 5.4 A client replies — the auto-pause

**Client does:** replies to any email in the sequence.

**n8n does:** captures the reply → Gemini classifies it `positive` / `negative` /
`no_reply` and drafts a response for positives → POSTs to
`/api/webhooks/inbound-reply`.

**System does:**

1. Sets `kanban_stage: "replied"`. **This is the auto-pause.** Your n8n
   follow-up Wait nodes re-check this stage before sending, so someone who
   replies on day 3 never receives the day-5 follow-up.
2. Stores the sentiment, the AI draft, and the inbound message.
3. **Resend** → alert **#2**, *positives only*. A negative reply is handled from
   the inbox at your convenience and does not warrant interrupting you.

The card leaves the Kanban board and appears in the AI Inbox.

### 5.5 You send the response — and the 24-hour tracker starts

**You do:** Inbox → Positive → edit the draft → *Send Response*.

**System does, in order:**

1. **n8n** → `N8N_WEBHOOK_DISPATCH_RESPONSE`. n8n emails the client your text
   with the discovery-call link, then enters a **24-hour Wait node**.
2. Logs the outbound message; clears the draft so the inbox cannot offer to
   send the same reply twice.
3. **Resend** → alert **#3**.

What gets sent is whatever is in the textarea at that moment — your edits
included. The draft is a starting point, not an outbox.

### 5.6 The 24-hour outcome

**Booked:** the calendar tool POSTs `/api/webhooks/calendar-booked` →
`call_booked = true` → n8n's timer cancelled → **Resend alert #4**.

**Not booked:** the Wait node expires. n8n re-checks `call_booked` in PocketBase
and, if still false, sends a short polite nudge asking whether they got the
previous message. No Resend alert — nothing happened that you need to know about
in the moment.

### 5.7 A negative reply

**You do:** Inbox → Negative → *Send apology & archive*.

**System does:** **n8n** → `N8N_WEBHOOK_NEGATIVE_REPLY` sends the polite apology
with a greeting matched to their local time of day, then the run is archived.

The greeting is chosen **inside n8n at send time**, not when you click. If it
were computed on click, an email sitting in a queue for two hours could open
with the wrong one.

**Emails to you:** none. You clicked it; being emailed about your own click is
noise.

---

## 6. Resend — every internal alert

Five alerts. All to `INTERNAL_ALERT_EMAIL`. **No client ever receives one.**

Each is plain HTML with a facts table and a deep link back into the app —
optimised for legibility on a phone lock screen, not for design.

### #1 — Meeting email sent

- **Fires:** you click *Send Meeting Email*, after n8n confirms.
- **Subject:** `Meeting email sent — {company_name}`
- **Contains:** Company, Email, Phone, Location, Scheduled for, Meeting link
- **Link:** `/trades?status=positive`

### #2 — Positive reply received

- **Fires:** inbound webhook classifies a reply as `positive`. **The most
  valuable of the five** — it is the only one that tells you something you did
  not already know.
- **Subject:** `Positive reply — {contact_name} @ {company_name}`
- **Contains:** Contact, Email, Company, Campaign, their subject, first 400
  characters of their message
- **Link:** `/inbox`

### #3 — Response sent

- **Fires:** you click *Send Response*, after n8n confirms.
- **Subject:** `Response sent — {contact_name} · 24h call tracker started`
- **Contains:** Contact, Email, Company, Campaign, Sent from, Subject, Booking link
- **Link:** `/inbox`

### #4 — Discovery call booked

- **Fires:** the calendar webhook. Also fires for a booking from someone with
  **no matching outreach run** (a referral or a directly shared link) — flagged
  as such, because a booked call is worth knowing about either way.
- **Subject:** `Discovery call booked — {contact_name}, {booked_for}`
- **Contains:** Contact, Email, Company, Campaign, Booked for, Reference
- **Link:** `/inbox`

### #5 — System error

- **Fires:** a scrape run crashes, or contacts are enrolled but the n8n sequence
  webhook fails (**enrolled but nothing emailed** — silence here would be the
  worst outcome in the system).
- **Subject:** `Outreach system alert — {reason}`
- **Contains:** Reason, and context for what failed.

**Alerts never block anything.** By the time one fires, the thing it announces
has already happened. A Resend outage is reported in the API response
(`alert_sent: false`, `alert_reason`) and surfaced in the toast, never thrown.

---

## 7. n8n — every outbound webhook payload

All four POST `Content-Type: application/json`. Every payload includes
`event`, `sent_at` (ISO 8601) and the PocketBase record ids, so a workflow can
always call back and update what it acted on. 20-second timeout.

### 7.1 `N8N_WEBHOOK_TRADES_MEETING`

Fired when you send a meeting email to a positive trades lead.

```json
{
  "event": "trades_meeting_email",
  "sent_at": "2026-08-13T14:22:05.412Z",
  "lead_id": "a1b2c3d4e5f6g7h",
  "company_name": "Bright Spark Electrical",
  "contact_email": "info@brightspark.co.uk",
  "phone": "+441614960000",
  "location": "12 Deansgate, Manchester M3 2BW",
  "call_date_time": "2026-08-15T10:00:00.000Z",
  "meeting_link": "https://zoom.us/j/123456789"
}
```

`call_date_time` is `null` when no call has been scheduled on the card.

### 7.2 `N8N_WEBHOOK_B2B_SEQUENCE`

Fired **once a day with that day's batch**, not on enrolment. **One call for
the whole batch** — 10 recipients as 10 webhook calls is what breaks n8n's own
rate limits first.

```json
{
  "event": "b2b_batch_send",
  "sent_at": "2026-08-13T14:30:11.882Z",
  "campaign": {
    "campaign_id": "k9j8h7g6f5d4s3a",
    "title": "Q3 Automation Pitch",
    "offer_description": "We build automated lead systems for UK agencies…",
    "from_email": "dean@levelone.digital"
  },
  "callback_url": "https://your-domain/api/webhooks/email-sent",
  "follow_up_schedule": [2, 5],
  "recipients": [
    {
      "outreach_id": "o1u2t3r4e5a6c7h",
      "contact_id": "c1o2n3t4a5c6t7",
      "contact_name": "Jane Doe",
      "contact_email": "jane@acme.co.uk",
      "company_name": "Acme Ltd",
      "website": "https://acme.co.uk",
      "linkedin_url": "https://linkedin.com/in/janedoe"
    }
  ]
}
```

`follow_up_schedule` is days after the first email. `recipients` holds only
today's batch — its length is the campaign's `daily_send_limit`, or whatever is
left in the queue.

**Your workflow must:**

1. Send the first email.
2. **POST the outcome to `callback_url`** with the `x-webhook-secret` header
   (see §8.3). This is not optional — the app does not mark a lead as emailed
   until this arrives, and that is what stops tomorrow's batch re-sending to
   the same person.
3. Wait 2 days → re-check `kanban_stage` in PocketBase → if not `replied`, send
   follow-up 1 and set stage `followup_2d`. Repeat at day 5 for `followup_5d`.
   **The stage re-check is the auto-pause** — without it, a client who replied
   still gets follow-ups.

Note the split: n8n sets the stage itself for *follow-ups*, but the *first*
email's stage transition happens through the callback, because that one is what
the send limit counts.

### 7.3 `N8N_WEBHOOK_DISPATCH_RESPONSE`

Fired when you approve and send a response to a positive reply.

```json
{
  "event": "positive_reply_response",
  "sent_at": "2026-08-13T15:02:44.109Z",
  "outreach_id": "o1u2t3r4e5a6c7h",
  "campaign_id": "k9j8h7g6f5d4s3a",
  "contact_id": "c1o2n3t4a5c6t7",
  "contact_name": "Jane Doe",
  "contact_email": "jane@acme.co.uk",
  "company_name": "Acme Ltd",
  "website": "https://acme.co.uk",
  "linkedin_url": "https://linkedin.com/in/janedoe",
  "from_email": "dean@levelone.digital",
  "subject": "Re: Q3 Automation Pitch",
  "body": "Hi Jane,\n\nGreat to hear from you…",
  "discovery_call_link": "https://cal.com/levelone/discovery",
  "start_booking_timer": true,
  "timer_hours": 24
}
```

**Your workflow must:** send the email → Wait 24 hours → re-read `call_booked`
from PocketBase → if still false, send the nudge.

### 7.4 `N8N_WEBHOOK_NEGATIVE_REPLY`

```json
{
  "event": "negative_reply_apology",
  "sent_at": "2026-08-13T15:10:02.771Z",
  "outreach_id": "o1u2t3r4e5a6c7h",
  "campaign_id": "k9j8h7g6f5d4s3a",
  "contact_id": "c1o2n3t4a5c6t7",
  "contact_name": "Jane Doe",
  "contact_email": "jane@acme.co.uk",
  "company_name": "Acme Ltd",
  "website": "https://acme.co.uk",
  "linkedin_url": "https://linkedin.com/in/janedoe",
  "from_email": "dean@levelone.digital",
  "local_timezone": "Europe/London",
  "greeting_mode": "time_of_day"
}
```

**Your workflow must** derive "good morning / afternoon / evening" from
`local_timezone` **at the moment of sending**.

### 7.5 `N8N_WEBHOOK_CANCEL_NUDGE` *(optional)*

```json
{
  "event": "discovery_call_booked",
  "sent_at": "2026-08-13T16:44:00.000Z",
  "outreach_id": "o1u2t3r4e5a6c7h",
  "contact_email": "jane@acme.co.uk",
  "booked_for": "2026-08-16T11:00:00.000Z",
  "cancel_nudge": true
}
```

Leave the env var unset if your workflow re-reads `call_booked` before nudging —
that is the more robust design, and this hook becomes a no-op.

### Responses

Any 2xx is success. A workflow ending in *Respond to Webhook* can return JSON,
which is passed back to the UI. A non-2xx or a timeout is reported to you as a
failed send, and nothing is marked as sent.

---

## 8. Inbound webhooks — what to POST to us

Both are publicly reachable and **both require the header:**

```
x-webhook-secret: <WEBHOOK_SHARED_SECRET>
```

(`Authorization: Bearer <secret>` also works.) The comparison is constant-time.
Leaving `WEBHOOK_SHARED_SECRET` unset disables the check and logs a loud
warning — fine locally, never in production. Without it, anything that discovers
these URLs can inject fake replies and mark calls booked.

Both routes accept a bare object **or** a single-element array, because n8n's
HTTP Request node wraps its output in an array by default.

### 8.1 `POST /api/webhooks/inbound-reply`

Send this after Gemini has classified the reply.

```json
{
  "outreach_id": "o1u2t3r4e5a6c7h",
  "contact_email": "jane@acme.co.uk",
  "campaign_id": "k9j8h7g6f5d4s3a",
  "sentiment": "positive",
  "ai_draft_reply": "Hi Jane,\n\nThanks for coming back to me…",
  "subject": "Re: Q3 Automation Pitch",
  "body": "This looks interesting — can you send some times?",
  "received_at": "2026-08-13T14:55:00.000Z"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `outreach_id` | one of these two | Preferred — exact match |
| `contact_email` | one of these two | Fallback for mailbox triggers that only know the sender; resolves to their most recent live run |
| `campaign_id` | no | Narrows the email fallback |
| `sentiment` | **yes** | `positive` \| `negative` \| `no_reply` |
| `ai_draft_reply` | no | Gemini's draft. Shown in the composer |
| `subject`, `body` | no | The client's message, logged to `messages` |
| `received_at` | no | Defaults to now |

**Reply:**

```json
{
  "ok": true,
  "outreach_id": "o1u2t3r4e5a6c7h",
  "kanban_stage": "replied",
  "sentiment": "positive",
  "sequence_paused": true,
  "alert_sent": true
}
```

A **404** means no live outreach run matched — a forwarded thread, or a deleted
campaign. Do not redeliver it.

### 8.2 `POST /api/webhooks/calendar-booked`

Point your calendar tool's booking webhook here, directly or via n8n.

```json
{
  "outreach_id": "o1u2t3r4e5a6c7h",
  "contact_email": "jane@acme.co.uk",
  "booked_for": "2026-08-16T11:00:00.000Z",
  "booking_reference": "cal_evt_8812"
}
```

One of `outreach_id` or `contact_email` is required; the rest are optional.

**Reply:**

```json
{
  "ok": true,
  "matched": true,
  "outreach_id": "o1u2t3r4e5a6c7h",
  "call_booked": true,
  "nudge_cancelled": true,
  "alert_sent": true
}
```

`"matched": false` means the booking came from someone with no outreach run —
still alerted, nothing updated.

### 8.3 `POST /api/webhooks/email-sent`

**The most important callback in the system.** n8n reports that a first email
has actually gone out (or failed). Until this arrives the lead sits at stage
`sending` and is counted as not-yet-emailed.

Post one result per recipient:

```json
{
  "outreach_id": "o1u2t3r4e5a6c7h",
  "status": "success",
  "subject": "Quick question about Acme's lead flow",
  "body": "Hi Jane, …",
  "sent_at": "2026-08-16T08:00:04.113Z"
}
```

…or the whole batch at once, as `{"results": [ … ]}` or a plain JSON array.

On failure, report it — do not stay silent:

```json
{
  "outreach_id": "o1u2t3r4e5a6c7h",
  "status": "failed",
  "error": "SMTP 550 mailbox unavailable"
}
```

**What each outcome does:**

| `status` | Effect |
|---|---|
| `success` | Stage → `sent_1`, `last_email_sent_at` stamped, an outbound `messages` row logged for the Inbox thread |
| `failed` | `send_attempts` + 1, stage → `queued` to retry another day; after 3 attempts → `send_failed`, plus an internal alert |
| *(never sent)* | Lead stays `sending` until the 2-hour stale sweep returns it to `queued` — it works, but costs that lead a day |

**Reply:**

```json
{ "ok": true, "confirmed": 10, "failed": 0, "ignored": 0, "errors": [] }
```

`ignored` counts results for leads that were not at stage `sending` — an
already-applied duplicate, or a lead that has since replied. This is deliberate
and safe: **the endpoint is idempotent**, so retrying a callback never
double-counts and never drags a replied lead backwards. A 502 means PocketBase
was unreachable and n8n *should* retry; a 200 means the result was recorded or
knowingly ignored.

---

## 9. Deployment

Standard Next.js 15. On Coolify:

1. Point at this repo, build `npm run build`, start `npm run start`.
2. Paste `.env.example` into the environment panel and fill it in.
3. Deploy PocketBase and import `docs/pocketbase-schema.json`.
4. **Add the two unique indexes and the composite index by hand** — the import
   does not always carry them.
5. Open `/api/health` and confirm all six collections report `ok`.
6. Point your n8n workflows' callbacks at `https://<your-domain>/api/webhooks/…`
   with the shared secret header.
7. **Set `APP_BASE_URL`.** The daily dispatcher refuses to send without it —
   it is the callback address n8n needs to confirm a send, and without a
   confirmation every lead would strand mid-flight.
8. Leave `DISPATCH_TICKER_ENABLED` unset. The send scheduler is an interval
   inside the Node process, so it needs the long-lived server Coolify gives
   you. On a **second replica**, set it to `false` — one ticker is enough.
   On a serverless host there is no persistent process at all: set it `false`
   and POST `{"campaign_id":"…"}` to `/api/b2b/dispatch` from a platform cron
   instead.

### Post-deploy smoke test

```bash
# 1. Config and connectivity
curl https://<domain>/api/health

# 2. Webhook auth — must be 401
curl -X POST https://<domain>/api/webhooks/calendar-booked \
  -H 'Content-Type: application/json' -d '{"contact_email":"a@b.com"}'

# 3. Webhook auth — with the secret
curl -X POST https://<domain>/api/webhooks/calendar-booked \
  -H 'Content-Type: application/json' \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET" \
  -d '{"contact_email":"a@b.com","booked_for":"2026-09-01T10:00:00Z"}'
```

To confirm payload shapes before wiring real workflows, point the four
`N8N_WEBHOOK_*` vars at [webhook.site](https://webhook.site) URLs and click
through the UI — every body in §7 will appear there verbatim.

---

## 10. Adding a login later

The app currently has no auth, matching the Proposal Engine. Three steps when
you are ready:

1. **PocketBase:** create a `users` auth collection. Change every collection's
   List / View / Create / Update rules from public to `@request.auth.id != ""`.
2. **App:** add `/login` posting to `pb.collection("users").authWithPassword()`,
   store the auth cookie, and teach `createPublicClient()` in
   `lib/pocketbase.ts` to load it. That function is the **single place** that
   needs to learn about auth — every route already goes through it.
3. **Middleware:** add `middleware.ts` matching `/trades`, `/b2b`, `/inbox` and
   the non-webhook API routes. **Exclude `/api/webhooks/*`** — those are
   machine-to-machine and are already protected by the shared secret.

The webhook shared secret is worth setting **now**, regardless. It is the only
thing standing between a public URL and your pipeline.
