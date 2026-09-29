import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_DB_PATH = "/tmp/lifecards-market-test.sqlite";

const market = await import("../src/database.mjs");

function packRng() {
  return {
    float: () => 0.2,
    int: (max) => max > 1 ? 1 : 0,
  };
}

const config = {
  packIntervalMs: 8 * 60 * 1000,
  maxStoredPacks: 8,
  cardsPerPack: 6,
  holoRate: 0.075,
  lucaDenominator: 1_000_000_000,
};

test("a sold card can be listed again by its new owner", () => {
  market.resetForTests();
  market.ensureUser("seller", "Seller");
  market.ensureUser("buyer", "Buyer");

  const pack = market.claimPack("seller", config, packRng());
  const card = pack.cards[0];

  const first = market.createListing("seller", card.id, 100);
  market.buyListing("buyer", first.id);

  const second = market.createListing("buyer", card.id, 120);
  assert.equal(second.card.ownerId, "buyer");
  assert.equal(second.price, 120);
});

test("auction reserves bid, settles ownership and pays seller", () => {
  market.ensureUser("bidder", "Bidder");
  market.ensureUser("auctioneer", "Auctioneer");
  const pack = market.claimPack("auctioneer", config, packRng());
  const card = pack.cards[0];

  const beforeBidder = market.db.prepare("SELECT coins FROM users WHERE id = ?").get("bidder").coins;
  const beforeSeller = market.db.prepare("SELECT coins FROM users WHERE id = ?").get("auctioneer").coins;

  const auction = market.createAuction("auctioneer", card.id, 500, 60);
  market.placeAuctionBid("bidder", auction.id, 700);

  const afterBid = market.db.prepare("SELECT coins FROM users WHERE id = ?").get("bidder").coins;
  assert.equal(Number(afterBid), Number(beforeBidder) - 700);

  market.db.prepare("UPDATE auctions SET ends_at = ? WHERE id = ?").run(Date.now() - 1, auction.id);
  const settled = market.settleAuction(auction.id);

  assert.equal(settled.status, "SOLD");
  const owned = market.db.prepare("SELECT owner_id FROM cards WHERE id = ?").get(card.id);
  assert.equal(owned.owner_id, "bidder");

  const afterSeller = market.db.prepare("SELECT coins FROM users WHERE id = ?").get("auctioneer").coins;
  assert.equal(Number(afterSeller), Number(beforeSeller) + 665);
});
