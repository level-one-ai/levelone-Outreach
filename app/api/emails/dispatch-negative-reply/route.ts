import { fail, ok, parseBody } from "@/lib/api";
import { dispatchNegativeReply } from "@/lib/n8n";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { dispatchNegativeSchema } from "@/lib/schema";
import type { B2BCampaign, B2BContact, B2BOutreach } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Closes out a negative reply: polite apology, then archive.
 *
 * The greeting ("good morning/afternoon/evening") is chosen inside n8n at the
 * moment of sending, not here. If we picked it when you clicked the button, an
 * email that sat in a queue for two hours could open with the wrong one.
 *
 * No Resend alert fires for this. You are the one who clicked it — being
 * emailed about your own click is noise, and the whole point of the internal
 * alerts is that they only carry things you would otherwise miss.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, dispatchNegativeSchema);
  if (!parsed.success) return parsed.response;

  const { outreach_id, local_timezone } = parsed.data;
  const pb = createPublicClient();

  let run: B2BOutreach;
  try {
    run = await pb
      .collection(COLLECTIONS.b2bOutreach)
      .getOne<B2BOutreach>(outreach_id, { expand: "contact,campaign" });
  } catch (err) {
    return fail(
      `Outreach run not found. ${describePocketBaseError(err, COLLECTIONS.b2bOutreach)}`,
      404
    );
  }

  const contact = run.expand?.contact as B2BContact | undefined;
  const campaign = run.expand?.campaign as B2BCampaign | undefined;
  if (!contact || !campaign) {
    return fail(
      "This outreach run is missing its contact or campaign relation.",
      422
    );
  }

  const dispatch = await dispatchNegativeReply({
    outreachId: run.id,
    contact,
    campaign,
    localTimezone: local_timezone,
  });

  if (!dispatch.ok) {
    return fail(`The apology was not sent. ${dispatch.error}`, 502);
  }

  try {
    await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
      archived: true,
      ai_draft_reply: "",
    });
  } catch (err) {
    // The client has been emailed; only the archive flag is missing.
    console.error(
      "[dispatch-negative-reply] archive failed:",
      describePocketBaseError(err, COLLECTIONS.b2bOutreach)
    );
  }

  return ok({ outreach_id: run.id, archived: true });
}
