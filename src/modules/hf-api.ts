/**
 * HuggingFace Daily Papers API client.
 *
 * Endpoints (no auth required):
 * - GET https://huggingface.co/api/daily_papers[?date=YYYY-MM-DD]
 * - GET https://huggingface.co/api/papers/{arxivId}
 */

const HF_API_BASE = "https://huggingface.co/api";

/** Base daily_papers endpoint (no query string), for debug logging. */
export const HF_API_DAILY_PAPERS_URL = `${HF_API_BASE}/daily_papers`;

/**
 * Request timeout: the HF API normally answers within a couple of seconds,
 * so 20s is a generous ceiling; anything slower is almost certainly stuck,
 * and a fresh retry (see below) is more useful than waiting longer.
 */
const REQUEST_TIMEOUT_MS = 20000;

/** Max retries for transient failures (network errors, HTTP 429 and 5xx). */
const MAX_RETRIES = 2;

/** Base delay between retries, doubled per attempt (1s, then 2s). */
const RETRY_BASE_DELAY_MS = 1000;

/** Strict YYYY-MM-DD, the only date format the daily_papers API accepts. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface HFPaper {
  /** arXiv id without the `arXiv:` prefix, e.g. "2401.12345" */
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  upvotes: number;
  /** arXiv publish date (ISO string) */
  publishedAt: string;
  /** Which daily list this paper belongs to, YYYY-MM-DD */
  dailyDate: string;
  aiKeywords: string[];
  githubRepo?: string;
  projectPage?: string;
  numComments: number;
  thumbnail?: string;
  paperUrl: string;
}

interface RawAuthor {
  _id?: string;
  name?: string;
  hidden?: boolean;
}

interface RawPaper {
  id?: string;
  title?: string;
  summary?: string;
  publishedAt?: string;
  submittedOnDailyAt?: string;
  upvotes?: number;
  ai_keywords?: string[];
  githubRepo?: string;
  projectPage?: string;
  authors?: RawAuthor[];
}

interface RawDailyPaperEntry {
  paper?: RawPaper;
  numComments?: number;
  thumbnail?: string;
}

export class HFApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "HFApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failure looks transient and is worth retrying: network-level
 * errors carry no usable status (0/undefined), plus HTTP 429 and 5xx.
 * Other 4xx statuses are permanent and must not be retried.
 */
function isTransientStatus(status: number | undefined): boolean {
  return !status || status === 429 || status >= 500;
}

function describeFailure(e: any): string {
  return e?.status ? `HTTP ${e.status}` : e?.message || "network error";
}

/**
 * GET a JSON document, retrying transient failures with exponential
 * backoff. `context` (e.g. "daily_papers (date=2026-01-31)") is embedded
 * in error messages so callers can show what failed without extra plumbing.
 */
async function getJSON<T>(url: string, context: string): Promise<T> {
  let lastError = new HFApiError(`${context}: request failed`);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s after the first failure, 2s after the second.
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
    let xhr: XMLHttpRequest;
    try {
      xhr = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: REQUEST_TIMEOUT_MS,
      });
    } catch (e: any) {
      // Zotero rejects with the xhr itself on non-2xx statuses.
      lastError = new HFApiError(
        `${context}: request failed (${describeFailure(e)}) ${url}`,
        e?.status,
      );
      if (isTransientStatus(e?.status) && attempt < MAX_RETRIES) {
        continue;
      }
      throw lastError;
    }
    if (xhr.status !== 200) {
      lastError = new HFApiError(
        `${context}: HTTP ${xhr.status} for ${url}`,
        xhr.status,
      );
      if (isTransientStatus(xhr.status) && attempt < MAX_RETRIES) {
        continue;
      }
      throw lastError;
    }
    return xhr.response as T;
  }
  // Unreachable in practice: the final attempt always returns or throws.
  throw lastError;
}

function normalizePaper(
  raw: RawPaper | null | undefined,
  numComments = 0,
  thumbnail?: string,
): HFPaper | null {
  // Defensive: entries missing id or title cannot be imported; a null body
  // or member is treated the same way instead of throwing.
  if (!raw || !raw.id || !raw.title) {
    return null;
  }
  return {
    arxivId: raw.id,
    title: raw.title,
    authors: (raw.authors || [])
      .filter((a) => !a.hidden && a.name)
      .map((a) => a.name as string),
    abstract: raw.summary || "",
    upvotes: raw.upvotes || 0,
    publishedAt: raw.publishedAt || "",
    dailyDate: (raw.submittedOnDailyAt || "").slice(0, 10),
    aiKeywords: raw.ai_keywords || [],
    githubRepo: raw.githubRepo || undefined,
    projectPage: raw.projectPage || undefined,
    numComments,
    thumbnail,
    paperUrl: `https://huggingface.co/papers/${raw.id}`,
  };
}

/**
 * Fetch the daily papers list. Without `date`, returns the current list
 * (may span today and yesterday). Sorted by upvotes descending.
 */
export async function fetchDailyPapers(date?: string): Promise<HFPaper[]> {
  // An empty string keeps the old "no date" meaning (the current list);
  // any non-empty value must be a real YYYY-MM-DD calendar date.
  if (date && !isValidDateStr(date)) {
    throw new HFApiError(
      `Invalid date "${date}" for daily_papers: expected YYYY-MM-DD`,
    );
  }
  const url = date
    ? `${HF_API_DAILY_PAPERS_URL}?date=${date}`
    : HF_API_DAILY_PAPERS_URL;
  const context = `daily_papers${date ? ` (date=${date})` : ""}`;
  const raw = await getJSON<RawDailyPaperEntry[]>(url, context);
  if (!Array.isArray(raw)) {
    throw new HFApiError(
      `${context}: unexpected response shape (expected an array) ${url}`,
    );
  }
  const papers: HFPaper[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const paper = normalizePaper(
      entry?.paper,
      entry?.numComments || 0,
      entry?.thumbnail,
    );
    if (paper) {
      papers.push(paper);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) {
    ztoolkit.log(`${context}: skipped ${skipped} entries without id/title`);
  }
  return papers.sort((a, b) => b.upvotes - a.upvotes);
}

/** Fetch a single paper's detail (contains linked models/datasets/spaces). */
export async function fetchPaperDetail(
  arxivId: string,
): Promise<HFPaper | null> {
  const raw = await getJSON<RawPaper>(
    `${HF_API_BASE}/papers/${arxivId}`,
    `paper ${arxivId}`,
  );
  return normalizePaper(raw);
}

/** YYYY-MM-DD of today in local time. */
export function todayStr(): string {
  return formatDate(new Date());
}

/**
 * Whether `s` is a real YYYY-MM-DD calendar date (rejects wrong formats and
 * impossible dates such as 2026-02-30).
 */
export function isValidDateStr(s: string): boolean {
  if (typeof s !== "string" || !DATE_RE.test(s)) {
    return false;
  }
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
  );
}

/** Format as YYYY-MM-DD; returns "" for invalid dates instead of throwing. */
export function formatDate(d: Date): string {
  if (!d || isNaN(d.getTime())) {
    return "";
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a YYYY-MM-DD string as a local-time Date. Never throws: invalid
 * input yields an invalid Date (check with isNaN(d.getTime())).
 */
export function parseDate(s: string): Date {
  if (!isValidDateStr(s)) {
    return new Date(NaN);
  }
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Shift a YYYY-MM-DD date by `days`; returns "" for invalid input. */
export function shiftDate(date: string, days: number): string {
  const d = parseDate(date);
  if (isNaN(d.getTime())) {
    return "";
  }
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

/**
 * The most recent day that can have a daily list: arXiv announces on
 * weekdays, so weekends roll back to Friday.
 */
export function latestListDate(): string {
  let date = todayStr();
  while ([0, 6].includes(parseDate(date).getDay())) {
    date = shiftDate(date, -1);
  }
  return date;
}
