import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { byId, publicCatalog } from "./catalog.mjs";
import { DEFAULT_CONFIG, generatePackBlueprint, packsAccrued, cryptoRng } from "./game-engine.mjs";

const dbPath = resolve(process.env.LIFECARDS_DB_PATH ?? "./data/lifecards.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

function nowMs() { return Date.now(); }
function uuid() { return crypto.randomUUID(); }

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      coins INTEGER NOT NULL DEFAULT 10000,
      pack_balance INTEGER NOT NULL DEFAULT 1,
      pack_anchor_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplies (
      definition_id TEXT NOT NULL,
      edition_key TEXT NOT NULL,
      issued_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (definition_id, edition_key)
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      edition_key TEXT NOT NULL,
      serial_number INTEGER NOT NULL,
      serial_cap INTEGER,
      finish TEXT NOT NULL,
      rarity TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(definition_id, edition_key, serial_number),
      FOREIGN KEY(owner_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS cards_owner_idx ON cards(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE,
      seller_id TEXT NOT NULL,
      price INTEGER NOT NULL CHECK(price > 0),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      buyer_id TEXT,
      created_at INTEGER NOT NULL,
      sold_at INTEGER,
      FOREIGN KEY(card_id) REFERENCES cards(id),
      FOREIGN KEY(seller_id) REFERENCES users(id),
      FOREIGN KEY(buyer_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS listings_status_idx ON listings(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS external_cache (
      provider TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (provider, cache_key)
    );
    CREATE INDEX IF NOT EXISTS external_cache_expiry_idx ON external_cache(expires_at);
  `);
}

export function ensureUser(id = "explorer", displayName = "Explorer") {
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) {
    const now = nowMs();
    db.prepare(`INSERT INTO users (id, display_name, coins, pack_balance, pack_anchor_at, created_at)
                VALUES (?, ?, 10000, 1, ?, ?)`).run(id, displayName, now, now);
  }
  return readUser(id);
}

function readUser(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function syncAccrual(userId, config = DEFAULT_CONFIG) {
  const user = ensureUser(userId);
  const now = nowMs();
  const accrued = packsAccrued({ now, anchorAt: user.pack_anchor_at, balance: user.pack_balance, config });
  if (accrued.balance !== user.pack_balance || accrued.anchorAt !== user.pack_anchor_at) {
    db.prepare("UPDATE users SET pack_balance = ?, pack_anchor_at = ? WHERE id = ?")
      .run(accrued.balance, accrued.anchorAt, userId);
  }
  return { ...readUser(userId), now };
}

function supplyCount(definitionId, editionKey) {
  return Number(db.prepare("SELECT issued_count FROM supplies WHERE definition_id = ? AND edition_key = ?")
    .get(definitionId, editionKey)?.issued_count ?? 0);
}

function chooseEdition(definition) {
  if (definition.kind === "origin") return { key: "ORIGIN", cap: 1 };
  if (definition.kind === "taxon") {
    const cap = Number(definition.editionCap ?? 0);
    if (cap > 0 && supplyCount(definition.id, "FOUNDATION I") < cap) return { key: "FOUNDATION I", cap };
    return { key: "ARCHIVE TAXON", cap: null };
  }
  if (definition.temporalStatus === "extinct") {
    const cap = Number(definition.editionCap ?? 0);
    if (cap > 0 && supplyCount(definition.id, "FOSSIL RECORD I") < cap) return { key: "FOSSIL RECORD I", cap };
    return { key: "PALEO ARCHIVE", cap: null };
  }
  const cap = Number(definition.editionCap ?? 0);
  if (cap > 0 && supplyCount(definition.id, "WILD CENSUS I") < cap) return { key: "WILD CENSUS I", cap };
  return { key: "RESEARCH", cap: null };
}

function allocateSerial(definition, edition) {
  db.prepare(`INSERT INTO supplies (definition_id, edition_key, issued_count)
              VALUES (?, ?, 0)
              ON CONFLICT(definition_id, edition_key) DO NOTHING`).run(definition.id, edition.key);
  const current = supplyCount(definition.id, edition.key);
  if (edition.cap && current >= edition.cap) throw new Error("Edition exhausted");
  const serial = current + 1;
  db.prepare("UPDATE supplies SET issued_count = ? WHERE definition_id = ? AND edition_key = ?")
    .run(serial, definition.id, edition.key);
  return serial;
}

function issueDefinition(ownerId, definition, finish) {
  const edition = chooseEdition(definition);
  const serial = allocateSerial(definition, edition);
  const id = uuid();
  db.prepare(`INSERT INTO cards
    (id, definition_id, owner_id, edition_key, serial_number, serial_cap, finish, rarity, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, definition.id, ownerId, edition.key, serial, edition.cap, finish, definition.rarity, definition.kind, nowMs());
  return hydrateCard(db.prepare("SELECT * FROM cards WHERE id = ?").get(id));
}

function issueLuca(ownerId) {
  const definition = byId.get("luca");
  if (supplyCount("luca", "ORIGIN") >= 1) return null;
  return issueDefinition(ownerId, definition, "ORIGIN");
}

function hydrateCard(row) {
  if (!row) return null;
  const definition = byId.get(row.definition_id);
  return {
    id: row.id,
    ownerId: row.owner_id,
    definitionId: row.definition_id,
    edition: row.edition_key,
    serial: Number(row.serial_number),
    serialCap: row.serial_cap == null ? null : Number(row.serial_cap),
    finish: row.finish,
    rarity: row.rarity,
    kind: row.kind,
    createdAt: Number(row.created_at),
    definition,
  };
}

export function claimPack(userId = "explorer", config = DEFAULT_CONFIG, rng = cryptoRng()) {
  migrate();
  ensureUser(userId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const user = syncAccrual(userId, config);
    if (user.pack_balance < 1) throw new Error("No pack available yet");
    const wasFull = user.pack_balance >= config.maxStoredPacks;
    const nextBalance = user.pack_balance - 1;
    const anchor = wasFull ? nowMs() : user.pack_anchor_at;
    db.prepare("UPDATE users SET pack_balance = ?, pack_anchor_at = ? WHERE id = ?")
      .run(nextBalance, anchor, userId);

    const blueprint = generatePackBlueprint({ rng, config });
    const cards = blueprint.cards.map((slot) => issueDefinition(userId, byId.get(slot.definitionId), slot.finish));
    const originCard = blueprint.originTriggered ? issueLuca(userId) : null;
    db.exec("COMMIT");
    return { cards, originCard };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listInventory(userId = "explorer") {
  migrate(); ensureUser(userId);
  return db.prepare("SELECT * FROM cards WHERE owner_id = ? ORDER BY created_at DESC")
    .all(userId).map(hydrateCard);
}

export function listMarket() {
  migrate();
  return db.prepare(`SELECT l.*, c.definition_id, c.edition_key, c.serial_number, c.serial_cap, c.finish, c.rarity, c.kind
    FROM listings l JOIN cards c ON c.id = l.card_id
    WHERE l.status = 'ACTIVE' ORDER BY l.created_at DESC`).all().map((row) => ({
      id: row.id,
      price: Number(row.price),
      sellerId: row.seller_id,
      createdAt: Number(row.created_at),
      card: hydrateCard({
        id: row.card_id,
        owner_id: row.seller_id,
        definition_id: row.definition_id,
        edition_key: row.edition_key,
        serial_number: row.serial_number,
        serial_cap: row.serial_cap,
        finish: row.finish,
        rarity: row.rarity,
        kind: row.kind,
        created_at: row.created_at,
      }),
    }));
}

export function createListing(userId, cardId, price) {
  migrate(); ensureUser(userId);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Price must be a positive integer");
  const card = db.prepare("SELECT * FROM cards WHERE id = ? AND owner_id = ?").get(cardId, userId);
  if (!card) throw new Error("Card not owned by seller");
  const id = uuid();
  db.prepare("INSERT INTO listings (id, card_id, seller_id, price, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)")
    .run(id, cardId, userId, price, nowMs());
  return listMarket().find((listing) => listing.id === id);
}

export function buyListing(userId, listingId) {
  migrate(); ensureUser(userId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const listing = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'ACTIVE'").get(listingId);
    if (!listing) throw new Error("Listing unavailable");
    if (listing.seller_id === userId) throw new Error("You cannot buy your own listing");
    const buyer = readUser(userId);
    if (buyer.coins < listing.price) throw new Error("Not enough coins");
    const fee = Math.floor(Number(listing.price) * 0.05);
    const proceeds = Number(listing.price) - fee;
    db.prepare("UPDATE users SET coins = coins - ? WHERE id = ?").run(listing.price, userId);
    db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(proceeds, listing.seller_id);
    db.prepare("UPDATE cards SET owner_id = ? WHERE id = ?").run(userId, listing.card_id);
    db.prepare("UPDATE listings SET status = 'SOLD', buyer_id = ?, sold_at = ? WHERE id = ?")
      .run(userId, nowMs(), listingId);
    db.exec("COMMIT");
    return { card: hydrateCard(db.prepare("SELECT * FROM cards WHERE id = ?").get(listing.card_id)), fee };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getState(userId = "explorer", config = DEFAULT_CONFIG) {
  migrate();
  const user = syncAccrual(userId, config);
  const inventory = listInventory(userId);
  const nextPackInMs = user.pack_balance >= config.maxStoredPacks ? 0 : Math.max(0, config.packIntervalMs - (user.now - user.pack_anchor_at));
  return {
    user: { id: user.id, displayName: user.display_name, coins: Number(user.coins), packs: Number(user.pack_balance), maxPacks: config.maxStoredPacks, nextPackInMs },
    inventory,
    market: listMarket(),
    catalog: publicCatalog(),
    config: { packIntervalMs: config.packIntervalMs, cardsPerPack: config.cardsPerPack, maxStoredPacks: config.maxStoredPacks, holoRate: config.holoRate, lucaRarityLabel: "UNKNOWN" },
  };
}

export function seedDemoMarket() {
  migrate();
  ensureUser("museum-bot", "Natural History Exchange");
  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM listings").get().c);
  if (count > 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [definitionId, finish, price] of [
      ["columba-livia", "HOLO", 1450],
      ["felidae", "STANDARD", 3200],
      ["tyrannosaurus-rex", "STANDARD", 12500],
    ]) {
      const card = issueDefinition("museum-bot", byId.get(definitionId), finish);
      db.prepare("INSERT INTO listings (id, card_id, seller_id, price, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)")
        .run(uuid(), card.id, "museum-bot", price, nowMs());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getExternalCache(provider, cacheKey) {
  migrate();
  const row = db.prepare(
    "SELECT payload, fetched_at, expires_at FROM external_cache WHERE provider = ? AND cache_key = ?"
  ).get(provider, cacheKey);
  if (!row) return null;

  if (Number(row.expires_at) <= nowMs()) {
    db.prepare("DELETE FROM external_cache WHERE provider = ? AND cache_key = ?").run(provider, cacheKey);
    return null;
  }

  try {
    return {
      value: JSON.parse(row.payload),
      fetchedAt: Number(row.fetched_at),
      expiresAt: Number(row.expires_at),
    };
  } catch {
    db.prepare("DELETE FROM external_cache WHERE provider = ? AND cache_key = ?").run(provider, cacheKey);
    return null;
  }
}

export function setExternalCache(provider, cacheKey, value, ttlMs) {
  migrate();
  const fetchedAt = nowMs();
  const expiresAt = fetchedAt + Math.max(1_000, Number(ttlMs) || 0);
  db.prepare(`
    INSERT INTO external_cache (provider, cache_key, payload, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, cache_key) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(provider, cacheKey, JSON.stringify(value), fetchedAt, expiresAt);
  return value;
}

export function purgeExpiredExternalCache() {
  migrate();
  return db.prepare("DELETE FROM external_cache WHERE expires_at <= ?").run(nowMs());
}

export function resetForTests() {
  db.exec("DELETE FROM listings; DELETE FROM cards; DELETE FROM supplies; DELETE FROM users;");
}

migrate();
seedDemoMarket();
