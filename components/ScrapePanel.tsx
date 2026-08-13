"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Radar } from "lucide-react";

import Modal from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { ScrapeRun } from "@/lib/types";

/**
 * The grid scraper's launcher and live progress readout.
 *
 * A run is a background job on the server — the browser only watches it. That
 * is why this polls a run id rather than holding a request open: a 60-cell
 * scrape takes minutes, and closing this tab must not stop it.
 */

const POLL_MS = 1500;

export default function ScrapePanel({ onComplete }: { onComplete: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<ScrapeRun | null>(null);

  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [searchRadius, setSearchRadius] = useState(5000);
  const [cellRadius, setCellRadius] = useState(1500);

  const runId = useRef<string | null>(null);

  // Poll the run record until it stops. The interval is torn down on unmount
  // so navigating away mid-scrape does not leave a timer running.
  useEffect(() => {
    if (!runId.current) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/trades/scrape?run_id=${runId.current}`);
        const body = await res.json();
        if (cancelled || !body?.ok) return;

        const current = body.run as ScrapeRun;
        setRun(current);

        if (current.status === "complete" || current.status === "failed") {
          runId.current = null;
          clearInterval(id);
          onComplete();
          if (current.status === "complete") {
            toast(
              "success",
              `Scrape finished — ${current.imported} new leads, ${current.duplicates} duplicates skipped.`
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

    const id = setInterval(tick, POLL_MS);
    void tick();

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [run?.id, onComplete, toast]);

  async function start() {
    if (!keyword.trim() || !query.trim()) {
      toast("error", "Enter both a trade and a location.");
      return;
    }

    setStarting(true);
    try {
      const res = await fetch("/api/trades/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, keyword, searchRadius, cellRadius }),
      });
      const body = await res.json();

      if (!body?.ok) {
        toast("error", body?.error ?? "Could not start the scrape.");
        return;
      }

      runId.current = body.run_id;
      setRun({
        id: body.run_id,
        cells_total: body.cells,
        cells_done: 0,
        found: 0,
        imported: 0,
        duplicates: 0,
        blocked: 0,
        status: "running",
      } as ScrapeRun);
      setOpen(false);
      toast(
        "info",
        `Scraping ${body.cells} grid cells around ${body.centre.label}. This runs in the background.`
      );
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
                  Grid scrape running — cell {run.cells_done} of {run.cells_total}
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
                  <dt className="inline">Imported </dt>
                  <dd className="inline font-medium text-foreground">{run.imported}</dd>
                </span>
                <span>
                  <dt className="inline">Duplicates </dt>
                  <dd className="inline font-medium text-foreground">{run.duplicates}</dd>
                </span>
                <span>
                  <dt className="inline">Blocked </dt>
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
        title="Scrape local trades"
        description="The search area is split into overlapping cells and searched one cell at a time, which is how the run gets past Google's 120-result ceiling."
        width="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="field-label">Trade</span>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="plumber, roofer, electrician…"
              className="field-input"
            />
          </label>

          <label>
            <span className="field-label">Location</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Manchester, or M1 4BT"
              className="field-input"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="field-label">Search radius</span>
              <select
                value={searchRadius}
                onChange={(e) => setSearchRadius(Number(e.target.value))}
                className="field-input"
              >
                <option value={2000}>2 km</option>
                <option value={5000}>5 km</option>
                <option value={10000}>10 km</option>
                <option value={20000}>20 km</option>
              </select>
            </label>

            <label>
              <span className="field-label">Cell size</span>
              <select
                value={cellRadius}
                onChange={(e) => setCellRadius(Number(e.target.value))}
                className="field-input"
              >
                <option value={800}>800 m — dense city</option>
                <option value={1500}>1.5 km — town</option>
                <option value={3000}>3 km — rural</option>
              </select>
            </label>
          </div>

          {/* Places bills per request and a large grid is thousands of them.
              Saying so here is cheaper than a surprise invoice. */}
          <p className="text-fluid-xs leading-relaxed text-muted">
            Smaller cells find more businesses in dense areas but cost more
            Google Places calls. Each result also costs one Place Details call,
            which is where the phone number comes from.
          </p>

          <button onClick={start} disabled={starting} className="btn-primary w-full">
            {starting ? "Starting…" : "Start scrape"}
          </button>
        </div>
      </Modal>
    </>
  );
}
