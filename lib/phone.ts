/**
 * UK phone normalisation.
 *
 * Deduplication is only as good as the key it compares. Google Places returns
 * the same business number written four different ways — "0161 496 0000",
 * "+44 161 496 0000", "0161 496 0000 ext 2", "(0161) 4960000" — and a naive
 * string comparison treats all four as different leads.
 *
 * Everything is reduced to E.164 (+441614960000) before it is stored or
 * compared, so the UNIQUE index on `phone` actually does its job.
 */

/** Digits and a single leading +, nothing else. */
function stripFormatting(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits.replace(/^00/, "")}` : digits;
}

/**
 * Returns the number in E.164, or null when it cannot be a real UK number.
 *
 * Returning null rather than a best guess matters: an unparseable number
 * saved as-is would sit in the calling list looking valid, and would dodge
 * both the dedupe index and the TPS check.
 */
export function normalizeUkPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let s = stripFormatting(raw);
  if (!s) return null;

  // Already international.
  if (s.startsWith("+")) {
    if (!s.startsWith("+44")) {
      // A non-UK number. Keep it if it looks sane — TPS will not apply, but
      // it is still a lead — otherwise reject.
      return s.length >= 8 && s.length <= 16 ? s : null;
    }
    s = s.slice(3);
  } else if (s.startsWith("44") && s.length > 10) {
    s = s.slice(2);
  } else if (s.startsWith("0")) {
    s = s.slice(1);
  } else {
    // No country code and no trunk zero. Only plausible as a UK subscriber
    // number if it is already the right length.
    if (s.length !== 10 && s.length !== 9) return null;
  }

  // UK national significant numbers are 9 (a few 01x1 ranges) or 10 digits.
  if (s.length < 9 || s.length > 10) return null;

  return `+44${s}`;
}

/**
 * Human-readable form for the UI. Never used as a key — only ever displayed.
 */
export function formatUkPhone(e164: string): string {
  if (!e164.startsWith("+44")) return e164;
  const n = e164.slice(3);
  // Mobile: 7xxx xxxxxx
  if (n.startsWith("7") && n.length === 10) {
    return `0${n.slice(0, 4)} ${n.slice(4)}`;
  }
  // London / other 2-digit area codes
  if (n.startsWith("20") && n.length === 10) {
    return `0${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  }
  if (n.length === 10) return `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  if (n.length === 9) return `0${n.slice(0, 3)} ${n.slice(3)}`;
  return `0${n}`;
}

/** Mobile numbers are outside TPS's remit but inside CTPS's — worth knowing. */
export function isUkMobile(e164: string): boolean {
  return /^\+447\d{9}$/.test(e164);
}
