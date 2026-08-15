import { checkWebhookAuth, fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  isNotFound,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { emailSentSchema, type EmailSentResult } from "@/lib/schema";
import type { B2BOutreach } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Matches MAX_SEND_ATTEMPTS in lib/b2b-dispatch.ts. */
const MAX_SEND_ATTEMPTS = 3;

/**
 * n8n reports that a first email has actually been sent.
 *
 * This is the keystone of the daily send limit. A lead is claimed as `sending`
 * when it is handed to n8n and only becomes `sent_1` here — which is why
 * tomorrow's batch, selecting `queued` runs only, can never re-email someone
 * who has already had the first message.
 *
 * Accepts one result, or `{results: […]}` for a whole batch at once.
 *
 * Only `sending` → `sent_1` is allowed. A duplicate callback, or one that
 * arrives after the lead has already replied, is acknowledged and ignored
 * rather than dragging a replied lead backwards onto the board.
 */
export async function POST(request: Request) {
  const unauthorized = checkWebhookAuth(request);
  if (unauthorized) return unauthorized;

  const parsed = await parseBody(request, emailSentSchema);
  if (!parsed.success) return parsed.response;

  const results: EmailSentResult[] = Array.isArray(parsed.data)
    ? parsed.data
    : "results" in parsed.data
      ? parsed.data.results
      : [parsed.data];

  const pb = createPublicClient();
  const applied: string[] = [];
  const ignored: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];

  for (const result of results) {
    try {
      let run: B2BOutreach;
      try {
        run = await pb
          .collection(COLLECTIONS.b2bOutreach)
          .getOne<B2BOutreach>(result.outreach_id);
      } catch (err) {
        if (isNotFound(err)) {
          ignored.push(result.outreach_id);
          continue;
        }
        throw err;
      }

      /* The idempotency guard. Anything not currently claimed has either been
         confirmed already or has moved on, and must not be rewritten. */
      if (run.kanban_stage !== "sending") {
        ignored.push(result.outreach_id);
        continue;
      }

      if (result.status === "success") {
        const sentAt = result.sent_at || new Date().toISOString();

        await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
          kanban_stage: "sent_1",
          last_email_sent_at: sentAt,
          dispatched_at: "",
          send_error: "",
        });

        /* Log the outbound message so the thread in the AI Inbox shows what
           the client was actually sent, not just that something was. */
        if (result.subject || result.body) {
          await pb
            .collection(COLLECTIONS.messages)
            .create({
              outreach_run: run.id,
              direction: "outbound",
              subject: result.subject,
              body: result.body,
              sent_at: sentAt,
            })
            .catch((err) =>
              console.error(`[email-sent] message log failed for ${run.id}:`, err)
            );
        }

        applied.push(run.id);
        continue;
      }

      // ---- Failure: retry on a later day, then park it ----------------
      const attempts = (run.send_attempts ?? 0) + 1;
      const exhausted = attempts >= MAX_SEND_ATTEMPTS;

      await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
        kanban_stage: exhausted ? "send_failed" : "queued",
        send_attempts: attempts,
        dispatched_at: "",
        send_error: (result.error || "n8n reported a failed send.").slice(0, 500),
      });

      failed.push(run.id);
    } catch (err) {
      const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
      console.error(`[email-sent] ${result.outreach_id}: ${reason}`);
      if (errors.length < 5) errors.push(reason);
    }
  }

  if (failed.length > 0) {
    await sendInternalAlert("system_error", {
      subject: `${failed.length} email(s) failed to send`,
      summary:
        "n8n reported these sends as failed. They have been returned to the queue for a later day, or parked after three attempts.",
      facts: { Failed: String(failed.length), Confirmed: String(applied.length) },
      link: "/b2b",
      linkLabel: "Open B2B board",
    });
  }

  /* PocketBase failures are a 502 so n8n retries; everything else is a 200 so
     it does not retry a callback that was simply already applied. */
  if (errors.length > 0 && applied.length === 0 && failed.length === 0) {
    return fail(errors[0], 502);
  }

  return ok({
    confirmed: applied.length,
    failed: failed.length,
    ignored: ignored.length,
    errors,
  });
}
