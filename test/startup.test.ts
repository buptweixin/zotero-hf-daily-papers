import { assert } from "chai";
import { config } from "../package.json";

// Make plugin-sandbox globals (`addon`, `ztoolkit`) resolvable for the
// dynamically imported modules below; tests run in the main window scope,
// where those identifiers are not defined by default.
async function setupGlobals() {
  const plugin = (Zotero as any)[config.addonInstance];
  assert.isDefined(plugin, "plugin instance should exist");
  (window as any).addon = plugin;
  (window as any).ztoolkit = plugin.data.ztoolkit;
}

describe("zotero-hf-daily-papers", function () {
  describe("startup", function () {
    it("should have plugin instance defined", function () {
      assert.isNotEmpty((Zotero as any)[config.addonInstance]);
    });
  });

  describe("hf-api", function () {
    it("should fetch daily papers for a known date", async function () {
      this.timeout(60000);
      await setupGlobals();
      const { fetchDailyPapers } = await import("../src/modules/hf-api");
      // A Tuesday with a known non-empty list.
      const papers = await fetchDailyPapers("2026-08-18");
      assert.isArray(papers);
      assert.isAbove(papers.length, 0);
      const first = papers[0];
      assert.property(first, "arxivId");
      assert.property(first, "title");
      assert.property(first, "abstract");
      // Sorted by upvotes descending
      assert.isTrue(papers[0].upvotes >= papers[papers.length - 1].upvotes);
    });
  });

  describe("importer", function () {
    it("should import a paper as preprint with arXiv-convention metadata", async function () {
      this.timeout(120000);
      await setupGlobals();
      const { fetchDailyPapers } = await import("../src/modules/hf-api");
      const { importPapers } = await import("../src/modules/importer");

      const papers = await fetchDailyPapers("2026-08-18");
      const paper = papers[0];
      const results = await importPapers([paper], { downloadPdf: false });
      assert.lengthOf(results, 1);
      assert.include(["created", "exists"], results[0].status);
      assert.isDefined(results[0].itemID);

      const item = Zotero.Items.get(results[0].itemID!);
      assert.equal(item.itemType, "preprint");
      assert.equal(item.getField("repository"), "arXiv");
      assert.equal(item.getField("archiveID"), `arXiv:${paper.arxivId}`);
      assert.equal(item.getField("DOI"), `10.48550/arXiv.${paper.arxivId}`);
      assert.equal(
        item.getField("url"),
        `https://arxiv.org/abs/${paper.arxivId}`,
      );
      assert.include(item.getField("extra"), `Upvotes: ${paper.upvotes}`);
      const tags = item.getTags().map((t) => t.tag);
      assert.include(tags, "HF Papers");
      // It is filed into the root collection at least.
      assert.isAbove(item.getCollections().length, 0);

      // Importing again must dedupe, not duplicate.
      const again = await importPapers([paper], { downloadPdf: false });
      assert.equal(again[0].status, "exists");
      assert.equal(again[0].itemID, results[0].itemID);

      // Clean up the throwaway item.
      await Zotero.Items.erase(results[0].itemID!);
    });
  });
});
