import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_DB_PATH = "/tmp/lifecards-collection-test.sqlite";
process.env.LIFECARDS_TAXONOMY_DB = "/tmp/lifecards-collection-no-taxonomy.sqlite";

const database = await import("../src/database.mjs");

function deterministicRng() {
  return {
    float: () => 0.01,
    int: () => 1,
  };
}

function config() {
  return {
    packIntervalMs: 8 * 60 * 1000,
    maxStoredPacks: 8,
    cardsPerPack: 6,
    holoRate: 0,
    lucaDenominator: 1_000_000_000,
  };
}

test("state returns only recent cards while collection summary remains complete", () => {
  database.resetForTests();
  database.ensureUser("collector", "Collector");

  for (let i = 0; i < 3; i += 1) {
    database.db.prepare("UPDATE users SET pack_balance = 1 WHERE id = ?").run("collector");
    database.claimPack("collector", config(), deterministicRng());
  }

  const state = database.getState("collector", config());
  assert.equal(state.collectionSummary.totalCards, 18);
  assert.ok(state.inventory.length <= 12);
});

test("collection discoveries are grouped and paginated server-side", () => {
  const page = database.listCollectionPage("collector", {
    mode: "DISCOVERIES",
    limit: 2,
    offset: 0,
  });

  assert.equal(page.mode, "DISCOVERIES");
  assert.ok(page.items.length <= 2);
  assert.ok(page.total >= 1);
  assert.equal(page.summary.totalCards, 18);
  assert.ok(page.items.every((item) => item.copies >= 1));
});

test("individual copy lists load independently from collection groups", () => {
  const page = database.listCollectionPage("collector", {
    mode: "DISCOVERIES",
    limit: 10,
  });
  const first = page.items[0];
  const copies = database.listDefinitionCopies("collector", first.definitionId, 250);

  assert.equal(copies.length, first.copies);
  assert.ok(copies.every((card) => card.definitionId === first.definitionId));
});

test("visible tree ownership lookup returns only requested scientific names", () => {
  const page = database.listCollectionPage("collector", {
    mode: "DISCOVERIES",
    limit: 10,
  });
  const ownedName = page.items[0].card.definition.scientificName;
  const result = database.ownedScientificNames("collector", [ownedName, "Definitely not owned"]);

  assert.deepEqual(result, [ownedName]);
});
