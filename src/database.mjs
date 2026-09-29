import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { byId, publicCatalog } from "./catalog.mjs";
import { DEFAULT_CONFIG, generatePackBlueprint, packsAccrued, cryptoRng } from "./game-engine.mjs";
import { resolveDefinition, selectImportedDefinition } from "./definitions.mjs";

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
      card_id TEXT NOT NULL,
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
  `);

  const listingSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='listings'").get()?.sql || ""
  );
  if (/card_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(listingSql)) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        ALTER TABLE listings RENAME TO listings_legacy;
        CREATE TABLE listings (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL,
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
        INSERT INTO listings(id,card_id,seller_id,price,status,buyer_id,created_at,sold_at)
        SELECT id,card_id,seller_id,price,status,buyer_id,created_at,sold_at
        FROM listings_legacy;
        DROP TABLE listings_legacy;
        COMMIT;
      `);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS listings_status_idx ON listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS listings_seller_idx ON listings(seller_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS listings_active_card_idx
      ON listings(card_id)
      WHERE status = 'ACTIVE';
  `);

  const cardColumns = new Set(db.prepare("PRAGMA table_info(cards)").all().map((row) => row.name));
  if (!cardColumns.has("definition_json")) {
    db.exec("ALTER TABLE cards ADD COLUMN definition_json TEXT");
  }
  if (!cardColumns.has("common_name")) {
    db.exec("ALTER TABLE cards ADD COLUMN common_name TEXT");
  }
  if (!cardColumns.has("scientific_name")) {
    db.exec("ALTER TABLE cards ADD COLUMN scientific_name TEXT");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS cards_owner_definition_idx ON cards(owner_id, definition_id);
    CREATE INDEX IF NOT EXISTS cards_owner_rarity_idx ON cards(owner_id, rarity);
    CREATE INDEX IF NOT EXISTS cards_owner_kind_idx ON cards(owner_id, kind);
  `);

  const missingNames = db.prepare(
    "SELECT id, definition_id, definition_json FROM cards WHERE common_name IS NULL OR scientific_name IS NULL LIMIT 5000"
  ).all();
  if (missingNames.length) {
    const updateNames = db.prepare("UPDATE cards SET common_name = ?, scientific_name = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const row of missingNames) {
        let definition = null;
        if (row.definition_json) {
          try { definition = JSON.parse(row.definition_json); } catch {}
        }
        definition ||= resolveDefinition(row.definition_id);
        updateNames.run(
          definition?.commonName || row.definition_id,
          definition?.scientificName || row.definition_id,
          row.id
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
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
    (id, definition_id, owner_id, edition_key, serial_number, serial_cap, finish, rarity, kind, created_at, definition_json, common_name, scientific_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      definition.id,
      ownerId,
      edition.key,
      serial,
      edition.cap,
      finish,
      definition.rarity,
      definition.kind,
      nowMs(),
      JSON.stringify(definition),
      definition.commonName || definition.id,
      definition.scientificName || definition.commonName || definition.id
    );
  return hydrateCard(db.prepare("SELECT * FROM cards WHERE id = ?").get(id));
}

function issueLuca(ownerId) {
  const definition = byId.get("luca");
  if (supplyCount("luca", "ORIGIN") >= 1) return null;
  return issueDefinition(ownerId, definition, "ORIGIN");
}

function hydrateCard(row) {
  if (!row) return null;
  let definition = null;
  if (row.definition_json) {
    try { definition = JSON.parse(row.definition_json); } catch {}
  }
  definition ||= resolveDefinition(row.definition_id);
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

    const blueprint = generatePackBlueprint({
      rng,
      config,
      definitionSelector: (rarity, rollRng) => selectImportedDefinition(rarity, rollRng),
    });
    const cards = blueprint.cards.map((slot) => {
      const definition = resolveDefinition(slot.definitionId);
      if (!definition) throw new Error(`Unknown card definition ${slot.definitionId}`);
      return issueDefinition(userId, definition, slot.finish);
    });
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

function collectionWhere(userId, options = {}) {
  const filter = String(options.filter || "ALL");
  const query = String(options.query || "").trim();
  const clauses = ["owner_id = ?"];
  const params = [userId];

  if (filter === "SPECIES") clauses.push("kind = 'species'");
  if (filter === "TAXA") clauses.push("kind = 'taxon'");
  if (filter === "WILD") clauses.push("edition_key = 'WILD CENSUS I'");
  if (filter === "HOLO") clauses.push("finish = 'HOLO'");

  if (query) {
    const like = "%" + query + "%";
    clauses.push("(common_name LIKE ? COLLATE NOCASE OR scientific_name LIKE ? COLLATE NOCASE OR rarity LIKE ? COLLATE NOCASE OR edition_key LIKE ? COLLATE NOCASE)");
    params.push(like, like, like, like);
  }

  return { sql: clauses.join(" AND "), params };
}

function collectionOrder(sort = "RARITY") {
  if (sort === "NAME") return "common_name COLLATE NOCASE ASC, scientific_name COLLATE NOCASE ASC";
  if (sort === "NEWEST") return "created_at DESC";
  return "CASE rarity " +
    "WHEN 'UNKNOWN' THEN 0 WHEN 'MYTHIC' THEN 1 WHEN 'LEGENDARY' THEN 2 " +
    "WHEN 'ULTRA_RARE' THEN 3 WHEN 'SUPER_RARE' THEN 4 WHEN 'RARE' THEN 5 " +
    "WHEN 'UNCOMMON' THEN 6 WHEN 'COMMON' THEN 7 ELSE 99 END ASC, " +
    "common_name COLLATE NOCASE ASC";
}

export function getCollectionSummary(userId = "explorer") {
  migrate(); ensureUser(userId);
  const row = db.prepare(
    "SELECT COUNT(*) AS total_cards, " +
    "COUNT(DISTINCT definition_id) AS unique_discoveries, " +
    "SUM(CASE WHEN finish = 'HOLO' THEN 1 ELSE 0 END) AS holo_cards, " +
    "SUM(CASE WHEN edition_key = 'WILD CENSUS I' THEN 1 ELSE 0 END) AS wild_cards " +
    "FROM cards WHERE owner_id = ?"
  ).get(userId);
  return {
    totalCards: Number(row?.total_cards || 0),
    uniqueDiscoveries: Number(row?.unique_discoveries || 0),
    holoCards: Number(row?.holo_cards || 0),
    wildCards: Number(row?.wild_cards || 0),
  };
}

export function listCollectionPage(userId = "explorer", options = {}) {
  migrate(); ensureUser(userId);
  const mode = String(options.mode || "DISCOVERIES").toUpperCase();
  const filter = String(options.filter || "ALL").toUpperCase();
  const query = String(options.query || "");
  const sort = String(options.sort || "RARITY").toUpperCase();
  const limit = Math.max(1, Math.min(60, Number(options.limit) || 36));
  const offset = Math.max(0, Number(options.offset) || 0);
  const where = collectionWhere(userId, { filter, query });

  if (mode === "CARDS") {
    const total = Number(
      db.prepare("SELECT COUNT(*) AS c FROM cards WHERE " + where.sql)
        .get(...where.params)?.c || 0
    );
    const rows = db.prepare(
      "SELECT * FROM cards WHERE " + where.sql +
      " ORDER BY " + collectionOrder(sort) +
      " LIMIT ? OFFSET ?"
    ).all(...where.params, limit, offset);

    return {
      mode: "CARDS",
      items: rows.map(hydrateCard),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      summary: getCollectionSummary(userId),
    };
  }

  const total = Number(
    db.prepare("SELECT COUNT(DISTINCT definition_id) AS c FROM cards WHERE " + where.sql)
      .get(...where.params)?.c || 0
  );

  const groupOrder = sort === "NEWEST"
    ? "newest_card DESC"
    : sort === "NAME"
      ? "common_name COLLATE NOCASE ASC, scientific_name COLLATE NOCASE ASC"
      : collectionOrder("RARITY");

  const sql =
    "WITH filtered AS (" +
      "SELECT * FROM cards WHERE " + where.sql +
    "), ranked AS (" +
      "SELECT filtered.*, " +
      "ROW_NUMBER() OVER (PARTITION BY definition_id ORDER BY " +
        "CASE WHEN finish = 'HOLO' THEN 0 ELSE 1 END, " +
        "CASE WHEN edition_key IN ('WILD CENSUS I','FOUNDATION I','FOSSIL RECORD I') THEN 0 ELSE 1 END, " +
        "serial_number ASC) AS representative_rank, " +
      "COUNT(*) OVER (PARTITION BY definition_id) AS copy_count, " +
      "SUM(CASE WHEN finish = 'HOLO' THEN 1 ELSE 0 END) OVER (PARTITION BY definition_id) AS holo_count, " +
      "SUM(CASE WHEN edition_key = 'WILD CENSUS I' THEN 1 ELSE 0 END) OVER (PARTITION BY definition_id) AS wild_count, " +
      "MIN(serial_number) OVER (PARTITION BY definition_id) AS lowest_serial, " +
      "MAX(created_at) OVER (PARTITION BY definition_id) AS newest_card " +
      "FROM filtered" +
    ") " +
    "SELECT * FROM ranked WHERE representative_rank = 1 " +
    "ORDER BY " + groupOrder + " LIMIT ? OFFSET ?";

  const rows = db.prepare(sql).all(...where.params, limit, offset);
  return {
    mode: "DISCOVERIES",
    items: rows.map((row) => ({
      definitionId: row.definition_id,
      copies: Number(row.copy_count || 0),
      holoCount: Number(row.holo_count || 0),
      wildCount: Number(row.wild_count || 0),
      lowestSerial: Number(row.lowest_serial || 0),
      newest: Number(row.newest_card || 0),
      card: hydrateCard(row),
    })),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    summary: getCollectionSummary(userId),
  };
}

export function listDefinitionCopies(userId = "explorer", definitionId, limit = 100) {
  migrate(); ensureUser(userId);
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  return db.prepare(
    "SELECT * FROM cards WHERE owner_id = ? AND definition_id = ? " +
    "ORDER BY CASE WHEN finish = 'HOLO' THEN 0 ELSE 1 END, " +
    "CASE WHEN edition_key IN ('WILD CENSUS I','FOUNDATION I','FOSSIL RECORD I') THEN 0 ELSE 1 END, " +
    "serial_number ASC LIMIT ?"
  ).all(userId, String(definitionId), safeLimit).map(hydrateCard);
}

export function ownedScientificNames(userId = "explorer", scientificNames = []) {
  migrate(); ensureUser(userId);
  const names = [...new Set(
    scientificNames
      .map((name) => String(name || "").trim())
      .filter(Boolean)
  )].slice(0, 1200);

  const owned = new Set();
  const chunkSize = 180;
  for (let offset = 0; offset < names.length; offset += chunkSize) {
    const chunk = names.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.prepare(
      "SELECT DISTINCT scientific_name FROM cards " +
      "WHERE owner_id = ? AND scientific_name IN (" + placeholders + ")"
    ).all(userId, ...chunk);
    for (const row of rows) {
      if (row.scientific_name) owned.add(String(row.scientific_name));
    }
  }
  return [...owned];
}

function hydrateMarketRow(row) {
  if (!row) return null;
  return {
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
      definition_json: row.definition_json,
      common_name: row.common_name,
      scientific_name: row.scientific_name,
      created_at: row.card_created_at ?? row.created_at,
    }),
  };
}

const MARKET_SELECT = `
  SELECT
    l.id,l.card_id,l.seller_id,l.price,l.created_at,
    c.definition_id,c.edition_key,c.serial_number,c.serial_cap,
    c.finish,c.rarity,c.kind,c.definition_json,c.common_name,c.scientific_name,
    c.created_at AS card_created_at
  FROM listings l
  JOIN cards c ON c.id = l.card_id
`;

export function getListing(listingId) {
  migrate();
  const row = db.prepare(
    MARKET_SELECT + " WHERE l.id = ? AND l.status = 'ACTIVE' LIMIT 1"
  ).get(String(listingId));
  return hydrateMarketRow(row);
}

export function listMarket() {
  migrate();
  return db.prepare(
    MARKET_SELECT + " WHERE l.status = 'ACTIVE' ORDER BY l.created_at DESC"
  ).all().map(hydrateMarketRow);
}

export function listMarketPage({
  filter = "ALL",
  query = "",
  sort = "NEWEST",
  limit = 24,
  offset = 0,
} = {}) {
  migrate();

  const safeLimit = Math.max(1, Math.min(60, Number(limit) || 24));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const clauses = ["l.status = 'ACTIVE'"];
  const params = [];

  const normalizedFilter = String(filter || "ALL").toUpperCase();
  if (normalizedFilter === "HOLO") clauses.push("c.finish = 'HOLO'");
  if (normalizedFilter === "WILD") clauses.push("c.edition_key = 'WILD CENSUS I'");
  if (normalizedFilter === "FOSSIL") clauses.push("c.edition_key LIKE 'FOSSIL%'");
  if (normalizedFilter === "TAXA") clauses.push("c.kind = 'taxon'");

  const q = String(query || "").trim();
  if (q) {
    const like = "%" + q + "%";
    clauses.push(
      "(c.common_name LIKE ? COLLATE NOCASE OR c.scientific_name LIKE ? COLLATE NOCASE OR c.rarity LIKE ? COLLATE NOCASE)"
    );
    params.push(like, like, like);
  }

  const where = clauses.join(" AND ");
  const normalizedSort = String(sort || "NEWEST").toUpperCase();
  const order =
    normalizedSort === "PRICE_ASC"
      ? "l.price ASC, l.created_at DESC"
      : normalizedSort === "PRICE_DESC"
        ? "l.price DESC, l.created_at DESC"
        : "l.created_at DESC";

  const total = Number(
    db.prepare(
      "SELECT COUNT(*) AS c FROM listings l JOIN cards c ON c.id = l.card_id WHERE " + where
    ).get(...params)?.c || 0
  );

  const activeTotal = Number(
    db.prepare("SELECT COUNT(*) AS c FROM listings WHERE status = 'ACTIVE'").get()?.c || 0
  );

  const rows = db.prepare(
    MARKET_SELECT +
    " WHERE " + where +
    " ORDER BY " + order +
    " LIMIT ? OFFSET ?"
  ).all(...params, safeLimit, safeOffset);

  return {
    items: rows.map(hydrateMarketRow),
    total,
    activeTotal,
    limit: safeLimit,
    offset: safeOffset,
    hasMore: safeOffset + rows.length < total,
  };
}

export function createListing(userId, cardId, price) {
  migrate(); ensureUser(userId);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Price must be a positive integer");
  const card = db.prepare("SELECT * FROM cards WHERE id = ? AND owner_id = ?").get(cardId, userId);
  if (!card) throw new Error("Card not owned by seller");
  const id = uuid();
  db.prepare("INSERT INTO listings (id, card_id, seller_id, price, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)")
    .run(id, cardId, userId, price, nowMs());
  return getListing(id);
}

export function cancelListing(userId, listingId) {
  migrate(); ensureUser(userId);
  const listing = db.prepare(
    "SELECT id FROM listings WHERE id = ? AND seller_id = ? AND status = 'ACTIVE'"
  ).get(String(listingId), userId);
  if (!listing) throw new Error("Active listing not owned by seller");

  db.prepare(
    "UPDATE listings SET status = 'CANCELLED' WHERE id = ? AND seller_id = ? AND status = 'ACTIVE'"
  ).run(String(listingId), userId);

  return { id: String(listingId), status: "CANCELLED" };
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

export function listSupplies() {
  migrate();
  const rows = db.prepare(
    "SELECT definition_id, edition_key, issued_count FROM supplies ORDER BY definition_id, edition_key"
  ).all();
  return rows.map((row) => ({
    definitionId: row.definition_id,
    edition: row.edition_key,
    issued: Number(row.issued_count),
  }));
}

export function getDefinitionSupplies(definitionId) {
  migrate();
  const rows = db.prepare(
    "SELECT definition_id, edition_key, issued_count FROM supplies WHERE definition_id = ? ORDER BY edition_key"
  ).all(String(definitionId));
  return rows.map((row) => ({
    definitionId: row.definition_id,
    edition: row.edition_key,
    issued: Number(row.issued_count),
  }));
}

export function getOriginStatus() {
  migrate();
  const card = db.prepare("SELECT owner_id, created_at FROM cards WHERE definition_id = 'luca' ORDER BY created_at ASC LIMIT 1").get();
  return {
    discovered: Boolean(card),
    issued: card ? 1 : 0,
    maxSupply: 1,
    discoveredAt: card ? Number(card.created_at) : null,
  };
}

export function getState(userId = "explorer", config = DEFAULT_CONFIG) {
  migrate();
  const user = syncAccrual(userId, config);
  const inventory = db.prepare("SELECT * FROM cards WHERE owner_id = ? ORDER BY created_at DESC LIMIT 12")
    .all(userId).map(hydrateCard);
  const nextPackInMs = user.pack_balance >= config.maxStoredPacks ? 0 : Math.max(0, config.packIntervalMs - (user.now - user.pack_anchor_at));
  return {
    user: { id: user.id, displayName: user.display_name, coins: Number(user.coins), packs: Number(user.pack_balance), maxPacks: config.maxStoredPacks, nextPackInMs },
    inventory,
    collectionSummary: getCollectionSummary(userId),
    catalog: publicCatalog(),
    origin: getOriginStatus(),
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

export function resetForTests() {
  db.exec("DELETE FROM listings; DELETE FROM cards; DELETE FROM supplies; DELETE FROM users;");
}

migrate();
seedDemoMarket();
