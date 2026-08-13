import type PocketBase from "pocketbase";

import { COLLECTIONS, describePocketBaseError } from "@/lib/pocketbase";
import type { ScrapeKind, ScrapeRun } from "@/lib/types";

/**
 * Background scrape-run tracking.
 *
 * A grid scrape across 60 cells takes minutes — longer than any HTTP request
 * should be held open, and longer than most hosts allow. So the route creates
 * a `scrape_runs` record, returns its id immediately, and processes cells in a
 * detached loop that writes progress as it goes. The UI polls that record.
 *
 * The record is the run's only durable state, which is what makes the run
 * survive a closed browser tab: nothing about its progress lives in the page.
 */

export interface ProgressDelta {
  cellsDone?: number;
  found?: number;
  imported?: number;
  duplicates?: number;
  blocked?: number;
}

export async function createRun(
  pb: PocketBase,
  kind: ScrapeKind,
  params: Record<string, unknown>,
  cellsTotal: number
): Promise<ScrapeRun> {
  return await pb.collection(COLLECTIONS.scrapeRuns).create<ScrapeRun>({
    kind,
    status: "running",
    params,
    cells_total: cellsTotal,
    cells_done: 0,
    found: 0,
    imported: 0,
    duplicates: 0,
    blocked: 0,
    error: "",
    started_at: new Date().toISOString(),
    finished_at: "",
  });
}

/**
 * Applies a progress delta.
 *
 * Reads the current record first rather than sending increments, because
 * PocketBase has no atomic increment. That is a benign race in principle —
 * but each run is processed by exactly one loop, so there is only ever one
 * writer per record and the read-modify-write cannot interleave.
 *
 * Never throws: losing a progress tick must not abort a scrape that is
 * otherwise working. The next tick corrects the display.
 */
export async function bumpProgress(
  pb: PocketBase,
  runId: string,
  delta: ProgressDelta
): Promise<void> {
  try {
    const current = await pb
      .collection(COLLECTIONS.scrapeRuns)
      .getOne<ScrapeRun>(runId);

    await pb.collection(COLLECTIONS.scrapeRuns).update(runId, {
      cells_done: current.cells_done + (delta.cellsDone ?? 0),
      found: current.found + (delta.found ?? 0),
      imported: current.imported + (delta.imported ?? 0),
      duplicates: current.duplicates + (delta.duplicates ?? 0),
      blocked: current.blocked + (delta.blocked ?? 0),
    });
  } catch (err) {
    console.error(`[jobs] progress update failed for ${runId}:`, err);
  }
}

export async function completeRun(
  pb: PocketBase,
  runId: string,
  patch: Partial<Pick<ScrapeRun, "cells_total">> = {}
): Promise<void> {
  try {
    await pb.collection(COLLECTIONS.scrapeRuns).update(runId, {
      ...patch,
      status: "complete",
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[jobs] could not mark ${runId} complete:`, err);
  }
}

export async function failRun(
  pb: PocketBase,
  runId: string,
  reason: unknown
): Promise<void> {
  const message =
    reason instanceof Error ? reason.message : describePocketBaseError(reason);
  try {
    await pb.collection(COLLECTIONS.scrapeRuns).update(runId, {
      status: "failed",
      error: message.slice(0, 500),
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[jobs] could not mark ${runId} failed:`, err);
  }
}

/**
 * Runs work detached from the HTTP response.
 *
 * The route has already answered by the time this resolves. Any error must be
 * caught here or it surfaces as an unhandled rejection that can take the
 * server process down — and the run record would be left stuck on "running"
 * forever with no explanation in the UI.
 */
export function runDetached(
  pb: PocketBase,
  runId: string,
  work: () => Promise<void>
): void {
  void work().catch(async (err) => {
    console.error(`[jobs] run ${runId} crashed:`, err);
    await failRun(pb, runId, err);
  });
}
