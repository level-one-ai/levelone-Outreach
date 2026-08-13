import { NextResponse } from "next/server";
import { z } from "zod";

import { describeZodError } from "@/lib/schema";

/**
 * Shared route plumbing: one response envelope, one validation path, one
 * webhook auth check. Every route in app/api uses these, so a client only
 * ever has to understand a single response shape.
 */

export function ok<T extends Record<string, unknown>>(data: T) {
  return NextResponse.json({ ok: true, ...data });
}

export function fail(error: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error, details }, { status });
}

/**
 * Parses and validates a JSON body.
 *
 * Returns a discriminated result rather than throwing, so routes handle bad
 * input on the same code path as everything else.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<
  { success: true; data: z.infer<T> } | { success: false; response: NextResponse }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { success: false, response: fail("Request body must be valid JSON.") };
  }

  /* n8n's HTTP Request node wraps output in a single-element array by
     default, and forgetting to unwrap it is the most common integration
     mistake. Accept both shapes rather than sending you hunting. */
  const candidate =
    Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;

  const result = schema.safeParse(candidate);
  if (!result.success) {
    return {
      success: false,
      response: fail(
        `Invalid payload — ${describeZodError(result.error)}`,
        400,
        result.error.flatten()
      ),
    };
  }
  return { success: true, data: result.data };
}

const WEBHOOK_SECRET = process.env.WEBHOOK_SHARED_SECRET ?? "";

/**
 * Guards the two public webhook receivers.
 *
 * Their URLs are known to n8n and to your calendar tool, and anything that
 * discovers them could otherwise write straight into your pipeline — marking
 * calls booked, injecting fake replies.
 *
 * An unset secret disables the check and logs a warning. That is a deliberate
 * convenience for local development and an explicitly bad idea in production,
 * which is why it is loud.
 */
export function checkWebhookAuth(request: Request): NextResponse | null {
  if (!WEBHOOK_SECRET) {
    console.warn(
      "[webhook] WEBHOOK_SHARED_SECRET is unset — this endpoint is UNPROTECTED."
    );
    return null;
  }

  const provided =
    request.headers.get("x-webhook-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  if (!timingSafeEqual(provided, WEBHOOK_SECRET)) {
    return fail("Unauthorized — missing or invalid x-webhook-secret header.", 401);
  }
  return null;
}

/** Constant-time comparison, so the secret cannot be recovered by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const APP_BASE_URL = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
