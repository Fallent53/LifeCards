import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_DB_PATH = "/tmp/lifecards-science-test.sqlite";

const {
  lifemapUrl,
  ncbiTaxonomyUrl,
  parseWikipediaPage,
  parseNcbiSummary,
} = await import("../src/science.mjs");

test("Lifemap deep links use the NCBI taxonomy id", () => {
  assert.equal(
    lifemapUrl(9689),
    "https://lifemap.cnrs.fr/tree?tool=search&efficiency-mode=false&tid=9689"
  );
  assert.equal(
    ncbiTaxonomyUrl(9689),
    "https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=9689"
  );
});

test("Wikipedia page payload is normalized without HTML", () => {
  const page = parseWikipediaPage({
    title: "Panthera leo",
    extract: "The lion is a large cat.",
    canonicalurl: "https://en.wikipedia.org/wiki/Lion",
    thumbnail: { source: "https://upload.wikimedia.org/thumb.jpg" },
    original: { source: "https://upload.wikimedia.org/original.jpg" },
    pageprops: { wikibase_item: "Q140" },
  }, "en");

  assert.deepEqual(page, {
    language: "en",
    title: "Panthera leo",
    extract: "The lion is a large cat.",
    pageUrl: "https://en.wikipedia.org/wiki/Lion",
    thumbnailUrl: "https://upload.wikimedia.org/thumb.jpg",
    originalImageUrl: "https://upload.wikimedia.org/original.jpg",
    wikibaseItem: "Q140",
  });
});

test("NCBI taxonomy summary is normalized", () => {
  const result = parseNcbiSummary({
    result: {
      "9689": {
        scientificname: "Panthera leo",
        commonname: "lion",
        rank: "species",
        division: "Mammals",
        status: "active",
      },
    },
  }, 9689);

  assert.equal(result.taxId, "9689");
  assert.equal(result.scientificName, "Panthera leo");
  assert.equal(result.rank, "species");
});
