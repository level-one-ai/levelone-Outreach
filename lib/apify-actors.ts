/**
 * Apify actor profiles — how the scrape form knows what to ask you for.
 *
 * Every LinkedIn/Sales Navigator actor on Apify takes a different input shape.
 * Rather than hardcoding one actor's fields into the UI (which would mean a
 * code change every time you switch actors), a profile declares:
 *
 *   - which actor to run
 *   - which questions the form should ask
 *   - how to turn those answers into that actor's input JSON
 *
 * The form renders itself from `fields`; the server calls `buildInput`. Adding
 * a new actor is one entry in ACTOR_PROFILES and no UI change at all.
 *
 * ---------------------------------------------------------------------------
 * TO CONNECT YOUR OWN ACTOR
 * ---------------------------------------------------------------------------
 * 1. Set APIFY_TOKEN (Apify Console → Settings → API & Integrations).
 * 2. Set APIFY_LINKEDIN_ACTOR_ID to `username~actor-name` (or `username/actor`
 *    — startRun accepts both). It is the last part of the actor's URL.
 * 3. Configure one run in the Apify console, switch its Input tab to JSON, and
 *    copy that JSON. Model a profile's `buildInput` on it.
 * 4. Check a sample output record (run → Storage → Dataset → Export JSON). If
 *    its email field is spelled something `normalizeItem` in lib/apify.ts does
 *    not already look for, add that spelling there. If the actor returns NO
 *    email at all, these leads are not mailable without an enrichment step —
 *    see the note on `normalizeItem`.
 */

export type FieldType = "text" | "number" | "textarea";

export interface ActorField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Prefilled in the form. */
  defaultValue?: string | number;
}

export interface ActorProfile {
  id: string;
  label: string;
  description: string;
  /** Blank means "use APIFY_LINKEDIN_ACTOR_ID". */
  actorId: string;
  fields: ActorField[];
  buildInput(values: Record<string, string | number>): Record<string, unknown>;
}

/** Reads a value as a positive integer, falling back when absent or junk. */
function int(value: string | number | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Splits a comma-separated form field into a clean array. */
function list(value: string | number | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const MAX_RESULTS_FIELD: ActorField = {
  key: "maxResults",
  label: "Max results",
  type: "number",
  defaultValue: 100,
  hint: "Apify bills per result. Start small while you are checking the output shape.",
};

export const ACTOR_PROFILES: ActorProfile[] = [
  /* ------------------------------------------------------------------ */
  /*  1. Sales Navigator — driven by a search URL                        */
  /* ------------------------------------------------------------------ */
  {
    id: "sales_navigator_url",
    label: "LinkedIn Sales Navigator (search URL)",
    description:
      "Build the search in Sales Navigator, then paste its URL. Most Sales Nav actors also need a LinkedIn session cookie set as APIFY_LINKEDIN_COOKIE.",
    actorId: "",
    fields: [
      {
        key: "searchUrl",
        label: "Sales Navigator search URL",
        type: "text",
        placeholder: "https://www.linkedin.com/sales/search/people?query=…",
        required: true,
      },
      MAX_RESULTS_FIELD,
    ],
    buildInput: (v) => ({
      searchUrl: String(v.searchUrl ?? ""),
      maxResults: int(v.maxResults, 100),
      ...cookieInput(),
    }),
  },

  /* ------------------------------------------------------------------ */
  /*  2. LinkedIn people search — driven by keywords                     */
  /* ------------------------------------------------------------------ */
  {
    id: "linkedin_people_search",
    label: "LinkedIn people search (keywords)",
    description:
      "Search by job title, company and location without building a Sales Navigator URL first.",
    actorId: "",
    fields: [
      {
        key: "jobTitles",
        label: "Job titles",
        type: "text",
        placeholder: "Founder, Managing Director, Head of Marketing",
        hint: "Comma-separated.",
        required: true,
      },
      {
        key: "locations",
        label: "Locations",
        type: "text",
        placeholder: "Manchester, United Kingdom",
        hint: "Comma-separated.",
      },
      {
        key: "industries",
        label: "Industries",
        type: "text",
        placeholder: "Software Development, Marketing Services",
        hint: "Comma-separated.",
      },
      MAX_RESULTS_FIELD,
    ],
    buildInput: (v) => ({
      jobTitles: list(v.jobTitles),
      locations: list(v.locations),
      industries: list(v.industries),
      maxResults: int(v.maxResults, 100),
      ...cookieInput(),
    }),
  },

  /* ------------------------------------------------------------------ */
  /*  3. Escape hatch — raw JSON                                         */
  /* ------------------------------------------------------------------ */
  {
    id: "custom",
    label: "Custom actor (raw JSON input)",
    description:
      "Paste an actor id and the exact input JSON from its Apify docs. Use this to try an actor before giving it a proper profile above.",
    actorId: "",
    fields: [
      {
        key: "actorId",
        label: "Actor id",
        type: "text",
        placeholder: "username~actor-name",
        hint: "Leave blank to use APIFY_LINKEDIN_ACTOR_ID.",
      },
      {
        key: "inputJson",
        label: "Input JSON",
        type: "textarea",
        placeholder: '{ "searchUrl": "…", "maxResults": 100 }',
        required: true,
      },
    ],
    buildInput: (v) => {
      try {
        const parsed = JSON.parse(String(v.inputJson ?? "{}"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Input JSON must be a JSON object.");
        }
        return parsed as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Input JSON is not valid JSON: ${err instanceof Error ? err.message : "parse failed"}`
        );
      }
    },
  },
];

/**
 * Most Sales Navigator actors authenticate with your own `li_at` session
 * cookie. It is a credential, so it lives in the environment and is merged in
 * server-side — it must never be typed into the scrape form or sent from the
 * browser. Actors that do not want it ignore the extra key.
 */
function cookieInput(): Record<string, unknown> {
  const cookie = process.env.APIFY_LINKEDIN_COOKIE ?? "";
  if (!cookie) return {};
  return { cookie: [{ name: "li_at", value: cookie, domain: ".linkedin.com" }] };
}

export function findProfile(id: string): ActorProfile | undefined {
  return ACTOR_PROFILES.find((p) => p.id === id);
}

/** The form's own metadata — everything except the non-serialisable builder. */
export function listProfilesForClient() {
  return ACTOR_PROFILES.map(({ id, label, description, fields }) => ({
    id,
    label,
    description,
    fields,
  }));
}

/** Which actor a profile run should target, after all the fallbacks. */
export function resolveActorId(
  profile: ActorProfile,
  values: Record<string, string | number>
): string {
  return (
    String(values.actorId ?? "").trim() ||
    profile.actorId ||
    process.env.APIFY_LINKEDIN_ACTOR_ID ||
    ""
  );
}
