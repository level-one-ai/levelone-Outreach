"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Calendar, Check, Globe, Phone, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

import { formatUkPhone } from "@/lib/phone";
import type { TradeLead, TpsStatus } from "@/lib/types";

/**
 * One lead on the calling board.
 *
 * The email field and the date picker write straight to PocketBase as you
 * type — no edit mode, no save button. Both are debounced and optimistic: the
 * value you typed stays on screen while the request is in flight, so the card
 * never fights your cursor.
 */

const TPS_BADGE: Record<
  TpsStatus,
  { label: string; className: string; Icon: typeof ShieldCheck; title: string }
> = {
  clear: {
    label: "TPS clear",
    className: "border-positive/30 text-positive",
    Icon: ShieldCheck,
    title: "Screened against TPS/CTPS and not registered — safe to call.",
  },
  listed: {
    label: "TPS listed",
    className: "border-negative/30 text-negative",
    Icon: ShieldAlert,
    title: "Registered on TPS/CTPS. Calling without prior consent breaches PECR.",
  },
  unchecked: {
    label: "Unscreened",
    className: "border-pending/40 text-pending",
    Icon: ShieldQuestion,
    title:
      "No TPS provider is configured, so this number has NOT been screened. Set TPS_PROVIDER before cold calling.",
  },
  error: {
    label: "Check failed",
    className: "border-pending/40 text-pending",
    Icon: ShieldQuestion,
    title: "The TPS provider could not be reached. Treat as unscreened.",
  },
};

/** Debounce delay for inline edits — long enough to batch a typed address. */
const SAVE_DELAY_MS = 600;

export default function TradeLeadCard({
  lead,
  onLogCall,
  onSendMeeting,
  onPatch,
  sendingMeeting,
}: {
  lead: TradeLead;
  onLogCall: (lead: TradeLead) => void;
  onSendMeeting: (lead: TradeLead) => void;
  onPatch: (id: string, patch: { email?: string; call_date_time?: string }) => Promise<void>;
  sendingMeeting: boolean;
}) {
  const [email, setEmail] = useState(lead.email);
  const [when, setWhen] = useState(toInputValue(lead.call_date_time));
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A card can be re-rendered with fresh server data (after a tab switch, or
  // another edit landing). Adopt it — unless the field is mid-edit, which the
  // pending timer tells us.
  useEffect(() => {
    if (timer.current) return;
    setEmail(lead.email);
    setWhen(toInputValue(lead.call_date_time));
  }, [lead.email, lead.call_date_time]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function queueSave(patch: { email?: string; call_date_time?: string }) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      await onPatch(lead.id, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    }, SAVE_DELAY_MS);
  }

  const tps = TPS_BADGE[lead.tps_status] ?? TPS_BADGE.unchecked;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="card-tight flex flex-col gap-3"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-fluid-base font-semibold leading-tight text-foreground">
            {lead.company_name}
          </h3>
          {lead.location && (
            <p className="mt-0.5 truncate text-fluid-xs text-muted">{lead.location}</p>
          )}
        </div>

        <span
          title={tps.title}
          className={`badge shrink-0 ${tps.className}`}
        >
          <tps.Icon className="h-3 w-3" />
          {tps.label}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fluid-sm">
        <a
          href={`tel:${lead.phone}`}
          className="inline-flex items-center gap-1.5 font-medium text-foreground transition-opacity hover:opacity-70"
        >
          <Phone className="h-3.5 w-3.5 text-muted" />
          {formatUkPhone(lead.phone)}
        </a>

        {lead.website && (
          <a
            href={lead.website}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-fluid-xs text-muted transition-colors hover:text-foreground"
          >
            <Globe className="h-3.5 w-3.5" />
            Website
          </a>
        )}
      </div>

      {/* Google Places does not return email addresses, so this is where they
          get filled in — usually from the website link above. */}
      <label className="block">
        <span className="sr-only">Email address</span>
        <input
          type="email"
          value={email}
          placeholder="Add email address…"
          onChange={(e) => {
            setEmail(e.target.value);
            queueSave({ email: e.target.value });
          }}
          className="field-inline"
        />
      </label>

      <label className="flex items-center gap-2">
        <Calendar className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="sr-only">Call date and time</span>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => {
            setWhen(e.target.value);
            queueSave({
              call_date_time: e.target.value
                ? new Date(e.target.value).toISOString()
                : "",
            });
          }}
          className="field-inline"
        />
      </label>

      <footer className="flex items-center gap-2 pt-1">
        {lead.status === "positive" ? (
          lead.meeting_sent ? (
            <span className="badge border-positive/30 text-positive">
              <Check className="h-3 w-3" />
              Meeting email sent
            </span>
          ) : (
            <button
              onClick={() => onSendMeeting(lead)}
              disabled={sendingMeeting || !email}
              title={!email ? "Add an email address first." : undefined}
              className="btn-primary btn-sm"
            >
              {sendingMeeting ? "Sending…" : "Send Meeting Email"}
            </button>
          )
        ) : (
          <button onClick={() => onLogCall(lead)} className="btn-ghost btn-sm">
            Call Made
          </button>
        )}

        <span
          className={`ml-auto text-fluid-xs text-muted transition-opacity duration-300 ${
            saved ? "opacity-100" : "opacity-0"
          }`}
        >
          Saved
        </span>
      </footer>
    </motion.article>
  );
}

/** ISO → the `YYYY-MM-DDTHH:mm` shape datetime-local requires. */
function toInputValue(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
