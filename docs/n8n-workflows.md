# n8n Workflows

Five workflows. Four receive from this app; one posts back into it. The exact
JSON body each one receives is in [OPERATIONS.md §7](./OPERATIONS.md#7-n8n--every-outbound-webhook-payload).

Your **Gemini credentials live here**, not in the app. This app never calls
Gemini directly.

---

## Workflow 1 — Trades Meeting Email

**Trigger:** Webhook, POST → set `N8N_WEBHOOK_TRADES_MEETING` to its URL.

```
Webhook  →  Send Email  →  Respond to Webhook
```

Body fields available: `company_name`, `contact_email`, `phone`, `location`,
`call_date_time`, `meeting_link`, `lead_id`.

`call_date_time` is `null` when no call was scheduled — branch on it rather than
printing "null" into the email.

---

## Workflow 2 — B2B Sequence

**Trigger:** Webhook, POST → `N8N_WEBHOOK_B2B_SEQUENCE`.

Receives the **whole batch** in one call: `campaign` plus a `recipients` array.

```
Webhook
  → Split Out (field: recipients)
  → Send Email                                  ← first cold email
  → PocketBase: PATCH b2b_outreach/{outreach_id}   kanban_stage = sent_1
  → Wait 2 days
  → PocketBase: GET b2b_outreach/{outreach_id}
  → IF kanban_stage != "replied"                ← THE AUTO-PAUSE
      → Send Email (follow-up 1)
      → PATCH kanban_stage = followup_2d
      → Wait 3 days                             ← day 5 overall
      → GET b2b_outreach/{outreach_id}
      → IF kanban_stage != "replied"
          → Send Email (follow-up 2)
          → PATCH kanban_stage = followup_5d
```

> **The two stage re-checks are the auto-pause.** Without them, a client who
> replied on day 3 still receives the day-5 follow-up. Do not replace them with
> an in-memory flag — the reply arrives through a *different* workflow, so the
> only shared truth is PocketBase.

Personalisation available per recipient: `contact_name`, `company_name`,
`website`, `linkedin_url`, plus `campaign.offer_description` and
`campaign.from_email` as the sender.

---

## Workflow 3 — Inbound Reply → Gemini → back to the app

**Trigger:** your mailbox (Gmail / IMAP node) watching the campaign inbox.

```
Email Trigger
  → Gemini (classify + draft)
  → HTTP Request → POST {APP_BASE_URL}/api/webhooks/inbound-reply
                   header: x-webhook-secret: {WEBHOOK_SHARED_SECRET}
```

### Gemini prompt

Ask for **strict JSON only**, no markdown fence:

```
You are triaging a reply to a B2B cold email.

Classify the sentiment as exactly one of: positive, negative, no_reply.
  positive — any interest, questions, or a request for more information
  negative — a clear no, an unsubscribe request, or hostility
  no_reply — an auto-responder, out-of-office, or bounce

If and only if the sentiment is positive, write a short, warm, professional
reply that thanks them, answers what they asked, and invites them to book a
discovery call. Do not include a signature or a subject line.

Return JSON only, with exactly these keys:
{"sentiment": "...", "ai_draft_reply": "..."}

The reply you are triaging:
---
{{ $json.text }}
```

### What to POST

```json
{
  "contact_email": "{{ $json.from }}",
  "sentiment": "{{ $json.sentiment }}",
  "ai_draft_reply": "{{ $json.ai_draft_reply }}",
  "subject": "{{ $json.subject }}",
  "body": "{{ $json.text }}"
}
```

Include `outreach_id` instead of `contact_email` if you have it — it is an exact
match rather than a lookup.

The app sets `kanban_stage: "replied"` (pausing workflow 2), stores the draft,
and alerts you by Resend for positives.

**A 404 reply means no live outreach run matched.** Do not retry it.

---

## Workflow 4 — Dispatch Response + 24h Booking Tracker

**Trigger:** Webhook, POST → `N8N_WEBHOOK_DISPATCH_RESPONSE`.

```
Webhook
  → Send Email                        ← body + discovery_call_link, from from_email
  → Wait 24 hours
  → PocketBase: GET b2b_outreach/{outreach_id}
  → IF call_booked == false
      → Send Email (short nudge)
```

The nudge should be two lines: did they get the previous message, and do they
have two minutes to book. Nothing longer.

> **Re-read `call_booked` from PocketBase after the Wait** rather than trusting
> a cancel signal. The booking arrives through workflow 5 or straight from your
> calendar tool — PocketBase is the only place both paths agree.

---

## Workflow 5 — Calendar Booking

Your calendar tool can POST **directly** to the app, in which case no n8n
workflow is needed:

```
POST {APP_BASE_URL}/api/webhooks/calendar-booked
Header: x-webhook-secret: {WEBHOOK_SHARED_SECRET}

{
  "contact_email": "jane@acme.co.uk",
  "booked_for": "2026-08-16T11:00:00.000Z",
  "booking_reference": "cal_evt_8812"
}
```

If your calendar tool cannot set custom headers, relay through n8n:

```
Webhook (from calendar)  →  HTTP Request → POST /api/webhooks/calendar-booked
                                            with the secret header
```

The app sets `call_booked = true`, optionally fires
`N8N_WEBHOOK_CANCEL_NUDGE`, and alerts you.

---

## Testing before you build the real workflows

Point all four `N8N_WEBHOOK_*` vars at [webhook.site](https://webhook.site) URLs
and click through the app. Every payload in OPERATIONS.md §7 appears there
verbatim, so you can build each workflow against a real body rather than a
guessed one.

## Common mistakes

| Symptom | Cause |
| --- | --- |
| App reports "Invalid payload" from a webhook | n8n's HTTP Request node wraps output in an array. The app unwraps single-element arrays automatically, but a multi-element one will fail — use Split Out first. |
| Clients get follow-ups after replying | Workflow 2 is missing a `kanban_stage` re-check after a Wait node. |
| Nudge sent to someone who booked | Workflow 4 is not re-reading `call_booked` after its Wait. |
| Inbound webhook returns 401 | Missing `x-webhook-secret` header. |
| "Enrolled but nothing emailed" alert | Workflow 2's webhook is unreachable or erroring. The contacts are safely enrolled — fix the workflow, then re-import the same list (already-enrolled contacts are skipped, so nobody is double-emailed). |
