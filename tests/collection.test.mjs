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
  assert.equal("market" in state, false);
  assert.equal("supplies" in state, false);
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


test("market listings are paginated outside global state", () => {
  const page = database.listCollectionPage("collector", {
    mode: "CARDS",
    limit: 1,
  });
  const card = page.items[0];
  const listing = database.createListing("collector", card.id, 1234);

  assert.equal(listing.price, 1234);

  const market = database.listMarketPage({
    filter: "ALL",
    limit: 1,
    offset: 0,
  });
  assert.equal(market.items.length, 1);
  assert.ok(market.total >= 1);
  assert.equal(market.items[0].id, listing.id);
});

test("edition supply is fetched per definition instead of through global state", () => {
  const page = database.listCollectionPage("collector", {
    mode: "CARDS",
    limit: 1,
  });
  const definitionId = page.items[0].definitionId;
  const supplies = database.getDefinitionSupplies(definitionId);

  assert.ok(Array.isArray(supplies));
  assert.ok(supplies.length >= 1);
  assert.ok(supplies.every((entry) => entry.definitionId === definitionId));
});


test("cancelled cards can be relisted without losing listing history", () => {
  database.resetForTests();
  database.ensureUser("relist-user", "Relist User");
  database.db.prepare("UPDATE users SET pack_balance = 1 WHERE id = ?").run("relist-user");
  database.claimPack("relist-user", config(), deterministicRng());

  const card = database.listCollectionPage("relist-user", { mode: "CARDS", limit: 1 }).items[0];
  const first = database.createListing("relist-user", card.id, 900);
  database.cancelListing("relist-user", first.id);
  const second = database.createListing("relist-user", card.id, 1100);

  assert.notEqual(second.id, first.id);
  const history = database.db.prepare(
    "SELECT status, price FROM listings WHERE card_id = ? ORDER BY created_at, price"
  ).all(card.id);
  assert.equal(history.length, 2);
  assert.ok(history.some((row) => row.status === "CANCELLED" && Number(row.price) === 900));
  assert.ok(history.some((row) => row.status === "ACTIVE" && Number(row.price) === 1100));
});


test("personal market scopes isolate listings and history", () => {
  database.resetForTests();
  for (const id of ["seller-a", "seller-b", "buyer-a"]) {
    database.ensureUser(id, id);
    database.db.prepare("UPDATE users SET pack_balance = 1, coins = 50000 WHERE id = ?").run(id);
    database.claimPack(id, config(), deterministicRng());
  }

  const aCard = database.listCollectionPage("seller-a", { mode: "CARDS", limit: 1 }).items[0];
  const bCard = database.listCollectionPage("seller-b", { mode: "CARDS", limit: 1 }).items[0];
  const aListing = database.createListing("seller-a", aCard.id, 1000);
  database.createListing("seller-b", bCard.id, 2000);

  const mine = database.listMarketPage({
    viewerId: "seller-a",
    scope: "MINE",
    limit: 20,
  });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].sellerId, "seller-a");

  database.buyListing("buyer-a", aListing.id);

  const sellerHistory = database.listMarketPage({
    viewerId: "seller-a",
    scope: "HISTORY",
    limit: 20,
  });
  assert.equal(sellerHistory.items.length, 1);
  assert.equal(sellerHistory.items[0].status, "SOLD");
  assert.equal(sellerHistory.items[0].buyerId, "buyer-a");

  const otherHistory = database.listMarketPage({
    viewerId: "seller-b",
    scope: "HISTORY",
    limit: 20,
  });
  assert.equal(otherHistory.items.length, 0);
});

test("card provenance follows recognized market transfers", () => {
  database.resetForTests();
  for (const id of ["origin-owner", "keeper-two"]) {
    database.ensureUser(id, id);
    database.db.prepare("UPDATE users SET pack_balance = 1, coins = 50000 WHERE id = ?").run(id);
  }
  database.claimPack("origin-owner", config(), deterministicRng());

  const card = database.listCollectionPage("origin-owner", { mode: "CARDS", limit: 1 }).items[0];
  const listing = database.createListing("origin-owner", card.id, 4321);
  database.buyListing("keeper-two", listing.id);

  const provenance = database.getCardProvenance(card.id);
  assert.equal(provenance.currentOwnerId, "keeper-two");
  assert.equal(provenance.transferCount, 1);
  assert.equal(provenance.events[0].type, "ISSUED");
  assert.equal(provenance.events[0].ownerId, "origin-owner");
  assert.equal(provenance.events[1].type, "SOLD");
  assert.equal(provenance.events[1].sellerId, "origin-owner");
  assert.equal(provenance.events[1].buyerId, "keeper-two");
  assert.equal(provenance.events[1].price, 4321);
});
