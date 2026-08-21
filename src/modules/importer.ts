/**
 * Import HF daily papers into the Zotero library as `preprint` items,
 * following the conventions of the official arXiv translator:
 * repository "arXiv", archiveID `arXiv:<id>`, DOI `10.48550/arXiv.<id>`,
 * url `https://arxiv.org/abs/<id>`. HF-specific info (daily date, upvotes,
 * GitHub/project links) is stored in `extra`.
 */

import { HFPaper } from "./hf-api";
import { buildTagsForPaper, classifyPaper, getTopicRules } from "./classifier";
import { getPref } from "../utils/prefs";

export interface ImportOptions {
  libraryID?: number;
  downloadPdf?: boolean;
  /** Progress callback: (doneCount, totalCount) */
  onProgress?: (done: number, total: number) => void;
  /** Called after each paper finishes (created/exists/failed). */
  onItemDone?: (result: ImportResult, index: number) => void;
}

export type ImportStatus = "created" | "exists" | "failed";

export interface ImportResult {
  arxivId: string;
  status: ImportStatus;
  itemID?: number;
  error?: string;
  /**
   * The item metadata was saved but downloading its PDF failed. `status`
   * stays "created" because the item itself is fine.
   */
  pdfFailed?: boolean;
}

const collectionCache = new Map<string, number>();

// ---------------------------------------------------------------------------
// Cross-entry-point mutex
// ---------------------------------------------------------------------------

/**
 * Both entry points (the browse window's import button and the auto/manual
 * sync) funnel into `importPapers`. Without a lock, two concurrent batches
 * could each run find-then-create on the same paper and create duplicates.
 */
let importing = false;

const LOCK_POLL_MS = 500;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Block until no other import is running. Polls every 500ms and gives up
 * (throwing) after 10 minutes so a stuck import cannot wedge the plugin
 * forever.
 */
async function acquireImportLock(): Promise<void> {
  if (!importing) {
    importing = true;
    return;
  }
  ztoolkit.log("An import is already running; waiting for it to finish");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (importing) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${LOCK_TIMEOUT_MS / 1000}s waiting for the running import`,
      );
    }
    await Zotero.Promise.delay(LOCK_POLL_MS);
  }
  importing = true;
}

// ---------------------------------------------------------------------------
// Library / existing-item lookup
// ---------------------------------------------------------------------------

/** The library to import into: selected library if available, else user library. */
export function getTargetLibraryID(): number {
  try {
    const zp = Zotero.getActiveZoteroPane();
    if (zp) {
      // Zotero 7 exposes getSelectedLibraryID() (there is no
      // getSelectedLibrary()); it is still falsy when nothing is selected.
      const lib = zp.getSelectedLibraryID();
      if (lib) {
        return lib;
      }
    }
  } catch {
    // ignore
  }
  return Zotero.Libraries.userLibraryID;
}

/** Extract the arXiv id from an item's DOI (`10.48550/arXiv.<id>`). */
function arxivIdFromDOI(doi: string): string | undefined {
  const match = /^10\.48550\/arXiv\.(.+)$/.exec(doi.trim());
  return match ? match[1] : undefined;
}

/** Extract the arXiv id from the first `extra` line (`arXiv:<id>`). */
function arxivIdFromExtra(extra: string): string | undefined {
  const firstLine = extra.split("\n", 1)[0].trim();
  return firstLine.startsWith("arXiv:")
    ? firstLine.slice("arXiv:".length)
    : undefined;
}

/** getField() that never throws (e.g. "DOI" is invalid on an attachment). */
function safeGetField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field) || "");
  } catch {
    return "";
  }
}

/**
 * Find an existing item by arXiv id. Searches DOI (always indexed) first,
 * then the `arXiv:<id>` line we always write at the top of `extra`.
 * (`archiveID` is not a valid Zotero.Search condition, so it cannot be
 * searched directly.)
 */
export async function findExistingItem(
  arxivId: string,
  libraryID = getTargetLibraryID(),
): Promise<Zotero.Item | undefined> {
  const conditions: Array<["DOI" | "extra", "is" | "contains", string]> = [
    ["DOI", "is", `10.48550/arXiv.${arxivId}`],
    ["extra", "contains", `arXiv:${arxivId}`],
  ];
  for (const [field, operator, value] of conditions) {
    try {
      const s = new Zotero.Search();
      s.addCondition("libraryID", "is", String(libraryID));
      s.addCondition(field, operator, value);
      const ids = await s.search();
      if (ids.length > 0) {
        const items = await Zotero.Items.getAsync(ids);
        const item = items.find((i) => i && !i.deleted);
        if (item) {
          return item;
        }
      }
    } catch (e) {
      // Should not happen for valid conditions; try the next one anyway.
      ztoolkit.log(`Search by ${field} failed`, e);
    }
  }
  return undefined;
}

/**
 * Resolve the existing items for a batch of arXiv ids.
 *
 * Fast path: one search for everything tagged with the `sourceTag` pref
 * (every item this plugin creates carries it), building an arxivId -> item
 * map in memory from each item's DOI or first `extra` line. Slow path: any
 * id not resolved that way falls back to `findExistingItem`, which also
 * matches items the user imported through the arXiv translator (same DOI,
 * but no plugin tag).
 */
async function findExistingItemObjects(
  arxivIds: string[],
  libraryID: number,
): Promise<Map<string, Zotero.Item>> {
  const result = new Map<string, Zotero.Item>();
  const wanted = new Set(arxivIds);
  try {
    const sourceTag = getPref("sourceTag");
    if (sourceTag) {
      const s = new Zotero.Search();
      s.addCondition("libraryID", "is", String(libraryID));
      s.addCondition("tag", "is", sourceTag);
      const ids = await s.search();
      if (ids.length > 0) {
        const items = await Zotero.Items.getAsync(ids);
        for (const item of items) {
          if (!item || item.deleted) {
            continue;
          }
          const id =
            arxivIdFromDOI(safeGetField(item, "DOI")) ??
            arxivIdFromExtra(safeGetField(item, "extra"));
          if (id && wanted.has(id) && !result.has(id)) {
            result.set(id, item);
          }
        }
      }
    }
  } catch (e) {
    ztoolkit.log("Bulk existing-item search failed", e);
    result.clear();
  }
  for (const id of arxivIds) {
    if (result.has(id)) {
      continue;
    }
    const item = await findExistingItem(id, libraryID);
    if (item) {
      result.set(id, item);
    }
  }
  return result;
}

/** Batch check which papers already exist. Returns arxivId -> itemID. */
export async function findExistingItems(
  arxivIds: string[],
  libraryID = getTargetLibraryID(),
): Promise<Map<string, number>> {
  const items = await findExistingItemObjects(arxivIds, libraryID);
  const result = new Map<string, number>();
  for (const [id, item] of items) {
    result.set(id, item.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

function clearCollectionCache() {
  collectionCache.clear();
}

/**
 * Save inside an explicit transaction (item.save()) or open a per-object
 * transaction (saveTx()) when none is active.
 */
function saveObject(obj: Zotero.DataObject): Promise<boolean | number> {
  return Zotero.DB.inTransaction() ? obj.save() : obj.saveTx();
}

async function getOrCreateCollection(
  name: string,
  libraryID: number,
  parentID?: number,
): Promise<Zotero.Collection> {
  const cacheKey = `${libraryID}/${parentID ?? "root"}/${name}`;
  const cachedID = collectionCache.get(cacheKey);
  if (cachedID) {
    const cached = Zotero.Collections.get(cachedID);
    // The cached collection may since have been trashed, or the id may no
    // longer belong to this library; only reuse live matches.
    if (cached && !cached.deleted && cached.libraryID === libraryID) {
      return cached;
    }
    collectionCache.delete(cacheKey);
  }
  const siblings: Zotero.Collection[] = parentID
    ? (Zotero.Collections.getByParent(
        parentID,
      ) as unknown as Zotero.Collection[])
    : (Zotero.Collections.getByLibrary(
        libraryID,
      ) as unknown as Zotero.Collection[]);
  const found = (siblings || []).find((c) => c.name === name && !c.deleted);
  if (found) {
    collectionCache.set(cacheKey, found.id);
    return found;
  }
  const col = new Zotero.Collection();
  (col as any).libraryID = libraryID;
  col.name = name;
  if (parentID) {
    col.parentID = parentID;
  }
  await saveObject(col);
  collectionCache.set(cacheKey, col.id);
  return col;
}

export async function getRootCollection(
  libraryID = getTargetLibraryID(),
): Promise<Zotero.Collection> {
  return getOrCreateCollection(getPref("rootCollectionName"), libraryID);
}

/** Collection ids a paper should be filed into (date + topic collections). */
async function getCollectionIDsForPaper(
  paper: HFPaper,
  libraryID: number,
): Promise<number[]> {
  const ids: number[] = [];
  const root = await getRootCollection(libraryID);
  const rootID = root.id;

  if (getPref("createDateSubcollections") && paper.dailyDate) {
    const dateCol = await getOrCreateCollection(
      paper.dailyDate,
      libraryID,
      rootID,
    );
    ids.push(dateCol.id);
  }
  if (getPref("createTopicCollections")) {
    const topics = classifyPaper(paper, getTopicRules());
    for (const topic of topics) {
      const topicCol = await getOrCreateCollection(topic, libraryID, rootID);
      ids.push(topicCol.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Item creation
// ---------------------------------------------------------------------------

export function buildExtraText(paper: HFPaper): string {
  const lines = [
    `arXiv:${paper.arxivId}`,
    `HF Daily Papers: ${paper.dailyDate || "unknown"}`,
    `Upvotes: ${paper.upvotes}`,
  ];
  if (paper.githubRepo) {
    lines.push(`GitHub: ${paper.githubRepo}`);
  }
  if (paper.projectPage) {
    lines.push(`Project: ${paper.projectPage}`);
  }
  return lines.join("\n");
}

function toCreator(name: string): {
  creatorType: "author";
  firstName: string;
  lastName: string;
} {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) {
    return {
      creatorType: "author",
      firstName: "",
      lastName: parts[0] || name,
    };
  }
  return {
    creatorType: "author",
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

async function attachPdf(paper: HFPaper, itemID: number): Promise<void> {
  const url = `https://arxiv.org/pdf/${paper.arxivId}`;
  // Zotero 7 takes a single options object; the old two-argument
  // (url, options) form was the Zotero 4 API and no longer exists.
  await Zotero.Attachments.importFromURL({
    url,
    parentItemID: itemID,
    contentType: "application/pdf",
    title: "Full Text PDF",
  });
}

/**
 * Build and save one paper item (metadata, tags, collections). Must be
 * called inside a transaction (uses item.save(), not saveTx()).
 */
async function createItemForPaper(
  paper: HFPaper,
  libraryID: number,
): Promise<number> {
  const item = new Zotero.Item("preprint");
  (item as any).libraryID = libraryID;
  item.setField("title", paper.title);
  item.setCreators(paper.authors.map(toCreator));
  item.setField("abstractNote", paper.abstract);
  if (paper.publishedAt) {
    item.setField("date", paper.publishedAt.slice(0, 10));
  }
  item.setField("repository", "arXiv");
  item.setField("archiveID", `arXiv:${paper.arxivId}`);
  item.setField("DOI", `10.48550/arXiv.${paper.arxivId}`);
  item.setField("url", `https://arxiv.org/abs/${paper.arxivId}`);
  item.setField("extra", buildExtraText(paper));
  item.setTags(buildTagsForPaper(paper));
  const collectionIDs = await getCollectionIDsForPaper(paper, libraryID);
  if (collectionIDs.length > 0) {
    item.setCollections(collectionIDs);
  }
  // save() returns the new itemID for a fresh item.
  return (await item.save()) as number;
}

async function ensureInCollections(
  item: Zotero.Item,
  paper: HFPaper,
  libraryID: number,
): Promise<void> {
  try {
    const wanted = await getCollectionIDsForPaper(paper, libraryID);
    const current = item.getCollections();
    const missing = wanted.filter((id) => !current.includes(id));
    if (missing.length === 0) {
      return;
    }
    for (const id of missing) {
      item.addToCollection(id);
    }
    await saveObject(item);
  } catch (e) {
    ztoolkit.log(`Re-filing failed for ${paper.arxivId}`, e);
  }
}

/**
 * Import a batch of papers.
 *
 * The whole batch's metadata (new items, tags, collections, re-filing of
 * existing items) is written in a single DB transaction, so 50 papers cost
 * one commit instead of one per item. A paper that fails is recorded as
 * "failed" and does not roll back or abort the rest. PDF downloads are
 * network I/O and therefore run after the transaction commits, one at a
 * time, throttled to be kind to arxiv.org. There is no inter-item delay
 * for the metadata loop itself: it only touches the local database.
 */
export async function importPapers(
  papers: HFPaper[],
  options: ImportOptions = {},
): Promise<ImportResult[]> {
  await acquireImportLock();
  try {
    clearCollectionCache();
    const total = papers.length;
    const results: ImportResult[] = [];
    if (total === 0) {
      return results;
    }
    const libraryID = options.libraryID ?? getTargetLibraryID();
    const downloadPdf = options.downloadPdf ?? getPref("downloadPdf");
    // One bulk lookup for the whole batch instead of a search per paper.
    const existing = await findExistingItemObjects(
      papers.map((p) => p.arxivId),
      libraryID,
    );
    // PDF jobs collected while the transaction runs, executed after it.
    const pdfJobs: Array<{ paper: HFPaper; result: ImportResult }> = [];

    await Zotero.DB.executeTransaction(async () => {
      for (let i = 0; i < total; i++) {
        const paper = papers[i];
        let result: ImportResult;
        try {
          const existingItem = existing.get(paper.arxivId);
          if (existingItem) {
            // Re-file into the current date/topic collections if needed.
            await ensureInCollections(existingItem, paper, libraryID);
            result = {
              arxivId: paper.arxivId,
              status: "exists",
              itemID: existingItem.id,
            };
          } else {
            const itemID = await createItemForPaper(paper, libraryID);
            // Same paper twice in one batch dedupes to the first item.
            existing.set(paper.arxivId, Zotero.Items.get(itemID));
            result = {
              arxivId: paper.arxivId,
              status: "created",
              itemID,
            };
            if (downloadPdf) {
              pdfJobs.push({ paper, result });
            }
          }
        } catch (e: any) {
          ztoolkit.log(`Import failed for ${paper.arxivId}`, e);
          result = {
            arxivId: paper.arxivId,
            status: "failed",
            error: e?.message || String(e),
          };
        }
        results.push(result);
        // Fire callbacks as each item is saved so the UI keeps updating;
        // a later PDF failure only patches `pdfFailed` on the result.
        options.onItemDone?.(result, i);
        options.onProgress?.(results.length, total);
      }
    });

    for (let i = 0; i < pdfJobs.length; i++) {
      const { paper, result } = pdfJobs[i];
      try {
        await attachPdf(paper, result.itemID!);
      } catch (e) {
        ztoolkit.log(`PDF download failed for ${paper.arxivId}`, e);
        result.pdfFailed = true;
      }
      if (i < pdfJobs.length - 1) {
        await Zotero.Promise.delay(150);
      }
    }
    return results;
  } finally {
    importing = false;
  }
}

export function summarizeResults(results: ImportResult[]): {
  created: number;
  exists: number;
  failed: number;
} {
  return {
    created: results.filter((r) => r.status === "created").length,
    exists: results.filter((r) => r.status === "exists").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}
