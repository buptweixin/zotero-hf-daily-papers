/**
 * Sync recent HF daily papers into the library.
 *
 * - Manual sync: Tools menu -> "Sync Recent Papers". Always re-fetches the
 *   full `lookbackDays` window; this is also the way to backfill days that
 *   a previous (auto) sync skipped or failed to fetch.
 * - Auto sync: after startup (if `autoSync` pref is on), only fetches the
 *   days not covered by the last successful sync (see `SyncOptions`).
 *
 * `lastSyncDate` semantics:
 * - Written at the end of every completed sync (manual or auto) with the
 *   day the sync ran on; it means "every day up to and including this date
 *   has been synced".
 * - Auto (incremental) sync fetches only the intersection of
 *   `(lastSyncDate, today]` with the last `lookbackDays` days, so days
 *   already covered by a previous sync are skipped. Enlarging
 *   `lookbackDays` widens the window, so days missed while Zotero was
 *   closed (all days after `lastSyncDate` that fall inside the window)
 *   are picked up automatically. An empty `lastSyncDate` (first run, or
 *   cleared by hand) means the full `lookbackDays` window.
 * - Days whose individual fetch failed while other days succeeded stay
 *   marked as covered; re-fetch them with a manual sync.
 * - `lastSyncDate` is NOT updated when the whole sync fails (e.g. every
 *   date fetch errored), so the next auto sync retries the same window.
 */

import { fetchDailyPapers, HFPaper, shiftDate, todayStr } from "./hf-api";
import { ImportResult, importPapers, summarizeResults } from "./importer";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";

export interface SyncSummary {
  dates: string[];
  papersSeen: number;
  results: ImportResult[];
  created: number;
  exists: number;
  failed: number;
  /** True when this call was a no-op because another sync was running. */
  skipped?: boolean;
  /** Machine-readable reason for `skipped` (currently "sync-in-progress"). */
  skipReason?: string;
}

export interface SyncOptions {
  /**
   * Incremental mode (auto sync): skip dates <= `lastSyncDate` that a
   * previous sync already covered. Manual sync leaves this off and always
   * covers the full `lookbackDays` window.
   */
  incremental?: boolean;
}

/** Module-level re-entrancy guard: only one sync may run at a time. */
let syncing = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The dates to fetch, ordered from oldest to newest so that papers are
 * imported (and date subcollections created) in chronological order.
 *
 * @param days Number of days back from today (clamped to >= 1).
 * @param afterDate When set, only dates strictly after this YYYY-MM-DD are
 *   kept (incremental sync: `lastSyncDate`).
 */
function datesToSync(days: number, afterDate?: string): string[] {
  const dates: string[] = [];
  const today = todayStr();
  const oldest = shiftDate(today, -(Math.max(1, days) - 1));
  for (let d = oldest; d <= today; d = shiftDate(d, 1)) {
    if (!afterDate || d > afterDate) {
      dates.push(d);
    }
  }
  return dates;
}

/**
 * Fetch papers for the given dates (expected oldest -> newest), deduped by
 * arxivId. Papers keep the given date order; within one day the API
 * already returns them sorted by upvotes descending.
 *
 * @returns the papers plus the number of dates whose fetch failed.
 */
async function fetchPapersForDates(
  dates: string[],
): Promise<{ papers: HFPaper[]; failedDates: number }> {
  const seen = new Set<string>();
  const papers: HFPaper[] = [];
  let failedDates = 0;
  for (const date of dates) {
    let daily: HFPaper[] = [];
    try {
      daily = await fetchDailyPapers(date);
    } catch (e) {
      // A single failed date (network error, unpublished list) should not
      // abort the whole sync.
      failedDates++;
      ztoolkit.log(`Fetch failed for ${date}`, e);
    }
    for (const p of daily) {
      if (!seen.has(p.arxivId)) {
        seen.add(p.arxivId);
        papers.push(p);
      }
    }
  }
  return { papers, failedDates };
}

/** Show a transient ProgressWindow note. Best-effort: never throws. */
function showNote(
  text: string,
  type: "default" | "fail",
  closeTimerMs: number,
): void {
  try {
    const win = new ztoolkit.ProgressWindow(
      addon.data.config.addonName,
    ).createLine({
      text,
      type,
    });
    win.show();
    win.startCloseTimer(closeTimerMs);
  } catch (e) {
    // The notification must not break the sync flow.
    ztoolkit.log("Failed to show progress window", e);
  }
}

/** The actual sync; the re-entrancy guard lives in `syncRecentDays`. */
async function performSync(
  days: number | undefined,
  options: SyncOptions | undefined,
): Promise<SyncSummary> {
  const lookback = Math.max(1, days ?? getPref("lookbackDays"));
  const minUpvotes = getPref("minUpvotes");
  // Incremental (auto) sync: only days after `lastSyncDate`. A missing or
  // malformed value means "never synced" -> full lookback window. Manual
  // sync always uses the full window (undefined).
  const last = options?.incremental ? getPref("lastSyncDate") : "";
  const afterDate = DATE_RE.test(last) ? last : undefined;
  const dates = datesToSync(lookback, afterDate);

  const { papers: fetched, failedDates } = await fetchPapersForDates(dates);
  if (dates.length > 0 && failedDates === dates.length) {
    // Whole-sync failure (e.g. the network is down): surface it and do not
    // advance `lastSyncDate`, so the next auto sync retries this window.
    throw new Error(
      `failed to fetch all ${dates.length} day(s) (${dates[0]}..${
        dates[dates.length - 1]
      })`,
    );
  }
  const papers = fetched.filter((p) => p.upvotes >= minUpvotes);

  const summary: SyncSummary = {
    dates,
    papersSeen: papers.length,
    results: [],
    created: 0,
    exists: 0,
    failed: 0,
  };
  if (papers.length > 0) {
    const progressWin = new ztoolkit.ProgressWindow(
      addon.data.config.addonName,
    ).createLine({
      text: getString("sync-importing"),
      type: "default",
      progress: 0,
    });
    progressWin.show();
    try {
      summary.results = await importPapers(papers, {
        onProgress: (done, total) => {
          progressWin.changeLine({
            text: getString("import-progress", {
              args: { done, total },
            }),
            progress: (done / total) * 100,
          });
        },
      });
    } finally {
      progressWin.startCloseTimer(3000);
    }
    const s = summarizeResults(summary.results);
    summary.created = s.created;
    summary.exists = s.exists;
    summary.failed = s.failed;
  }
  setPref("lastSyncDate", todayStr());
  return summary;
}

export async function syncRecentDays(
  days?: number,
  options?: SyncOptions,
): Promise<SyncSummary> {
  // Re-entrancy guard: while a sync is running, additional calls (e.g. the
  // menu item clicked during the startup auto sync) become no-ops marked
  // with `skipped` instead of launching a second concurrent import.
  if (syncing) {
    ztoolkit.log("Sync already in progress; skipping concurrent call");
    showNote(getString("sync-in-progress"), "default", 3000);
    return {
      dates: [],
      papersSeen: 0,
      results: [],
      created: 0,
      exists: 0,
      failed: 0,
      skipped: true,
      skipReason: "sync-in-progress",
    };
  }
  syncing = true;
  try {
    return await performSync(days, options);
  } catch (e) {
    // Make whole-sync failures visible to the user, not just the log; the
    // error is re-thrown so callers (auto sync, menu) can still react.
    ztoolkit.log("Sync failed", e);
    showNote(
      getString("sync-failed", {
        args: { message: e instanceof Error ? e.message : String(e) },
      }),
      "fail",
      8000,
    );
    throw e;
  } finally {
    syncing = false;
  }
}

/** Called from onMainWindowLoad; runs the auto sync quietly after a delay. */
export async function autoSyncOnStartup(): Promise<void> {
  if (!getPref("autoSync")) {
    return;
  }
  // Let Zotero finish startup work first. If the plugin is disabled or
  // Zotero quits during the delay, stop here. A sync still running when
  // Zotero exits simply dies with the process; `syncing` is module state
  // that either never resolves again or is discarded with the module on
  // plugin reload, so it cannot deadlock the next sync.
  await Zotero.Promise.delay(10000);
  if (!addon?.data.alive) {
    return;
  }
  try {
    // Incremental: only days after `lastSyncDate` (see the header comment
    // for the exact semantics).
    const summary = await syncRecentDays(undefined, { incremental: true });
    // The sync can take minutes (PDF downloads); do not touch UI (or show
    // anything) if the plugin was disabled in the meantime.
    if (!addon?.data.alive) {
      return;
    }
    if (summary.skipped) {
      return;
    }
    ztoolkit.log(
      "Auto sync done",
      summary.created,
      summary.exists,
      summary.failed,
    );
    if (summary.created > 0) {
      new ztoolkit.ProgressWindow(addon.data.config.addonName)
        .createLine({
          text: getString("sync-done", {
            args: { created: summary.created, exists: summary.exists },
          }),
          type: "success",
          progress: 100,
        })
        .show();
    }
  } catch (e) {
    // The failure ProgressWindow is already shown by `syncRecentDays`.
    ztoolkit.log("Auto sync failed", e);
  }
}
