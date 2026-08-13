"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PhoneCall } from "lucide-react";

import CallLoggerModal from "@/components/CallLoggerModal";
import HeaderBar from "@/components/HeaderBar";
import PageTransition from "@/components/PageTransition";
import ScrapePanel from "@/components/ScrapePanel";
import TradeLeadCard from "@/components/TradeLeadCard";
import { EmptyState, ErrorState, SkeletonGrid } from "@/components/ui/States";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import type { TradeLead, TradeStatus } from "@/lib/types";

const TABS: Array<{ value: TradeStatus; label: string }> = [
  { value: "scraped", label: "New" },
  { value: "no_answer", label: "No Answer" },
  { value: "positive", label: "Positive" },
  { value: "negative", label: "Negative" },
];

type LoadState = "loading" | "ready" | "error";

function TradesBoard() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TradeStatus>("scraped");
  const [state, setState] = useState<LoadState>("loading");
  const [leads, setLeads] = useState<TradeLead[]>([]);
  const [counts, setCounts] = useState<Record<TradeStatus, number>>({
    scraped: 0,
    no_answer: 0,
    positive: 0,
    negative: 0,
  });
  const [error, setError] = useState("");
  const [logging, setLogging] = useState<TradeLead | null>(null);
  const [savingCall, setSavingCall] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const load = useCallback(
    async (status: TradeStatus, showSkeleton = true) => {
      if (showSkeleton) setState("loading");
      try {
        const res = await fetch(`/api/trades/leads?status=${status}`);
        const body = await res.json();
        if (!body?.ok) {
          setError(body?.error ?? "Could not load leads.");
          setState("error");
          return;
        }
        setLeads(body.leads);
        setCounts(body.counts);
        setState("ready");
      } catch {
        setError("Could not reach the server.");
        setState("error");
      }
    },
    []
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  /** Inline card edits. Optimistic — the card keeps what you typed. */
  const patchLead = useCallback(
    async (id: string, patch: { email?: string; call_date_time?: string }) => {
      setLeads((prev) =>
        prev.map((l) => (l.id === id ? { ...l, ...patch } : l))
      );
      try {
        const res = await fetch("/api/trades/leads", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ...patch }),
        });
        const body = await res.json();
        if (!body?.ok) toast("error", body?.error ?? "Could not save that change.");
      } catch {
        toast("error", "Could not save that change — the server is unreachable.");
      }
    },
    [toast]
  );

  async function logCall(outcome: "negative" | "no_answer" | "positive") {
    if (!logging) return;
    setSavingCall(true);
    try {
      const res = await fetch("/api/trades/log-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: logging.id, outcome }),
      });
      const body = await res.json();
      if (!body?.ok) {
        toast("error", body?.error ?? "Could not log the call.");
        return;
      }

      // The lead has left this tab, so drop it here and correct the badges.
      setLeads((prev) => prev.filter((l) => l.id !== logging.id));
      setCounts((c) => ({ ...c, [tab]: c[tab] - 1, [outcome]: c[outcome] + 1 }));
      setLogging(null);
      toast("success", `Call logged as ${outcome.replace("_", " ")}.`);
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setSavingCall(false);
    }
  }

  async function sendMeeting(lead: TradeLead) {
    setSendingId(lead.id);
    try {
      const res = await fetch("/api/trades/send-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const body = await res.json();

      if (!body?.ok) {
        toast("error", body?.error ?? "The meeting email was not sent.");
        return;
      }

      setLeads((prev) =>
        prev.map((l) => (l.id === lead.id ? { ...l, meeting_sent: true } : l))
      );
      toast(
        "success",
        body.alert_sent
          ? `Meeting email sent to ${lead.company_name}, and you have been alerted.`
          : `Meeting email sent to ${lead.company_name}. (Internal alert not sent: ${body.alert_reason})`
      );
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setSendingId(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PageTransition chrome={<HeaderBar />}>
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-10 sm:px-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-fluid-xl font-semibold tracking-tight text-foreground">
                Trades Calling
              </h1>
              <p className="mt-0.5 text-fluid-xs text-muted">
                Grid-scraped local trades, deduplicated by phone number and
                screened for TPS.
              </p>
            </div>
            <ScrapePanel onComplete={() => void load(tab, false)} />
          </div>

          {/* Tabs */}
          <div className="custom-scrollbar mb-5 flex gap-2 overflow-x-auto pb-1">
            {TABS.map(({ value, label }) => {
              const active = tab === value;
              return (
                <button
                  key={value}
                  onClick={() => setTab(value)}
                  className={`relative shrink-0 rounded-full border px-4 py-2 text-fluid-xs font-medium tracking-wide transition-colors ${
                    active
                      ? "border-foreground/25 text-foreground"
                      : "border-line text-muted hover:text-foreground"
                  }`}
                >
                  {active && (
                    // Shared layoutId slides the indicator between tabs
                    // instead of cross-fading two separate pills.
                    <motion.span
                      layoutId="trades-tab"
                      className="absolute inset-0 rounded-full bg-canvas-deep"
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    />
                  )}
                  <span className="relative">
                    {label}
                    <span className="ml-2 tabular-nums opacity-60">
                      {counts[value] ?? 0}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {state === "loading" && <SkeletonGrid count={8} />}

          {state === "error" && (
            <ErrorState message={error} onRetry={() => void load(tab)} />
          )}

          {state === "ready" && leads.length === 0 && (
            <EmptyState
              icon={PhoneCall}
              title="Nothing in this tab yet"
              hint={
                tab === "scraped"
                  ? "Run a grid scrape to pull local trades from Google Maps."
                  : "Leads land here as you log calls."
              }
            />
          )}

          {state === "ready" && leads.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <AnimatePresence mode="popLayout">
                {leads.map((lead) => (
                  <TradeLeadCard
                    key={lead.id}
                    lead={lead}
                    onLogCall={setLogging}
                    onSendMeeting={sendMeeting}
                    onPatch={patchLead}
                    sendingMeeting={sendingId === lead.id}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </main>
      </PageTransition>

      <CallLoggerModal
        lead={logging}
        onClose={() => setLogging(null)}
        onLog={logCall}
        saving={savingCall}
      />
    </div>
  );
}

export default function TradesPage() {
  return (
    <ToastProvider>
      <Suspense fallback={null}>
        <TradesBoard />
      </Suspense>
    </ToastProvider>
  );
}
