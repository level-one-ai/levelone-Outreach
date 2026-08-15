"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, Users } from "lucide-react";

import B2BScrapePanel from "@/components/B2BScrapePanel";
import HeaderBar from "@/components/HeaderBar";
import PageTransition from "@/components/PageTransition";
import Modal from "@/components/ui/Modal";
import { EmptyState, ErrorState, SkeletonGrid } from "@/components/ui/States";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import type { B2BCampaign, B2BContact } from "@/lib/types";

/**
 * The B2B lead pool — scraped people who belong to no campaign yet.
 *
 * This page exists separately from /b2b on purpose. Scraping and campaigning
 * are different jobs: fill the pool whenever a niche looks promising, then
 * decide later who goes in front of which offer. Nothing on this page sends an
 * email, and adding leads to a campaign only puts them in that campaign's
 * queue.
 */

type LoadState = "loading" | "ready" | "error";

function AddToCampaignDialog({
  open,
  onClose,
  selected,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<B2BCampaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await fetch("/api/b2b/campaigns");
        const body = await res.json();
        if (!body?.ok) return;
        setCampaigns(body.campaigns);
        setCampaignId((prev) => prev || body.campaigns[0]?.id || "");
      } catch {
        toast("error", "Could not load campaigns.");
      }
    })();
  }, [open, toast]);

  const campaign = campaigns.find((c) => c.id === campaignId);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/b2b/enrol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: campaignId, contact_ids: selected }),
      });
      const body = await res.json();
      if (!body?.ok) {
        toast("error", body?.error ?? "Could not add these leads.");
        return;
      }

      const { enrolled, alreadyInCampaign } = body.summary;
      toast(
        "success",
        `${enrolled} lead${enrolled === 1 ? "" : "s"} queued in "${body.campaign.title}".` +
          (alreadyInCampaign > 0
            ? ` ${alreadyInCampaign} were already in it.`
            : "")
      );
      onAdded();
      onClose();
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const perDay = campaign?.daily_send_limit || 10;
  const days = Math.ceil(selected.length / perDay);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add ${selected.length} lead${selected.length === 1 ? "" : "s"} to a campaign`}
      description="They join the campaign's queue. Nothing is emailed until the campaign's next daily batch."
      width="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        {campaigns.length === 0 ? (
          <p className="text-fluid-sm text-muted">
            No campaigns yet — create one on the B2B page first.
          </p>
        ) : (
          <>
            <label>
              <span className="field-label">Campaign</span>
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="field-input"
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>

            {/* The pace, stated before you commit — the number that decides
                how long this list takes to work through. */}
            {campaign && (
              <p className="rounded-2xl border border-line px-3 py-2 text-fluid-xs leading-relaxed text-muted">
                Sends <span className="font-medium text-foreground">{perDay}/day</span> at{" "}
                <span className="font-medium text-foreground">
                  {campaign.send_time || "09:00"}
                </span>{" "}
                ({campaign.send_timezone || "Europe/London"}) — about{" "}
                <span className="font-medium text-foreground">
                  {days} day{days === 1 ? "" : "s"}
                </span>{" "}
                to work through {selected.length}.
                {!campaign.sending_active &&
                  " Sending is currently paused, so they will wait until you press Start."}
              </p>
            )}

            <button
              onClick={submit}
              disabled={busy || !campaignId}
              className="btn-primary w-full"
            >
              {busy ? "Adding…" : `Queue ${selected.length} lead${selected.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function LeadPool() {
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [leads, setLeads] = useState<B2BContact[]>([]);
  const [niches, setNiches] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);

  const [niche, setNiche] = useState("");
  const [poolStatus, setPoolStatus] = useState("");
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (niche) params.set("niche", niche);
      if (poolStatus) params.set("pool_status", poolStatus);
      if (search.trim()) params.set("q", search.trim());

      const res = await fetch(`/api/b2b/leads?${params}`);
      const body = await res.json();
      if (!body?.ok) {
        setError(body?.error ?? "Could not load the lead pool.");
        setState("error");
        return;
      }
      setLeads(body.leads);
      setNiches(body.niches);
      setTotal(body.total);
      setTotalPages(body.total_pages);
      setState("ready");
    } catch {
      setError("Could not reach the server.");
      setState("error");
    }
  }, [page, niche, poolStatus, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // Filters change what "all" means, so a stale selection would be misleading.
  useEffect(() => {
    setSelected(new Set());
  }, [niche, poolStatus, search, page]);

  const allOnPageSelected = useMemo(
    () => leads.length > 0 && leads.every((l) => selected.has(l.id)),
    [leads, selected]
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allOnPageSelected) {
        const next = new Set(prev);
        leads.forEach((l) => next.delete(l.id));
        return next;
      }
      return new Set([...prev, ...leads.map((l) => l.id)]);
    });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PageTransition chrome={<HeaderBar />}>
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-10 sm:px-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-fluid-xl font-semibold tracking-tight text-foreground">
                Lead Pool
              </h1>
              <p className="mt-0.5 text-fluid-xs text-muted">
                {total} lead{total === 1 ? "" : "s"} scraped. Nobody here has been
                emailed — add them to a campaign to queue them.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <button onClick={() => setAdding(true)} className="btn-primary btn-sm">
                  Add {selected.size} to campaign
                </button>
              )}
              <B2BScrapePanel onComplete={() => void load()} />
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <input
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              placeholder="Search name, email or company…"
              className="field-input max-w-xs"
            />
            <select
              value={niche}
              onChange={(e) => {
                setPage(1);
                setNiche(e.target.value);
              }}
              className="field-input max-w-[14rem]"
            >
              <option value="">All niches</option>
              {niches.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              value={poolStatus}
              onChange={(e) => {
                setPage(1);
                setPoolStatus(e.target.value);
              }}
              className="field-input max-w-[14rem]"
            >
              <option value="">All statuses</option>
              <option value="new">Not yet in a campaign</option>
              <option value="in_campaign">In a campaign</option>
              <option value="suppressed">Suppressed</option>
            </select>
          </div>

          {state === "loading" && <SkeletonGrid count={3} />}

          {state === "error" && <ErrorState message={error} onRetry={() => void load()} />}

          {state === "ready" && leads.length === 0 && (
            <EmptyState
              icon={Users}
              title="No leads in the pool"
              hint="Scrape a niche to fill it. Results land here first — you decide which campaign they go into afterwards."
            />
          )}

          {state === "ready" && leads.length > 0 && (
            <>
              <div className="custom-scrollbar overflow-x-auto rounded-3xl border border-line">
                <table className="w-full min-w-[52rem] text-left text-fluid-xs">
                  <thead className="border-b border-line text-muted">
                    <tr>
                      <th className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          checked={allOnPageSelected}
                          onChange={toggleAll}
                          aria-label="Select all on this page"
                        />
                      </th>
                      <th className="px-3 py-3 font-medium">Name</th>
                      <th className="px-3 py-3 font-medium">Company</th>
                      <th className="px-3 py-3 font-medium">Email</th>
                      <th className="px-3 py-3 font-medium">Niche</th>
                      <th className="px-3 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => (
                      <tr
                        key={lead.id}
                        className="border-b border-line/60 last:border-0 hover:bg-canvas-deep/40"
                      >
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={selected.has(lead.id)}
                            onChange={() => toggle(lead.id)}
                            aria-label={`Select ${lead.email}`}
                          />
                        </td>
                        <td className="max-w-[12rem] truncate px-3 py-2.5 font-medium text-foreground">
                          {lead.contact_name || "—"}
                        </td>
                        <td className="max-w-[12rem] truncate px-3 py-2.5 text-muted">
                          {lead.company_name || "—"}
                        </td>
                        <td className="max-w-[16rem] truncate px-3 py-2.5 text-muted">
                          <span className="inline-flex items-center gap-1.5">
                            {lead.email_verified && (
                              <ShieldCheck
                                className="h-3 w-3 shrink-0 text-positive"
                                aria-label={`Verified, score ${lead.verification_score}/100`}
                              />
                            )}
                            {lead.email}
                          </span>
                        </td>
                        <td className="max-w-[10rem] truncate px-3 py-2.5 text-muted">
                          {lead.niche || "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="badge border-line text-muted">
                            {lead.pool_status === "in_campaign"
                              ? "In campaign"
                              : lead.pool_status === "suppressed"
                                ? "Suppressed"
                                : "New"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-center gap-3 text-fluid-xs text-muted">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="btn-ghost btn-sm"
                  >
                    Previous
                  </button>
                  <span className="tabular-nums">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="btn-ghost btn-sm"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </PageTransition>

      <AddToCampaignDialog
        open={adding}
        onClose={() => setAdding(false)}
        selected={[...selected]}
        onAdded={() => {
          setSelected(new Set());
          void load();
        }}
      />
    </div>
  );
}

export default function LeadsPage() {
  return (
    <ToastProvider>
      <LeadPool />
    </ToastProvider>
  );
}
