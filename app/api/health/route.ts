import { isApifyConfigured } from "@/lib/apify";
import { ok } from "@/lib/api";
import { webhookConfigStatus } from "@/lib/n8n";
import { isPlacesConfigured } from "@/lib/places";
import {
  COLLECTIONS,
  POCKETBASE_URL,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { isTpsConfigured } from "@/lib/tps";
import { isVerifierConfigured } from "@/lib/verify-email";

export const dynamic = "force-dynamic";

/**
 * Configuration and connectivity check.
 *
 * Worth hitting first after any deploy: it tells you which of the seven
 * collections exist and which integrations are actually wired up, rather than
 * leaving you to discover a missing collection when an import silently
 * returns zero.
 *
 * Reports presence, never values — no key material appears in the response.
 */
export async function GET() {
  const pb = createPublicClient();

  const collections: Record<string, string> = {};
  for (const name of Object.values(COLLECTIONS)) {
    try {
      await pb.collection(name).getList(1, 1);
      collections[name] = "ok";
    } catch (err) {
      collections[name] = describePocketBaseError(err, name);
    }
  }

  const allOk = Object.values(collections).every((v) => v === "ok");

  return ok({
    pocketbase: { url: POCKETBASE_URL, healthy: allOk, collections },
    integrations: {
      google_places: isPlacesConfigured(),
      apify: isApifyConfigured(),
      email_verifier: isVerifierConfigured(),
      tps_screening: isTpsConfigured(),
      resend: Boolean(process.env.RESEND_API_KEY && process.env.INTERNAL_ALERT_EMAIL),
      webhook_secret: Boolean(process.env.WEBHOOK_SHARED_SECRET),
    },
    n8n_webhooks: webhookConfigStatus(),
  });
}
