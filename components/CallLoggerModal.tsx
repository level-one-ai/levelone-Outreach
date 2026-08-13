"use client";

import { PhoneMissed, PhoneOff, ThumbsUp } from "lucide-react";

import Modal from "@/components/ui/Modal";
import type { TradeLead } from "@/lib/types";

/**
 * The "Call Made" popup: three outcomes, one click each.
 *
 * Logging the call is all this does. A positive outcome moves the lead to the
 * Positive tab and reveals a separate "Send Meeting Email" button there —
 * it does not email anyone from here. Two clicks for two decisions, so a
 * mis-click on Positive never puts a meeting invite in a client's inbox.
 */

const OUTCOMES = [
  {
    value: "negative" as const,
    label: "Negative",
    hint: "Not interested — moves to the Negative tab.",
    Icon: PhoneOff,
    accent: "hover:border-negative/40 hover:text-negative",
  },
  {
    value: "no_answer" as const,
    label: "No Answer",
    hint: "Nobody picked up — moves to No Answer to try again later.",
    Icon: PhoneMissed,
    accent: "hover:border-pending/50 hover:text-pending",
  },
  {
    value: "positive" as const,
    label: "Positive",
    hint: "Interested — moves to Positive, where you can send the meeting email.",
    Icon: ThumbsUp,
    accent: "hover:border-positive/40 hover:text-positive",
  },
];

export default function CallLoggerModal({
  lead,
  onClose,
  onLog,
  saving,
}: {
  lead: TradeLead | null;
  onClose: () => void;
  onLog: (outcome: "negative" | "no_answer" | "positive") => void;
  saving: boolean;
}) {
  return (
    <Modal
      open={lead !== null}
      onClose={onClose}
      title="How did the call go?"
      description={lead ? lead.company_name : undefined}
    >
      <div className="flex flex-col gap-2.5">
        {OUTCOMES.map(({ value, label, hint, Icon, accent }) => (
          <button
            key={value}
            onClick={() => onLog(value)}
            disabled={saving}
            className={`flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 text-left text-foreground transition-all active:scale-[0.99] disabled:opacity-50 ${accent}`}
          >
            <Icon className="mt-0.5 h-4.5 w-4.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-fluid-base font-medium">{label}</span>
              <span className="mt-0.5 block text-fluid-xs leading-snug text-muted">
                {hint}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
