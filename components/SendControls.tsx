"use client";

import { useCallback, useEffect, useState } from "react";
import { Pause, Play, Send, Settings2 } from "lucide-react";

import Modal from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { B2BCampaign } from "@/lib/types";

/**
 * The campaign's send controls — pace, start/pause, and a manual batch.
 *
 * The readout is the important part. A campaign that is "running" with 90
 * leads still waiting looks identical to one that has finished unless the
 * numbers are on screen, so this states the queue, the pace and how many days
 * are left at that pace.
 */

interface QueueState {
  queued: number;
  sending: number;
  failed: number;
  contacted: number;
}

export default function SendControls({
  campaign,
  onChanged,
}: {
  campaign: B2BCampaign;
  onChanged: (c: B2BCampaign) => void;
}) {
  const { toast } = useToast();
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [limit, setLimit] = useState(String(campaign.daily_send_limit || 10));
  const [time, setTime] = useState(campaign.send_time || "09:00");
  const [zone, setZone] = useState(campaign.send_timezone || "Europe/London");

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/b2b/dispatch?campaign_id=${campaign.id}`);
      const body = await res.json();
      if (body?.ok) setQueue(body);
    } catch {
      /* The controls still work; only the readout is missing. */
    }
  }, [campaign.id]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    setLimit(String(campaign.daily_send_limit || 10));
    setTime(campaign.send_time || "09:00");
    setZone(campaign.send_timezone || "Europe/London");
  }, [campaign]);

  async function patch(fields: Partial<B2BCampaign>, successMessage?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/b2b/campaigns", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: campaign.id, ...fields }),
      });
      const body = await res.json();
      if (!body?.ok) {
        toast("error", body?.error ?? "Could not update the campaign.");
        return false;
      }
      onChanged(body.campaign);
      if (successMessage) toast("success", successMessage);
      return true;
    } catch {
      toast("error", "Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggleSending() {
    const next = !campaign.sending_active;
    await patch(
      { sending_active: next },
      next
        ? `Sending started — ${perDay} a day at ${campaign.send_time || "09:00"}.`
        : "Sending paused. Nothing further will go out."
    );
    void loadQueue();
  }

  async function sendNow() {
    setBusy(true);
    try {
      const res = await fetch("/api/b2b/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: campaign.id }),
      });
      const body = await res.json();
      if (!body?.ok) {
        toast("error", body?.error ?? "Could not send the batch.");
        return;
      }
      const { sent, skipped } = body.result;
      toast(
        sent > 0 ? "success" : "info",
        sent > 0
          ? `${sent} email${sent === 1 ? "" : "s"} handed to n8n. They move to Sent once n8n confirms.`
          : `Nothing sent — ${skipped ?? "no leads were queued"}.`
      );
      void loadQueue();
      onChanged(campaign);
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      toast("error", "Daily limit must be at least 1.");
      return;
    }
    const okSaved = await patch(
      {
        daily_send_limit: Math.floor(parsedLimit),
        send_time: time,
        send_timezone: zone,
      },
      "Send settings updated."
    );
    if (okSaved) setEditing(false);
  }

  const perDay = campaign.daily_send_limit || 10;
  const queued = queue?.queued ?? 0;
  const daysLeft = queued > 0 ? Math.ceil(queued / perDay) : 0;

  return (
    <>
      <div className="card-tight mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-fluid-sm font-medium text-foreground">
            {campaign.sending_active ? "Sending" : "Paused"} ·{" "}
            <span className="tabular-nums">{perDay}</span> a day at{" "}
            <span className="tabular-nums">{campaign.send_time || "09:00"}</span>
          </p>
          <p className="mt-0.5 text-fluid-xs text-muted">
            {queue === null ? (
              "Loading queue…"
            ) : queued === 0 ? (
              `${queue.contacted} contacted · nothing left in the queue`
            ) : (
              <>
                <span className="tabular-nums">{queued}</span> queued ·{" "}
                <span className="tabular-nums">{queue.contacted}</span> contacted ·{" "}
                {campaign.sending_active
                  ? `about ${daysLeft} day${daysLeft === 1 ? "" : "s"} to work through`
                  : "waiting for you to press Start"}
                {queue.failed > 0 && (
                  <span className="text-negative">
                    {" "}
                    · {queue.failed} failed
                  </span>
                )}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="btn-ghost btn-sm"
            title="Daily limit, send time and timezone"
          >
            <Settings2 className="h-4 w-4" />
            Pace
          </button>

          <button
            onClick={sendNow}
            disabled={busy || queued === 0}
            className="btn-ghost btn-sm"
            title="Send the next batch immediately, without waiting for the send time"
          >
            <Send className="h-4 w-4" />
            Send next batch
          </button>

          <button onClick={toggleSending} disabled={busy} className="btn-primary btn-sm">
            {campaign.sending_active ? (
              <>
                <Pause className="h-4 w-4" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Start sending
              </>
            )}
          </button>
        </div>
      </div>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Sending pace"
        description="How many first emails leave each day, and when. Follow-ups are scheduled by n8n and are not counted against this limit."
        width="max-w-md"
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="field-label">Emails per day</span>
            <input
              type="number"
              min={1}
              max={200}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="field-input"
            />
            <span className="mt-1 block text-fluid-xs text-muted">
              Keep this low on a new sending domain — a sudden spike is what
              gets an address filtered.
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="field-label">Send at</span>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="field-input"
              />
            </label>

            <label>
              <span className="field-label">Timezone</span>
              <input
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                placeholder="Europe/London"
                className="field-input"
              />
            </label>
          </div>

          <button onClick={saveSettings} disabled={busy} className="btn-primary w-full">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </Modal>
    </>
  );
}
