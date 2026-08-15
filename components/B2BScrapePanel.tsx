"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Radar } from "lucide-react";

import Modal from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { ScrapeRun } from "@/lib/types";

/**
 * The B2B scraper's launcher and live progress readout.
 *
 * The form renders itself from the actor profiles the server advertises
 * (lib/apify-actors.ts), so connecting a different Apify actor never means
 * editing this component.
 *
 * A run is a background job on the server — the browser only watches it. That
 * is why this polls a run id rather than holding a request open: an actor run
 * takes minutes, and closing this tab must not stop it.
 */

const POLL_MS = 1500;

interface ActorField {
  key: string;
  label: string;
  type: "text" | "number" | "textarea";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string | number;
}

interface Profile {
  id: string;
  label: string;
  description: string;
  fields: ActorField[];
}

export default function B2BScrapePanel({ onComplete }: { onComplete: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<ScrapeRun | null>(null);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [configured, setConfigured] = useState(true);
  const [profileId, setProfileId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [niche, setNiche] = useState("");

  const runId = useRef<string | null>(null);

  // The actor catalogue. Fetched once — it is static config, not live data.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/b2b/scrape");
        const body = await res.json();
        if (!body?.ok) return;
        setProfiles(body.profiles);
        setConfigured(body.configured);
        setProfileId((prev) => prev || body.profiles[0]?.id || "");
      } catch {
        /* The button still renders; starting a scrape will report the error. */
      }
    })();
  }, []);

  const profile = profiles.find((p) => p.id === profileId);

  // Reset the answers when the actor changes — its fields are different.
  useEffect(() => {
    if (!profile) return;
    setValues(
      Object.fromEntries(
        profile.fields.map((f) => [f.key, String(f.defaultValue ?? "")])
      )
    );
  }, [profile]);

  /* Poll the run record until it stops. Keyed on the run id in state (not the
     ref) so the effect re-establishes cleanly when a new run starts, and torn
     down on unmount so navigating away leaves no timer running. */
  useEffect(() => {
    const id = run?.id;
    if (!id || (run.status !== "running" && run.status !== "queued")) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/b2b/scrape?run_id=${id}`);
        const body = await res.json();
        if (cancelled || !body?.ok) return;

        const current = body.run as ScrapeRun;
        setRun(current);

        if (current.status === "complete" || current.status === "failed") {
          runId.current = null;
          clearInterval(timer);
          onComplete();
          if (current.status === "complete") {
            toast(
              "success",
              `Scrape finished — ${current.imported} new leads in the pool, ${current.duplicates} already known.`
            );
          } else {
            toast("error", current.error || "The scrape failed.");
          }
        }
      } catch {
        /* A dropped poll is not a failed scrape — the run continues on the
           server and the next tick picks it back up. */
      }
    };

    const timer = setInterval(tick, POLL_MS);
    void tick();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [run?.id, run?.status, onComplete, toast]);

  async function start() {
    if (!profile) {
      toast("error", "No scraper is configured.");
      return;
    }

    const missing = profile.fields.filter(
      (f) => f.required && !String(values[f.key] ?? "").trim()
    );
    if (missing.length > 0) {
      toast("error", `${missing.map((f) => f.label).join(", ")} is required.`);
      return;
    }

    setStarting(true);
    try {
      const res = await fetch("/api/b2b/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor_profile: profile.id,
          form_values: values,
          niche: niche.trim(),
        }),
      });
      const body = await res.json();

      if (!body?.ok) {
        toast("error", body?.error ?? "Could not start the scrape.");
        return;
      }

      runId.current = body.run_id;
      setRun({
        id: body.run_id,
        cells_total: 2,
        cells_done: 0,
        found: 0,
        imported: 0,
        duplicates: 0,
        blocked: 0,
        status: "running",
      } as ScrapeRun);
      setOpen(false);
      toast("info", "Scraping. This runs in the background — you can leave this page.");
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setStarting(false);
    }
  }

  const active = run && (run.status === "running" || run.status === "queued");
  const percent = run?.cells_total
    ? Math.round((run.cells_done / run.cells_total) * 100)
    : 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={Boolean(active)}
        className="btn-primary btn-sm"
      >
        <Radar className="h-4 w-4" />
        {active ? "Scraping…" : "Scrape Leads"}
      </button>

      <AnimatePresence>
        {active && run && (
          <motion.div
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="card-tight mt-3">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <span className="text-fluid-sm font-medium text-foreground">
                  {run.cells_done === 0
                    ? "Running the Apify actor…"
                    : "Verifying and saving to the pool…"}
                </span>
                <span className="text-fluid-xs tabular-nums text-muted">
                  {percent}%
                </span>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas-deep">
                <motion.div
                  className="h-full rounded-full bg-foreground"
                  animate={{ width: `${percent}%` }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-fluid-xs text-muted">
                <span>
                  <dt className="inline">Found </dt>
                  <dd className="inline font-medium text-foreground">{run.found}</dd>
                </span>
                <span>
                  <dt className="inline">New </dt>
                  <dd className="inline font-medium text-foreground">{run.imported}</dd>
                </span>
                <span>
                  <dt className="inline">Already known </dt>
                  <dd className="inline font-medium text-foreground">{run.duplicates}</dd>
                </span>
                <span>
                  <dt className="inline">Rejected </dt>
                  <dd className="inline font-medium text-foreground">{run.blocked}</dd>
                </span>
              </dl>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Scrape B2B leads"
        description="Results go into the lead pool, not into a campaign. You choose who to email afterwards."
        width="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          {!configured && (
            <p className="rounded-2xl border border-negative/30 px-3 py-2 text-fluid-xs text-negative">
              APIFY_TOKEN is not set, so no scrape can run. Add it to the
              environment and restart.
            </p>
          )}

          <label>
            <span className="field-label">Scraper</span>
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="field-input"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {profile && (
            <p className="text-fluid-xs leading-relaxed text-muted">
              {profile.description}
            </p>
          )}

          <label>
            <span className="field-label">Niche</span>
            <input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="SaaS founders, Manchester"
              className="field-input"
            />
            {/* Not sent to Apify — it is how you find this batch again in a
                pool of thousands, and what a campaign gets named after. */}
            <span className="mt-1 block text-fluid-xs text-muted">
              Your label for this batch. Every lead found is tagged with it.
            </span>
          </label>

          {profile?.fields.map((field) => (
            <label key={field.key}>
              <span className="field-label">
                {field.label}
                {field.required && " *"}
              </span>
              {field.type === "textarea" ? (
                <textarea
                  value={values[field.key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.key]: e.target.value }))
                  }
                  rows={5}
                  placeholder={field.placeholder}
                  className="field-input font-mono text-fluid-xs"
                />
              ) : (
                <input
                  type={field.type === "number" ? "number" : "text"}
                  value={values[field.key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.key]: e.target.value }))
                  }
                  placeholder={field.placeholder}
                  className="field-input"
                />
              )}
              {field.hint && (
                <span className="mt-1 block text-fluid-xs text-muted">
                  {field.hint}
                </span>
              )}
            </label>
          ))}

          <button
            onClick={start}
            disabled={starting || !configured || !profile}
            className="btn-primary w-full"
          >
            {starting ? "Starting…" : "Start scrape"}
          </button>
        </div>
      </Modal>
    </>
  );
}
