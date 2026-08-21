/**
 * The HuggingFace Daily Papers browse window.
 *
 * `addon/content/papers.xhtml` is only a skeleton. This module opens it via
 * `openDialog` from the main window, then builds the whole UI by manipulating
 * the dialog window's document. All event listeners run in the plugin sandbox
 * (main window context), so we never depend on plugin globals being available
 * inside the new window.
 */

import { config } from "../../package.json";
import {
  fetchDailyPapers,
  HFApiError,
  HFPaper,
  latestListDate,
  shiftDate,
} from "./hf-api";
import { findExistingItems, importPapers, summarizeResults } from "./importer";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";

const WINDOW_URL = `chrome://${config.addonRef}/content/papers.xhtml`;
const WINDOW_FEATURES =
  "chrome,centerscreen,resizable=yes,dialog=no,width=1000,height=740";

interface WindowState {
  win: Window;
  papers: HFPaper[];
  existing: Map<string, number>;
  selected: Set<string>;
  filter: string;
  importing: boolean;
  loading: boolean;
  /** arxivIds of papers whose abstract is expanded; survives re-renders. */
  expandedAbstracts: Set<string>;
  /** Last known list scroll offset, restored after a re-render. */
  listScrollTop: number;
}

/**
 * Open the browse window, or focus it if already open.
 */
export async function openPapersWindow(): Promise<void> {
  const current = addon.data.papersWindow;
  if (isWindowAlive(current)) {
    current!.focus();
    return;
  }
  const mainWin = Zotero.getMainWindow();
  const win = (mainWin as any).openDialog(
    WINDOW_URL,
    `${config.addonRef}-papers-window`,
    WINDOW_FEATURES,
  ) as Window;
  addon.data.papersWindow = win;
  win.addEventListener("unload", () => {
    if (addon.data.papersWindow === win) {
      addon.data.papersWindow = undefined;
    }
  });
  await new Promise<void>((resolve) => {
    if (win.document.readyState === "complete") {
      resolve();
    } else {
      win.addEventListener("load", () => resolve(), { once: true });
    }
  });
  if (!isWindowAlive(win)) {
    return;
  }
  const state: WindowState = {
    win,
    papers: [],
    existing: new Map(),
    selected: new Set(),
    filter: "",
    importing: false,
    loading: false,
    expandedAbstracts: new Set(),
    listScrollTop: 0,
  };
  buildUI(state);
  await loadPapers(state, latestListDate());
}

// ---------------------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------------------

type ElOpts = {
  classList?: string[];
  text?: string;
  attrs?: Record<string, string>;
  listeners?: Array<{ type: string; listener: (ev: any) => void }>;
};

function el<T extends HTMLElement>(
  doc: Document,
  tag: string,
  opts: ElOpts = {},
): T {
  const node = doc.createElement(tag) as T;
  if (opts.classList) {
    node.classList.add(...opts.classList);
  }
  if (opts.text !== undefined) {
    node.textContent = opts.text;
  }
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      node.setAttribute(k, v);
    }
  }
  if (opts.listeners) {
    for (const l of opts.listeners) {
      node.addEventListener(l.type, l.listener);
    }
  }
  return node;
}

function buildUI(state: WindowState) {
  const doc = state.win.document;
  const app = doc.getElementById("app")!;
  doc.title = getString("window-title");

  // Escape closes the window, matching common dialog behavior.
  doc.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Escape") {
      state.win.close();
    }
  });

  // ---- Toolbar ----
  const toolbar = el<HTMLDivElement>(doc, "div", {
    classList: ["hfp-toolbar"],
  });

  const dateInput = el<HTMLInputElement>(doc, "input", {
    attrs: { type: "date" },
    listeners: [
      {
        type: "change",
        listener: () => {
          if (dateInput.value) {
            loadPapers(state, dateInput.value);
          }
        },
      },
    ],
  });
  dateInput.value = latestListDate();

  const prevBtn = el<HTMLButtonElement>(doc, "button", {
    text: "‹",
    attrs: { title: getString("window-prev-day") },
    listeners: [
      {
        type: "click",
        listener: () => {
          dateInput.value = shiftDate(dateInput.value || latestListDate(), -1);
          loadPapers(state, dateInput.value);
        },
      },
    ],
  });
  const nextBtn = el<HTMLButtonElement>(doc, "button", {
    text: "›",
    attrs: { title: getString("window-next-day") },
    listeners: [
      {
        type: "click",
        listener: () => {
          dateInput.value = shiftDate(dateInput.value || latestListDate(), 1);
          loadPapers(state, dateInput.value);
        },
      },
    ],
  });
  const refreshBtn = el<HTMLButtonElement>(doc, "button", {
    text: getString("window-refresh"),
    listeners: [
      {
        type: "click",
        listener: () => loadPapers(state, dateInput.value || latestListDate()),
      },
    ],
  });

  const filterInput = el<HTMLInputElement>(doc, "input", {
    attrs: {
      type: "text",
      placeholder: getString("window-filter-placeholder"),
    },
  });
  filterInput.addEventListener("keydown", (ev) => {
    // There is no form, but make sure Enter does nothing unexpected.
    if ((ev as KeyboardEvent).key === "Enter") {
      ev.preventDefault();
    }
  });
  filterInput.addEventListener("input", () => {
    // Skip re-renders while a load/import is in flight so the
    // loading/error message is not replaced by a stale list.
    if (state.loading || state.importing) {
      return;
    }
    state.filter = filterInput.value.trim().toLowerCase();
    renderList(state);
  });

  const selectAllLabel = el<HTMLLabelElement>(doc, "label", {
    classList: ["hfp-select-all"],
  });
  const selectAllBox = el<HTMLInputElement>(doc, "input", {
    attrs: { type: "checkbox" },
  });
  selectAllBox.addEventListener("change", () => {
    if (state.loading || state.importing) {
      return;
    }
    const on = selectAllBox.checked;
    for (const p of visiblePapers(state)) {
      if (state.existing.has(p.arxivId) || state.importing) {
        continue;
      }
      if (on) {
        state.selected.add(p.arxivId);
      } else {
        state.selected.delete(p.arxivId);
      }
    }
    renderList(state);
  });
  selectAllLabel.appendChild(selectAllBox);
  selectAllLabel.appendChild(
    el<HTMLSpanElement>(doc, "span", { text: getString("window-select-all") }),
  );

  toolbar.append(
    dateInput,
    prevBtn,
    nextBtn,
    refreshBtn,
    filterInput,
    selectAllLabel,
  );

  // ---- Paper list ----
  const list = el<HTMLDivElement>(doc, "div", { classList: ["hfp-list"] });

  // ---- Footer ----
  const footer = el<HTMLDivElement>(doc, "div", { classList: ["hfp-footer"] });

  const pdfOption = el<HTMLLabelElement>(doc, "label", {
    classList: ["hfp-pdf-option"],
  });
  const pdfBox = el<HTMLInputElement>(doc, "input", {
    attrs: { type: "checkbox" },
  });
  pdfBox.checked = getPref("downloadPdf");
  pdfOption.append(
    pdfBox,
    el<HTMLSpanElement>(doc, "span", {
      text: getString("window-download-pdf"),
    }),
  );

  const countLabel = el<HTMLSpanElement>(doc, "span", {
    classList: ["hfp-count"],
  });

  const importBtn = el<HTMLButtonElement>(doc, "button", {
    text: getString("window-import-selected"),
    listeners: [{ type: "click", listener: () => runImport(state) }],
  });

  footer.append(pdfOption, countLabel, importBtn);

  app.append(toolbar, list, footer);

  (state as any)._ui = {
    dateInput,
    prevBtn,
    nextBtn,
    refreshBtn,
    filterInput,
    selectAllBox,
    list,
    countLabel,
    importBtn,
    pdfBox,
  };
  updateFooter(state);
}

// ---------------------------------------------------------------------------
// Data loading & rendering
// ---------------------------------------------------------------------------

function ui(state: WindowState) {
  return (state as any)._ui as {
    dateInput: HTMLInputElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    refreshBtn: HTMLButtonElement;
    filterInput: HTMLInputElement;
    selectAllBox: HTMLInputElement;
    list: HTMLDivElement;
    countLabel: HTMLSpanElement;
    importBtn: HTMLButtonElement;
    pdfBox: HTMLInputElement;
  };
}

/**
 * Disable date navigation and refresh while a load/import is running to
 * prevent duplicate requests.
 */
function updateToolbar(state: WindowState) {
  if (!isWindowAlive(state.win)) {
    return;
  }
  const { dateInput, prevBtn, nextBtn, refreshBtn } = ui(state);
  const disabled = state.loading || state.importing;
  dateInput.disabled = disabled;
  prevBtn.disabled = disabled;
  nextBtn.disabled = disabled;
  refreshBtn.disabled = disabled;
}

function visiblePapers(state: WindowState): HFPaper[] {
  const filter = state.filter;
  if (!filter) {
    return state.papers;
  }
  return state.papers.filter((p) =>
    `${p.title} ${p.authors.join(" ")} ${p.aiKeywords.join(" ")}`
      .toLowerCase()
      .includes(filter),
  );
}

function showMessage(state: WindowState, text: string, withRetry = false) {
  const doc = state.win.document;
  const { list } = ui(state);
  list.replaceChildren();
  const msg = el<HTMLDivElement>(doc, "div", {
    classList: ["hfp-message"],
    text,
  });
  if (withRetry) {
    msg.appendChild(
      el<HTMLButtonElement>(doc, "button", {
        classList: ["retry"],
        text: getString("window-retry"),
        listeners: [
          {
            type: "click",
            listener: () =>
              loadPapers(state, ui(state).dateInput.value || latestListDate()),
          },
        ],
      }),
    );
  }
  list.appendChild(msg);
}

async function loadPapers(state: WindowState, date: string) {
  if (state.loading || state.importing) {
    return;
  }
  state.loading = true;
  updateToolbar(state);
  state.filter = ui(state).filterInput.value.trim().toLowerCase();
  // A fresh list invalidates expansion state and the previous scroll offset.
  state.expandedAbstracts.clear();
  state.listScrollTop = 0;
  showMessage(state, getString("window-loading"));
  try {
    const papers = await fetchDailyPapers(date);
    if (!isWindowAlive(state.win)) {
      return;
    }
    state.papers = papers;
    state.selected.clear();
    // Check which papers are already in the library, to badge and skip them.
    try {
      state.existing = await findExistingItems(papers.map((p) => p.arxivId));
    } catch (e) {
      ztoolkit.log("Existing-item check failed", e);
      state.existing = new Map();
    }
    if (!isWindowAlive(state.win)) {
      return;
    }
    if (papers.length === 0) {
      showMessage(state, getString("window-empty"));
    } else {
      renderList(state);
    }
  } catch (e: any) {
    if (!isWindowAlive(state.win)) {
      return;
    }
    // HTTP errors are shown localized; other messages (which may embed the
    // URL for debugging) are passed through as-is.
    const message =
      e instanceof HFApiError && e.status
        ? getString("error-http", { args: { status: e.status } })
        : e?.message || String(e);
    showMessage(
      state,
      getString("window-load-failed", { args: { message } }),
      true,
    );
  } finally {
    state.loading = false;
    updateToolbar(state);
  }
}

function renderList(state: WindowState) {
  if (!isWindowAlive(state.win)) {
    return;
  }
  const doc = state.win.document;
  const { list } = ui(state);
  // Remember the scroll offset so the rebuild (e.g. when the filter
  // changes) does not jump the list back to the top.
  state.listScrollTop = list.scrollTop;
  list.replaceChildren();
  const hotThreshold = getPref("hotThreshold");

  for (const paper of visiblePapers(state)) {
    const inLib = state.existing.has(paper.arxivId);
    const card = el<HTMLDivElement>(doc, "div", {
      classList: ["paper-card"],
    });
    if (paper.upvotes >= hotThreshold) {
      card.classList.add("hot");
    }
    if (state.selected.has(paper.arxivId)) {
      card.classList.add("selected");
    }

    const rowMain = el<HTMLDivElement>(doc, "div", {
      classList: ["hfp-row-main"],
    });
    const check = el<HTMLInputElement>(doc, "input", {
      attrs: { type: "checkbox" },
    });
    check.checked = state.selected.has(paper.arxivId);
    if (inLib) {
      check.disabled = true;
    } else if (!state.importing) {
      check.addEventListener("change", () => {
        if (check.checked) {
          state.selected.add(paper.arxivId);
        } else {
          state.selected.delete(paper.arxivId);
        }
        card.classList.toggle("selected", check.checked);
        updateFooter(state);
      });
    } else {
      check.disabled = true;
    }

    const title = el<HTMLSpanElement>(doc, "span", {
      classList: ["hfp-title"],
      text: paper.title,
      listeners: [
        {
          type: "click",
          listener: () => Zotero.launchURL(paper.paperUrl),
        },
      ],
    });

    const badges = el<HTMLDivElement>(doc, "div", {
      classList: ["hfp-badges"],
    });
    badges.appendChild(
      el<HTMLSpanElement>(doc, "span", {
        classList: ["hfp-badge", "hfp-upvotes"],
        text: `▲ ${formatCount(paper.upvotes)}`,
      }),
    );
    if (inLib) {
      badges.appendChild(
        el<HTMLSpanElement>(doc, "span", {
          classList: ["hfp-badge", "in-lib"],
          text: getString("window-in-library"),
        }),
      );
    }
    rowMain.append(check, title, badges);

    const authors = el<HTMLDivElement>(doc, "div", {
      classList: ["hfp-authors"],
      text: formatAuthors(paper),
    });

    // Authors on the left, small resource link buttons on the right.
    const meta = el<HTMLDivElement>(doc, "div", { classList: ["hfp-meta"] });
    meta.append(authors, buildPaperLinks(state, paper));

    card.append(rowMain, meta);

    if (paper.aiKeywords.length > 0) {
      const keywords = el<HTMLDivElement>(doc, "div", {
        classList: ["hfp-keywords"],
      });
      for (const kw of paper.aiKeywords.slice(0, 6)) {
        keywords.appendChild(
          el<HTMLSpanElement>(doc, "span", {
            classList: ["hfp-chip"],
            text: kw,
          }),
        );
      }
      card.appendChild(keywords);
    }

    if (paper.abstract) {
      // Restore the expansion state recorded in WindowState.
      const expanded = state.expandedAbstracts.has(paper.arxivId);
      const abstract = el<HTMLDivElement>(doc, "div", {
        classList: ["hfp-abstract"],
        text: paper.abstract,
      });
      abstract.style.display = expanded ? "block" : "none";
      const toggle = el<HTMLButtonElement>(doc, "button", {
        classList: ["hfp-abstract-toggle"],
        attrs: { type: "button" },
        text: expanded
          ? `▴ ${getString("window-abstract")}`
          : `▾ ${getString("window-abstract")}`,
        listeners: [
          {
            type: "click",
            listener: () => {
              const show = abstract.style.display === "none";
              abstract.style.display = show ? "block" : "none";
              toggle.textContent = show
                ? `▴ ${getString("window-abstract")}`
                : `▾ ${getString("window-abstract")}`;
              if (show) {
                state.expandedAbstracts.add(paper.arxivId);
              } else {
                state.expandedAbstracts.delete(paper.arxivId);
              }
            },
          },
        ],
      });
      card.append(toggle, abstract);
    }

    (card as any)._arxivId = paper.arxivId;
    card.setAttribute("data-arxiv-id", paper.arxivId);
    list.appendChild(card);
  }
  // Restore the pre-rebuild scroll offset.
  list.scrollTop = state.listScrollTop;
  updateFooter(state);
}

/**
 * Small link buttons for the paper's arXiv abs page, GitHub repo and
 * project page (whichever exist). Clicks open via Zotero.launchURL.
 */
function buildPaperLinks(state: WindowState, paper: HFPaper): HTMLDivElement {
  const doc = state.win.document;
  const links = el<HTMLDivElement>(doc, "div", { classList: ["hfp-links"] });
  const addLink = (label: string, url: string) => {
    links.appendChild(
      el<HTMLButtonElement>(doc, "button", {
        classList: ["hfp-link"],
        attrs: { type: "button", title: url },
        text: label,
        listeners: [{ type: "click", listener: () => Zotero.launchURL(url) }],
      }),
    );
  };
  addLink(
    getString("window-link-arxiv"),
    `https://arxiv.org/abs/${paper.arxivId}`,
  );
  if (paper.githubRepo) {
    addLink(getString("window-link-github"), githubRepoUrl(paper.githubRepo));
  }
  if (paper.projectPage) {
    addLink(getString("window-link-project"), paper.projectPage);
  }
  return links;
}

/** The API usually returns full URLs, but fall back to owner/repo slugs. */
function githubRepoUrl(repo: string): string {
  return /^https?:\/\//i.test(repo) ? repo : `https://github.com/${repo}`;
}

function formatAuthors(paper: HFPaper): string {
  const authors = paper.authors;
  if (authors.length === 0) {
    return "";
  }
  const shown = authors.slice(0, 5).join(", ");
  return authors.length > 5
    ? `${shown} ${getString("window-authors-et-al")}`
    : shown;
}

/** Locale-aware upvote count, e.g. "1,234". */
function formatCount(n: number): string {
  try {
    return new Intl.NumberFormat(Zotero.locale).format(n);
  } catch {
    return String(n);
  }
}

function updateFooter(state: WindowState) {
  if (!isWindowAlive(state.win)) {
    return;
  }
  const { countLabel, importBtn } = ui(state);
  const importable = state.papers.filter(
    (p) => !state.existing.has(p.arxivId),
  ).length;
  const selected = state.selected.size;
  countLabel.textContent = getString("window-selected-count", {
    args: { selected, total: state.papers.length },
  });
  importBtn.disabled = state.importing || selected === 0;
  importBtn.textContent = state.importing
    ? getString("window-importing")
    : selected > 0
      ? getString("window-import-selected")
      : getString("window-import-none");
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function runImport(state: WindowState) {
  if (state.importing || state.selected.size === 0) {
    return;
  }
  const papers = state.papers.filter((p) => state.selected.has(p.arxivId));
  state.importing = true;
  state.selected.clear();
  updateToolbar(state);
  renderList(state);

  // Mark cards as importing for visual feedback.
  const { list } = ui(state);
  list.querySelectorAll(".paper-card").forEach((node: Element) => {
    node.classList.add("importing");
    const check = node.querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement | null;
    if (check) {
      check.disabled = true;
    }
  });

  try {
    const results = await importPapers(papers, {
      downloadPdf: ui(state).pdfBox.checked,
      onItemDone: (result) => {
        if (!isWindowAlive(state.win)) {
          return;
        }
        if (result.status !== "failed" && result.itemID) {
          state.existing.set(result.arxivId, result.itemID);
        }
        const card = ui(state).list.querySelector(
          `.paper-card[data-arxiv-id="${result.arxivId}"]`,
        );
        if (card) {
          card.classList.remove("importing");
          if (result.status === "failed") {
            card.appendChild(
              el(state.win.document, "span", {
                classList: ["hfp-badge", "status-failed"],
                text: getString("window-import-failed"),
              }),
            );
          }
        }
      },
      onProgress: (done, total) => {
        if (!isWindowAlive(state.win)) {
          return;
        }
        ui(state).countLabel.textContent = getString("import-progress", {
          args: { done, total },
        });
      },
    });
    if (!isWindowAlive(state.win)) {
      return;
    }
    const summary = summarizeResults(results);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("import-done", {
          args: {
            created: summary.created,
            exists: summary.exists,
            failed: summary.failed,
          },
        }),
        type: summary.failed > 0 ? "warning" : "success",
        progress: 100,
      })
      .show();
  } finally {
    state.importing = false;
    if (isWindowAlive(state.win)) {
      updateToolbar(state);
      // Selection was already cleared; this restores button states too.
      renderList(state);
    }
  }
}
