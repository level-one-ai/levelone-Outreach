"use client";

import { motion } from "framer-motion";
import { Building2, CalendarCheck, ShieldCheck } from "lucide-react";

import { BOARD_STAGES, STAGE_LABELS } from "@/lib/types";
import type { B2BContact, B2BOutreach, KanbanStage } from "@/lib/types";

/**
 * The sequence tracker.
 *
 * Columns are timeline positions, not statuses you drag between. Leads start
 * in Queued — enrolled but not emailed — and only move to First Email Sent
 * when n8n confirms the mail actually left. After that n8n moves a card along
 * as each follow-up goes out. A card that disappears from the board has
 * replied: that is the auto-pause made visible, and it is now in the AI Inbox.
 */

function KanbanCard({ run }: { run: B2BOutreach }) {
  const contact = run.expand?.contact as B2BContact | undefined;

  return (
    <motion.article
      layout
      layoutId={run.id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="card-tight"
    >
      <h4 className="truncate text-fluid-sm font-semibold leading-tight text-foreground">
        {contact?.contact_name || contact?.email || "Unknown contact"}
      </h4>

      {contact?.company_name && (
        <p className="mt-1 flex items-center gap-1.5 truncate text-fluid-xs text-muted">
          <Building2 className="h-3 w-3 shrink-0" />
          {contact.company_name}
        </p>
      )}

      <p className="mt-1 truncate text-fluid-xs text-muted">{contact?.email}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {contact?.email_verified ? (
          <span
            className="badge border-positive/30 text-positive"
            title={`Deliverability score ${contact.verification_score}/100`}
          >
            <ShieldCheck className="h-3 w-3" />
            Verified
          </span>
        ) : (
          <span
            className="badge border-pending/40 text-pending"
            title="This address was not checked by a verifier."
          >
            Unverified
          </span>
        )}

        {run.call_booked && (
          <span className="badge border-positive/30 text-positive">
            <CalendarCheck className="h-3 w-3" />
            Call booked
          </span>
        )}
      </div>

      {run.kanban_stage === "sending" ? (
        <p className="mt-2 text-[0.68rem] uppercase tracking-wider text-pending">
          Sending — waiting on n8n
        </p>
      ) : run.last_email_sent_at ? (
        <p className="mt-2 text-[0.68rem] uppercase tracking-wider text-muted">
          Last sent {formatDate(run.last_email_sent_at)}
        </p>
      ) : null}
    </motion.article>
  );
}

export default function KanbanBoard({
  board,
}: {
  board: Record<KanbanStage, B2BOutreach[]>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {BOARD_STAGES.map((stage, i) => {
        const runs = board[stage] ?? [];
        return (
          <motion.section
            key={stage}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.4,
              delay: i * 0.06,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="flex min-h-0 flex-col rounded-3xl border border-line bg-canvas-deep/40 p-3"
          >
            <header className="mb-3 flex items-baseline justify-between gap-2 px-1">
              <h3 className="text-fluid-xs font-semibold uppercase tracking-widest text-foreground">
                {STAGE_LABELS[stage]}
              </h3>
              <span className="text-fluid-xs tabular-nums text-muted">
                {runs.length}
              </span>
            </header>

            <div className="custom-scrollbar flex max-h-[calc(100dvh-20rem)] flex-col gap-2.5 overflow-y-auto pr-1">
              {runs.length === 0 ? (
                <p className="px-1 py-6 text-center text-fluid-xs text-muted">
                  Nothing here yet.
                </p>
              ) : (
                runs.map((run) => <KanbanCard key={run.id} run={run} />)
              )}
            </div>
          </motion.section>
        );
      })}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
