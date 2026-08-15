"use client";

import { useCallback, useEffect, useState } from "react";
import { LayoutGrid, Plus } from "lucide-react";

import HeaderBar from "@/components/HeaderBar";
import ImportPanel from "@/components/ImportPanel";
import KanbanBoard from "@/components/KanbanBoard";
import PageTransition from "@/components/PageTransition";
import SendControls from "@/components/SendControls";
import Modal from "@/components/ui/Modal";
import { EmptyState, ErrorState, SkeletonGrid } from "@/components/ui/States";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import type { B2BCampaign, B2BOutreach, KanbanStage } from "@/lib/types";

type LoadState = "loading" | "ready" | "error";

const EMPTY_BOARD = {
  queued: [],
  sending: [],
  sent_1: [],
  followup_2d: [],
  followup_5d: [],
  replied: [],
  send_failed: [],
} as Record<KanbanStage, B2BOutreach[]>;

function CampaignDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: B2BCampaign) => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [offer, setOffer] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [limit, setLimit] = useState("10");
  const [sendTime, setSendTime] = useState("09:00");
  const [zone, setZone] = useState("Europe/London");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      toast("error", "Daily limit must be at least 1.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/b2b/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          offer_description: offer,
          from_email: fromEmail,
          active: true,
          daily_send_limit: Math.floor(parsedLimit),
          send_time: sendTime,
          send_timezone: zone,
          /* Deliberately off. A new campaign has nothing in it yet, and a
             campaign that starts sending the moment it is created is how you
             email a list you have not finished checking. */
          sending_active: false,
        }),
      });
      const body = await res.json();
      if (!body?.ok) {
        toast("error", body?.error ?? "Could not create the campaign.");
        return;
      }
      onCreated(body.campaign);
      setTitle("");
      setOffer("");
      setFromEmail("");
      onClose();
      toast("success", `Campaign "${body.campaign.title}" created.`);
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      description="A campaign is one offer sent from one address. Contacts are stored separately, so the same lead can be re-targeted later without being duplicated."
      width="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <label>
          <span className="field-label">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Q3 Automation Pitch"
            className="field-input"
          />
        </label>

        <label>
          <span className="field-label">Offer description</span>
          <textarea
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
            rows={4}
            placeholder="What this campaign is pitching. n8n passes this to the email template."
            className="field-input"
          />
        </label>

        <label>
          <span className="field-label">Send from</span>
          <input
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="dean@levelone.digital"
            className="field-input"
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label>
            <span className="field-label">Per day</span>
            <input
              type="number"
              min={1}
              max={200}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="field-input"
            />
          </label>

          <label>
            <span className="field-label">Send at</span>
            <input
              type="time"
              value={sendTime}
              onChange={(e) => setSendTime(e.target.value)}
              className="field-input"
            />
          </label>

          <label>
            <span className="field-label">Timezone</span>
            <input
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              className="field-input"
            />
          </label>
        </div>

        <p className="text-fluid-xs leading-relaxed text-muted">
          Leads added to this campaign wait in a queue. This many first emails
          leave each day at the time above, and no lead is ever sent the first
          email twice. Sending stays paused until you press Start.
        </p>

        <button
          onClick={submit}
          disabled={busy || !title.trim() || !fromEmail.trim()}
          className="btn-primary w-full"
        >
          {busy ? "Creating…" : "Create campaign"}
        </button>
      </div>
    </Modal>
  );
}

function B2BWorkspace() {
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [campaigns, setCampaigns] = useState<B2BCampaign[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [board, setBoard] = useState(EMPTY_BOARD);
  const [repliedCount, setRepliedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [creating, setCreating] = useState(false);

  // Campaigns first — the board is meaningless without one selected.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/b2b/campaigns");
        const body = await res.json();
        if (!body?.ok) {
          setError(body?.error ?? "Could not load campaigns.");
          setState("error");
          return;
        }
        setCampaigns(body.campaigns);
        setActiveId(body.campaigns[0]?.id ?? "");
        setState("ready");
      } catch {
        setError("Could not reach the server.");
        setState("error");
      }
    })();
  }, []);

  const loadBoard = useCallback(
    async (campaignId: string) => {
      if (!campaignId) return;
      try {
        const res = await fetch(`/api/b2b/outreach?campaign_id=${campaignId}`);
        const body = await res.json();
        if (!body?.ok) {
          toast("error", body?.error ?? "Could not load the board.");
          return;
        }
        setBoard({ ...EMPTY_BOARD, ...body.board });
        setRepliedCount(body.replied?.length ?? 0);
        setFailedCount(body.failed?.length ?? 0);
      } catch {
        toast("error", "Could not reach the server.");
      }
    },
    [toast]
  );

  useEffect(() => {
    void loadBoard(activeId);
  }, [activeId, loadBoard]);

  const active = campaigns.find((c) => c.id === activeId);

  return (
    <div className="flex min-h-screen flex-col">
      <PageTransition chrome={<HeaderBar />}>
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-10 sm:px-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-fluid-xl font-semibold tracking-tight text-foreground">
                B2B Campaigns
              </h1>
              <p className="mt-0.5 text-fluid-xs text-muted">
                {repliedCount > 0
                  ? `${repliedCount} lead${repliedCount === 1 ? " has" : "s have"} replied and moved to the AI Inbox.`
                  : "Leads wait in Queued until their turn in the daily batch. A reply stops the sequence."}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {active && (
                <ImportPanel
                  campaignId={active.id}
                  campaignTitle={active.title}
                  onImported={() => void loadBoard(active.id)}
                />
              )}
              <button
                onClick={() => setCreating(true)}
                className="btn-primary btn-sm"
              >
                <Plus className="h-4 w-4" />
                Campaign
              </button>
            </div>
          </div>

          {state === "loading" && <SkeletonGrid count={3} />}

          {state === "error" && (
            <ErrorState message={error} onRetry={() => location.reload()} />
          )}

          {state === "ready" && campaigns.length === 0 && (
            <EmptyState
              icon={LayoutGrid}
              title="No campaigns yet"
              hint="A campaign holds the offer and the sending address. Create one, then import contacts into it."
              action={
                <button onClick={() => setCreating(true)} className="btn-primary btn-sm">
                  Create your first campaign
                </button>
              }
            />
          )}

          {state === "ready" && campaigns.length > 0 && (
            <>
              {/* Campaign switcher — the lead-reuse model made visible: the
                  same contact can appear on more than one of these boards. */}
              <div className="custom-scrollbar mb-5 flex gap-2 overflow-x-auto pb-1">
                {campaigns.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setActiveId(c.id)}
                    className={`shrink-0 rounded-full border px-4 py-2 text-fluid-xs font-medium tracking-wide transition-colors ${
                      c.id === activeId
                        ? "border-foreground/25 bg-canvas-deep text-foreground"
                        : "border-line text-muted hover:text-foreground"
                    }`}
                  >
                    {c.title}
                  </button>
                ))}
              </div>

              {active && (
                <>
                  <p className="mb-3 text-fluid-xs text-muted">
                    Sending from{" "}
                    <span className="font-medium text-foreground">
                      {active.from_email}
                    </span>
                  </p>

                  <SendControls
                    campaign={active}
                    onChanged={(updated) => {
                      setCampaigns((prev) =>
                        prev.map((c) => (c.id === updated.id ? updated : c))
                      );
                      void loadBoard(updated.id);
                    }}
                  />
                </>
              )}

              {failedCount > 0 && (
                <p className="mb-4 rounded-2xl border border-negative/30 px-4 py-3 text-fluid-xs text-negative">
                  {failedCount} lead{failedCount === 1 ? "" : "s"} could not be
                  emailed after three attempts. They are out of the queue —
                  check the sending address and n8n&apos;s logs.
                </p>
              )}

              <KanbanBoard board={board} />
            </>
          )}
        </main>
      </PageTransition>

      <CampaignDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCampaigns((prev) => [c, ...prev]);
          setActiveId(c.id);
        }}
      />
    </div>
  );
}

export default function B2BPage() {
  return (
    <ToastProvider>
      <B2BWorkspace />
    </ToastProvider>
  );
}
