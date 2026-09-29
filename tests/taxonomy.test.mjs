import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_TAXONOMY_DB = "/tmp/lifecards-no-taxonomy.sqlite";

const taxonomy = await import("../src/taxonomy-store.mjs");

test("seed taxonomy search finds common and scientific names", () => {
  const common = taxonomy.searchTaxa("Lion", 10);
  assert.ok(common.some((row) => row.scientificName === "Panthera leo"));

  const scientific = taxonomy.searchTaxa("Panthera leo", 10);
  assert.ok(scientific.some((row) => row.commonName === "Lion"));
});

test("seed taxonomy exposes parent-child navigation", () => {
  const children = taxonomy.getChildren("animalia", 20);
  const ids = new Set(children.map((row) => row.id));
  assert.ok(ids.has("mollusca"));
  assert.ok(ids.has("arthropoda"));
  assert.ok(ids.has("chordata"));
});

test("subtree remains bounded and carries a breadcrumb path", () => {
  const subtree = taxonomy.getSubtree("animalia", { depth: 3, childLimit: 20, nodeLimit: 100 });
  assert.equal(subtree.root.id, "animalia");
  assert.ok(subtree.nodesUsed <= 100);
  assert.equal(subtree.path.at(-1)?.id, "animalia");
});
