import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_TAXONOMY_DB = "/tmp/lifecards-missing-taxonomy.sqlite";

const {
  taxonomyStatus,
  searchTaxa,
  getTaxon,
  getPath,
  getSubtree,
} = await import("../src/taxonomy-store.mjs");

test("taxonomy store falls back to seed data when the full DB is absent", () => {
  const status = taxonomyStatus();
  assert.equal(status.ready, false);
  assert.equal(status.mode, "seed");
  assert.equal(status.rootId, "animalia");
});

test("seed taxonomy search finds common and scientific names", () => {
  const lion = searchTaxa("lion", 10);
  assert.ok(lion.some((item) => item.scientificName === "Panthera leo"));

  const panthera = searchTaxa("Panthera", 10);
  assert.ok(panthera.some((item) => item.scientificName === "Panthera"));
});

test("seed path preserves ancestry", () => {
  const path = getPath("panthera-leo");
  assert.ok(path.length >= 3);
  assert.equal(path.at(-1).scientificName, "Panthera leo");
  assert.ok(path.some((item) => item.scientificName === "Animalia"));
});

test("subtree returns a bounded radial payload", () => {
  const payload = getSubtree("animalia", { depth: 4, childLimit: 20, nodeLimit: 100 });
  assert.equal(payload.root.scientificName, "Animalia");
  assert.ok(payload.nodesUsed > 1);
  assert.ok(payload.nodesUsed <= 100);
  assert.ok(Array.isArray(payload.path));
});

test("getTaxon exposes stable card-like taxonomy metadata", () => {
  const taxon = getTaxon("mammalia");
  assert.equal(taxon.scientificName, "Mammalia");
  assert.equal(taxon.kind, "taxon");
  assert.ok(Number.isInteger(taxon.childCount));
});
