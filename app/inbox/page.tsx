"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, CalendarCheck, Inbox as InboxIcon, Send } from "lucide-react";

import HeaderBar from "@/components/HeaderBar";
import PageTransition from "@/components/PageTransition";
import { EmptyState, ErrorState, SkeletonGrid } from "@/components/ui/States";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import type {
  B2BCampaign,
  B2BContact,
  B2BOutreach,
  ReplySentiment,
} from "@/lib/types";

type LoadState = "loading" | "ready" | "error";

const TABS: Array<{ value: ReplySentiment; label: string }> = [
  { value: "positive", label: "Positive" },
  { value: "negative", label: "Negative" },
  { value: "no_reply", label: "No Reply" },
  { value: "pending", label: "Awaiting AI" },
];

const EMPTY_GROUPS: Record<ReplySentiment, B2BOutreach[]> = {
  positive: [],
  negative: [],
  no_reply: [],
  pending: [],
};

/**
 * One positive lead, with Gemini's draft in an editable composer.
 *
 * The draft is a starting point, not an outbox. Nothing leaves until you press
 * Send — and what gets sent is whatever is in the textarea at that moment,
 * edits included.
 */
function PositiveCard({
  run,
  onSent,
}: {
  run: B2BOutreach;
  onSent: (id: string) => void;
}) {
  const { toast } = useToast();
  const contact = run.expand?.contact as B2BContact | undefined;
  const campaign = run.expand?.campaign as B2BCampaign | undefined;

  const [subject, setSubject] = useState(
    `Re: ${campaign?.title ?? "your enquiry"}`
  );
  const [body, setBody] = useState(run.ai_draft_reply);
  const [sending, setSending] = useState(false);

  async function send() {
    if (!body.trim()) {
      toast("error", "The response is empty.");
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/emails/dispatch-client-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreach_id: run.id, subject, body }),
      });
      const result = await res.json();

      if (!result?.ok) {
        toast("error", result?.error ?? "The response was not sent.");
        return;
      }

      toast(
        "success",
        `Sent to ${contact?.email}. The 24-hour booking tracker has started.`
      );
      onSent(run.id);
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setSending(false);
    }
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="card flex flex-col gap-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-fluid-base font-semibold text-foreground">
            {contact?.contact_name || contact?.email}
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-fluid-xs text-muted">
            {contact?.company_name && (
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-3 w-3" />
                {contact.company_name}
              </span>
            )}
            <span>{contact?.email}</span>
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          {run.call_booked && (
            <span className="badge border-positive/30 text-positive">
              <CalendarCheck className="h-3 w-3" />
              Call booked
            </span>
          )}
          {campaign && <span className="badge">{campaign.title}</span>}
        </div>
      </header>

      <label>
        <span className="field-label">Subject</span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="field-input"
        />
      </label>

      <label>
        <span className="field-label">AI drafted response</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="Gemini has not written a draft for this reply yet."
          className="field-input leading-relaxed"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-fluid-xs text-muted">
          Sends via n8n from {campaign?.from_email ?? "the campaign address"},
          then starts the 24-hour discovery-call tracker.
        </p>
        <button onClick={send} disabled={sending} className="btn-primary btn-sm">
          <Send className="h-4 w-4" />
          {sending ? "Sending…" : "Send Response"}
        </button>
      </div>
    </motion.article>
  );
}

/** Negative and no-reply leads: one action, or none. */
function SimpleCard({
  run,
  onArchived,
  archivable,
}: {
  run: B2BOutreach;
  onArchived: (id: string) => void;
  archivable: boolean;
}) {
  const { toast } = useToast();
  const contact = run.expand?.contact as B2BContact | undefined;
  const campaign = run.expand?.campaign as B2BCampaign | undefined;
  const [busy, setBusy] = useState(false);

  async function apologiseAndArchive() {
    setBusy(true);
    try {
      const res = await fetch("/api/emails/dispatch-negative-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outreach_id: run.id,
          // The browser knows the operator's zone; n8n picks the greeting
          // from it at send time.
          local_timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London",
        }),
      });
      const body = await res.json();

      if (!body?.ok) {
        toast("error", body?.error ?? "The apology was not sent.");
        return;
      }
      toast("success", `Apology sent to ${contact?.email}. Lead archived.`);
      onArchived(run.id);
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="card-tight flex flex-wrap items-center justify-between gap-3"
    >
      <div className="min-w-0">
        <h3 className="truncate text-fluid-sm font-semibold text-foreground">
          {contact?.contact_name || contact?.email}
        </h3>
        <p className="mt-0.5 truncate text-fluid-xs text-muted">
          {[contact?.company_name, campaign?.title].filter(Boolean).join(" · ")}
        </p>
      </div>

      {archivable && (
        <button
          onClick={apologiseAndArchive}
          disabled={busy}
          className="btn-ghost btn-sm"
        >
          {busy ? "Sending…" : "Send apology & archive"}
        </button>
      )}
    </motion.article>
  );
}

function InboxConsole() {
  const [tab, setTab] = useState<ReplySentiment>("positive");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [groups, setGroups] = useState(EMPTY_GROUPS);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox");
      const body = await res.json();
      if (!body?.ok) {
        setError(body?.error ?? "Could not load the inbox.");
        setState("error");
        return;
      }
      setGroups({ ...EMPTY_GROUPS, ...body.groups });
      setState("ready");
    } catch {
      setError("Could not reach the server.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** A handled lead leaves the inbox immediately — no refetch, no flicker. */
  const remove = useCallback((id: string) => {
    setGroups((g) => {
      const next = { ...g };
      for (const key of Object.keys(next) as ReplySentiment[]) {
        next[key] = next[key].filter((r) => r.id !== id);
      }
      return next;
    });
  }, []);

  const runs = groups[tab] ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <PageTransition chrome={<HeaderBar />}>
        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 pb-10 sm:px-8">
          <div className="mb-5">
            <h1 className="text-fluid-xl font-semibold tracking-tight text-foreground">
              AI Inbox
            </h1>
            <p className="mt-0.5 text-fluid-xs text-muted">
              Replies classified by Gemini. Positive leads arrive with a drafted
              response for you to review.
            </p>
          </div>

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
                    <motion.span
                      layoutId="inbox-tab"
                      className="absolute inset-0 rounded-full bg-canvas-deep"
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    />
                  )}
                  <span className="relative">
                    {label}
                    <span className="ml-2 tabular-nums opacity-60">
                      {groups[value]?.length ?? 0}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {state === "loading" && <SkeletonGrid count={3} />}
          {state === "error" && <ErrorState message={error} onRetry={load} />}

          {state === "ready" && runs.length === 0 && (
            <EmptyState
              icon={InboxIcon}
              title="Nothing here"
              hint={
                tab === "positive"
                  ? "Positive replies land here with a Gemini draft, ready to review and send."
                  : "Replies are sorted into these tabs as Gemini classifies them."
              }
            />
          )}

          {state === "ready" && runs.length > 0 && (
            <div className="flex flex-col gap-4">
              <AnimatePresence mode="popLayout">
                {runs.map((run) =>
                  tab === "positive" ? (
                    <PositiveCard key={run.id} run={run} onSent={remove} />
                  ) : (
                    <SimpleCard
                      key={run.id}
                      run={run}
                      onArchived={remove}
                      archivable={tab === "negative"}
                    />
                  )
                )}
              </AnimatePresence>
            </div>
          )}
        </main>
      </PageTransition>
    </div>
  );
}

export default function InboxPage() {
  return (
    <ToastProvider>
      <InboxConsole />
    </ToastProvider>
  );
}
