import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { byId, catalog, publicCatalog } from "./catalog.mjs";
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
    CREATE UNIQUE INDEX IF NOT EXISTS listings_one_active_per_card
      ON listings(card_id) WHERE status = 'ACTIVE';
    CREATE TABLE IF NOT EXISTS auctions (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      starting_price INTEGER NOT NULL CHECK(starting_price > 0),
      highest_bid INTEGER,
      highest_bidder_id TEXT,
      ends_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      FOREIGN KEY(card_id) REFERENCES cards(id),
      FOREIGN KEY(seller_id) REFERENCES users(id),
      FOREIGN KEY(highest_bidder_id) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS auctions_one_active_per_card
      ON auctions(card_id) WHERE status = 'ACTIVE';
    CREATE INDEX IF NOT EXISTS auctions_status_end_idx ON auctions(status, ends_at);
    CREATE TABLE IF NOT EXISTS auction_bids (
      id TEXT PRIMARY KEY,
      auction_id TEXT NOT NULL,
      bidder_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY(auction_id) REFERENCES auctions(id),
      FOREIGN KEY(bidder_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS external_cache (
      provider TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (provider, cache_key)
    );
    CREATE INDEX IF NOT EXISTS external_cache_expiry_idx ON external_cache(expires_at);
    CREATE TABLE IF NOT EXISTS knowledge_stats (
      user_id TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0,
      correct_answers INTEGER NOT NULL DEFAULT 0,
      total_answers INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL,
      correct_option TEXT NOT NULL,
      explanation TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS quiz_questions_user_idx ON quiz_questions(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS pack_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      prev_hash TEXT,
      audit_hash TEXT NOT NULL UNIQUE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS pack_audit_opened_idx ON pack_audit(opened_at DESC);
    CREATE TABLE IF NOT EXISTS accounts (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `);
  migrateLegacyListingsUniqueConstraint();
}

function migrateLegacyListingsUniqueConstraint() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'listings'").get();
  const sql = String(row?.sql || "");
  if (!/card_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql)) return;

  db.exec("DROP INDEX IF EXISTS listings_one_active_per_card");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE listings_v2 (
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
      INSERT INTO listings_v2 (id, card_id, seller_id, price, status, buyer_id, created_at, sold_at)
        SELECT id, card_id, seller_id, price, status, buyer_id, created_at, sold_at FROM listings;
      DROP TABLE listings;
      ALTER TABLE listings_v2 RENAME TO listings;
      CREATE INDEX listings_status_idx ON listings(status, created_at DESC);
      CREATE UNIQUE INDEX listings_one_active_per_card
        ON listings(card_id) WHERE status = 'ACTIVE';
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64).toString("hex");
}

function validUsername(username) {
  return /^[a-zA-Z0-9_.-]{3,24}$/.test(String(username || ""));
}

export function registerAccount({ username, password, displayName }) {
  migrate();
  const normalized = String(username || "").trim();
  const pass = String(password || "");
  const name = String(displayName || normalized).trim().slice(0, 40);

  if (!validUsername(normalized)) {
    throw new Error("Username must be 3–24 characters using letters, numbers, _, . or -");
  }
  if (pass.length < 10 || pass.length > 200) {
    throw new Error("Password must be between 10 and 200 characters");
  }
  if (!name) throw new Error("Display name is required");

  const existing = db.prepare("SELECT user_id FROM accounts WHERE username = ? COLLATE NOCASE").get(normalized);
  if (existing) throw new Error("Username is already taken");

  const userId = uuid();
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(pass, salt);
  const now = nowMs();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO users (id, display_name, coins, pack_balance, pack_anchor_at, created_at)
      VALUES (?, ?, 10000, 1, ?, ?)
    `).run(userId, name, now, now);
    db.prepare(`
      INSERT INTO accounts (user_id, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, normalized, passwordHash, salt, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { id: userId, username: normalized, displayName: name };
}

export function authenticateAccount(username, password) {
  migrate();
  const row = db.prepare(`
    SELECT a.user_id, a.username, a.password_hash, a.password_salt, u.display_name
    FROM accounts a
    JOIN users u ON u.id = a.user_id
    WHERE a.username = ? COLLATE NOCASE
  `).get(String(username || "").trim());

  if (!row) return null;
  const candidate = hashPassword(String(password || ""), row.password_salt);
  const left = Buffer.from(candidate, "hex");
  const right = Buffer.from(row.password_hash, "hex");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
  };
}

function sessionTokenHash(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

export function createSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  migrate();
  ensureUser(userId);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sessionTokenHash(rawToken);
  const createdAt = nowMs();
  const expiresAt = createdAt + ttlMs;
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, userId, createdAt, expiresAt);
  return { rawToken, expiresAt };
}

export function resolveSession(rawToken) {
  migrate();
  if (!rawToken) return null;
  const tokenHash = sessionTokenHash(rawToken);
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at, a.username, u.display_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN accounts a ON a.user_id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;

  if (Number(row.expires_at) <= nowMs()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  return {
    id: row.user_id,
    username: row.username || null,
    displayName: row.display_name,
    expiresAt: Number(row.expires_at),
  };
}

export function revokeSession(rawToken) {
  migrate();
  if (!rawToken) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sessionTokenHash(rawToken));
}

export function purgeExpiredSessions() {
  migrate();
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowMs());
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

function appendPackAudit(userId, cards, originCard) {
  const previous = db.prepare(
    "SELECT audit_hash FROM pack_audit ORDER BY opened_at DESC, rowid DESC LIMIT 1"
  ).get();
  const prevHash = previous?.audit_hash || null;
  const openedAt = nowMs();
  const payload = {
    version: 1,
    userId,
    openedAt,
    cards: cards.map((card) => ({
      cardId: card.id,
      definitionId: card.definitionId,
      edition: card.edition,
      serial: card.serial,
      serialCap: card.serialCap,
      finish: card.finish,
    })),
    origin: originCard
      ? {
          cardId: originCard.id,
          definitionId: originCard.definitionId,
          edition: originCard.edition,
          serial: originCard.serial,
          serialCap: originCard.serialCap,
          finish: originCard.finish,
        }
      : null,
  };
  const payloadJson = JSON.stringify(payload);
  const auditHash = crypto.createHash("sha256")
    .update(String(prevHash || "GENESIS"))
    .update("\n")
    .update(payloadJson)
    .digest("hex");
  const id = uuid();
  db.prepare(`
    INSERT INTO pack_audit (id, user_id, opened_at, payload_json, prev_hash, audit_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, openedAt, payloadJson, prevHash, auditHash);
  return { id, openedAt, prevHash, auditHash };
}

export function getAuditHead() {
  migrate();
  const head = db.prepare(
    "SELECT id, opened_at, prev_hash, audit_hash FROM pack_audit ORDER BY opened_at DESC, rowid DESC LIMIT 1"
  ).get();
  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM pack_audit").get().c);
  return head
    ? {
        count,
        id: head.id,
        openedAt: Number(head.opened_at),
        prevHash: head.prev_hash || null,
        auditHash: head.audit_hash,
      }
    : { count: 0, id: null, openedAt: null, prevHash: null, auditHash: null };
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
    const audit = appendPackAudit(userId, cards, originCard);
    db.exec("COMMIT");
    return { cards, originCard, audit };
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

function hydrateAuction(row) {
  if (!row) return null;
  const cardRow = db.prepare("SELECT * FROM cards WHERE id = ?").get(row.card_id);
  return {
    id: row.id,
    sellerId: row.seller_id,
    startingPrice: Number(row.starting_price),
    highestBid: row.highest_bid == null ? null : Number(row.highest_bid),
    highestBidderId: row.highest_bidder_id || null,
    endsAt: Number(row.ends_at),
    status: row.status,
    createdAt: Number(row.created_at),
    card: hydrateCard(cardRow),
  };
}

export function settleExpiredAuctions() {
  migrate();
  const expired = db.prepare(
    "SELECT id FROM auctions WHERE status = 'ACTIVE' AND ends_at <= ? ORDER BY ends_at ASC"
  ).all(nowMs());
  for (const { id } of expired) settleAuction(id);
}

export function settleAuction(auctionId) {
  migrate();
  db.exec("BEGIN IMMEDIATE");
  try {
    const auction = db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId);
    if (!auction || auction.status !== "ACTIVE") {
      db.exec("COMMIT");
      return auction ? hydrateAuction(auction) : null;
    }
    if (Number(auction.ends_at) > nowMs()) throw new Error("Auction has not ended");

    if (auction.highest_bidder_id && auction.highest_bid != null) {
      const fee = Math.floor(Number(auction.highest_bid) * 0.05);
      const proceeds = Number(auction.highest_bid) - fee;
      db.prepare("UPDATE cards SET owner_id = ? WHERE id = ?")
        .run(auction.highest_bidder_id, auction.card_id);
      db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?")
        .run(proceeds, auction.seller_id);
      db.prepare("UPDATE auctions SET status = 'SOLD', settled_at = ? WHERE id = ?")
        .run(nowMs(), auctionId);
    } else {
      db.prepare("UPDATE auctions SET status = 'ENDED', settled_at = ? WHERE id = ?")
        .run(nowMs(), auctionId);
    }

    db.exec("COMMIT");
    return hydrateAuction(db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listAuctions() {
  migrate();
  settleExpiredAuctions();
  return db.prepare(
    "SELECT * FROM auctions WHERE status = 'ACTIVE' ORDER BY ends_at ASC"
  ).all().map(hydrateAuction);
}

export function createAuction(userId, cardId, startingPrice, durationMinutes = 60) {
  migrate();
  ensureUser(userId);
  if (!Number.isSafeInteger(startingPrice) || startingPrice <= 0) {
    throw new Error("Starting price must be a positive integer");
  }
  const duration = Math.max(5, Math.min(7 * 24 * 60, Number(durationMinutes) || 60));
  const card = db.prepare("SELECT * FROM cards WHERE id = ? AND owner_id = ?").get(cardId, userId);
  if (!card) throw new Error("Card not owned by seller");

  const fixed = db.prepare("SELECT id FROM listings WHERE card_id = ? AND status = 'ACTIVE'").get(cardId);
  if (fixed) throw new Error("Card already has an active fixed-price listing");

  const active = db.prepare("SELECT id FROM auctions WHERE card_id = ? AND status = 'ACTIVE'").get(cardId);
  if (active) throw new Error("Card already has an active auction");

  const id = uuid();
  db.prepare(`
    INSERT INTO auctions
      (id, card_id, seller_id, starting_price, ends_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
  `).run(id, cardId, userId, startingPrice, nowMs() + duration * 60 * 1000, nowMs());
  return hydrateAuction(db.prepare("SELECT * FROM auctions WHERE id = ?").get(id));
}

export function placeAuctionBid(userId, auctionId, amount) {
  migrate();
  ensureUser(userId);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Bid must be a positive integer");

  db.exec("BEGIN IMMEDIATE");
  try {
    const auction = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'ACTIVE'").get(auctionId);
    if (!auction) throw new Error("Auction unavailable");
    if (Number(auction.ends_at) <= nowMs()) {
      db.exec("ROLLBACK");
      settleAuction(auctionId);
      throw new Error("Auction has ended");
    }
    if (auction.seller_id === userId) throw new Error("You cannot bid on your own auction");

    const minimum = auction.highest_bid == null
      ? Number(auction.starting_price)
      : Number(auction.highest_bid) + 1;
    if (amount < minimum) throw new Error(`Bid must be at least ${minimum} Coins`);

    const bidder = readUser(userId);
    if (Number(bidder.coins) < amount) throw new Error("Not enough coins");

    db.prepare("UPDATE users SET coins = coins - ? WHERE id = ?").run(amount, userId);
    if (auction.highest_bidder_id && auction.highest_bid != null) {
      db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?")
        .run(Number(auction.highest_bid), auction.highest_bidder_id);
    }

    const antiSnipeEndsAt = Number(auction.ends_at) - nowMs() < 2 * 60 * 1000
      ? nowMs() + 2 * 60 * 1000
      : Number(auction.ends_at);

    db.prepare(`
      UPDATE auctions
      SET highest_bid = ?, highest_bidder_id = ?, ends_at = ?
      WHERE id = ?
    `).run(amount, userId, antiSnipeEndsAt, auctionId);
    db.prepare(`
      INSERT INTO auction_bids (id, auction_id, bidder_id, amount, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), auctionId, userId, amount, nowMs());

    db.exec("COMMIT");
    return hydrateAuction(db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId));
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function createListing(userId, cardId, price) {
  migrate(); ensureUser(userId);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Price must be a positive integer");
  const card = db.prepare("SELECT * FROM cards WHERE id = ? AND owner_id = ?").get(cardId, userId);
  if (!card) throw new Error("Card not owned by seller");
  const auction = db.prepare("SELECT id FROM auctions WHERE card_id = ? AND status = 'ACTIVE'").get(cardId);
  if (auction) throw new Error("Card already has an active auction");
  const id = uuid();
  db.prepare("INSERT INTO listings (id, card_id, seller_id, price, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)")
    .run(id, cardId, userId, price, nowMs());
  return listMarket().find((listing) => listing.id === id);
}

export function cancelListing(userId, listingId) {
  migrate();
  ensureUser(userId);
  const listing = db.prepare(
    "SELECT * FROM listings WHERE id = ? AND seller_id = ? AND status = 'ACTIVE'"
  ).get(listingId, userId);
  if (!listing) throw new Error("Active listing not found");
  db.prepare("UPDATE listings SET status = 'CANCELLED' WHERE id = ?").run(listingId);
  return { id: listingId, status: "CANCELLED" };
}

export function cancelAuction(userId, auctionId) {
  migrate();
  ensureUser(userId);
  const auction = db.prepare(
    "SELECT * FROM auctions WHERE id = ? AND seller_id = ? AND status = 'ACTIVE'"
  ).get(auctionId, userId);
  if (!auction) throw new Error("Active auction not found");
  if (auction.highest_bidder_id) throw new Error("An auction with bids cannot be cancelled");
  db.prepare("UPDATE auctions SET status = 'CANCELLED', settled_at = ? WHERE id = ?")
    .run(nowMs(), auctionId);
  return { id: auctionId, status: "CANCELLED" };
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
    profile: profileStats(userId, inventory),
    market: listMarket(),
    auctions: listAuctions(),
    audit: getAuditHead(),
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

function ensureKnowledgeStats(userId) {
  ensureUser(userId);
  db.prepare(`
    INSERT INTO knowledge_stats (user_id, points, correct_answers, total_answers, streak, best_streak)
    VALUES (?, 0, 0, 0, 0, 0)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId);
  return db.prepare("SELECT * FROM knowledge_stats WHERE user_id = ?").get(userId);
}

function shuffled(values, rng = cryptoRng()) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = rng.int(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function uniqueOptions(correct, candidates, rng) {
  const rest = [...new Set(candidates.filter((value) => value && value !== correct))];
  const picked = shuffled(rest, rng).slice(0, 3);
  return shuffled([correct, ...picked], rng);
}

export function getKnowledgeStats(userId = "explorer") {
  migrate();
  const row = ensureKnowledgeStats(userId);
  return {
    points: Number(row.points),
    correctAnswers: Number(row.correct_answers),
    totalAnswers: Number(row.total_answers),
    streak: Number(row.streak),
    bestStreak: Number(row.best_streak),
    accuracy: Number(row.total_answers) > 0
      ? Number(row.correct_answers) / Number(row.total_answers)
      : 0,
  };
}

export function createKnowledgeQuestion(userId = "explorer", rng = cryptoRng()) {
  migrate();
  ensureKnowledgeStats(userId);

  const parentCandidates = catalog.filter((definition) => definition.parentId && byId.has(definition.parentId));
  const rankCandidates = catalog.filter((definition) => definition.kind === "taxon" && definition.rank);

  const useParent = parentCandidates.length > 0 && (rankCandidates.length === 0 || rng.int(2) === 0);
  let prompt;
  let correct;
  let options;
  let explanation;

  if (useParent) {
    const definition = parentCandidates[rng.int(parentCandidates.length)];
    const parent = byId.get(definition.parentId);
    prompt = `Which group is the direct parent of ${definition.commonName} in the LifeCards tree?`;
    correct = parent.commonName;
    options = uniqueOptions(
      correct,
      catalog.filter((entry) => entry.kind === "taxon").map((entry) => entry.commonName),
      rng
    );
    explanation = `${definition.commonName} is placed under ${parent.commonName} in the current LifeCards tree snapshot.`;
  } else {
    const definition = rankCandidates[rng.int(rankCandidates.length)];
    prompt = `What taxonomic rank is ${definition.commonName} represented as in LifeCards?`;
    correct = definition.rank;
    options = uniqueOptions(
      correct,
      rankCandidates.map((entry) => entry.rank),
      rng
    );
    explanation = `${definition.commonName} is represented as the rank “${definition.rank}” in the current taxonomy snapshot.`;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO quiz_questions
      (id, user_id, prompt, options_json, correct_option, explanation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, prompt, JSON.stringify(options), correct, explanation, nowMs());

  return { id, prompt, options };
}

export function answerKnowledgeQuestion(userId = "explorer", questionId, selectedOption) {
  migrate();
  ensureKnowledgeStats(userId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const question = db.prepare(
      "SELECT * FROM quiz_questions WHERE id = ? AND user_id = ?"
    ).get(questionId, userId);
    if (!question) throw new Error("Question not found");
    if (question.answered_at) throw new Error("Question already answered");
    if (nowMs() - Number(question.created_at) > 30 * 60 * 1000) {
      throw new Error("Question expired");
    }

    const correct = String(selectedOption) === String(question.correct_option);
    const stats = ensureKnowledgeStats(userId);
    const nextStreak = correct ? Number(stats.streak) + 1 : 0;
    const nextBest = Math.max(Number(stats.best_streak), nextStreak);
    const pointsEarned = correct ? 25 + Math.min(25, nextStreak * 2) : 0;
    const coinReward = correct ? 10 : 0;

    db.prepare(`
      UPDATE knowledge_stats
      SET points = points + ?,
          correct_answers = correct_answers + ?,
          total_answers = total_answers + 1,
          streak = ?,
          best_streak = ?
      WHERE user_id = ?
    `).run(pointsEarned, correct ? 1 : 0, nextStreak, nextBest, userId);

    if (coinReward > 0) {
      db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(coinReward, userId);
    }

    db.prepare("UPDATE quiz_questions SET answered_at = ? WHERE id = ?")
      .run(nowMs(), questionId);
    db.exec("COMMIT");

    return {
      correct,
      correctOption: question.correct_option,
      explanation: question.explanation,
      pointsEarned,
      coinReward,
      stats: getKnowledgeStats(userId),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function profileStats(userId, inventory) {
  const uniqueSpecies = new Set(inventory.filter((card) => card.kind === "species").map((card) => card.definitionId)).size;
  const uniqueTaxa = new Set(inventory.filter((card) => card.kind === "taxon").map((card) => card.definitionId)).size;
  const holo = inventory.filter((card) => card.finish === "HOLO").length;
  const wild = inventory.filter((card) => card.edition === "WILD CENSUS I").length;
  const fossil = inventory.filter((card) => card.edition === "FOSSIL RECORD I").length;
  const origin = inventory.some((card) => card.definitionId === "luca");

  const achievements = [
    { id: "first-discovery", name: "First Discovery", description: "Own your first LifeCard.", unlocked: inventory.length >= 1 },
    { id: "field-naturalist", name: "Field Naturalist", description: "Discover 5 distinct species.", unlocked: uniqueSpecies >= 5 },
    { id: "branch-collector", name: "Branch Collector", description: "Own 3 distinct taxon cards.", unlocked: uniqueTaxa >= 3 },
    { id: "holographic", name: "Iridescent", description: "Own a Holo card.", unlocked: holo >= 1 },
    { id: "wild-archive", name: "Wild Archive", description: "Own 5 Wild Census cards.", unlocked: wild >= 5 },
    { id: "deep-time", name: "Deep Time", description: "Own a Fossil Record card.", unlocked: fossil >= 1 },
    { id: "the-origin", name: "The Origin", description: "Become the keeper of LUCA #1/1.", unlocked: origin },
  ];

  return {
    totalCards: inventory.length,
    uniqueSpecies,
    uniqueTaxa,
    holo,
    wild,
    fossil,
    origin,
    achievements,
    knowledge: getKnowledgeStats(userId),
  };
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
  db.exec("DELETE FROM sessions; DELETE FROM accounts; DELETE FROM pack_audit; DELETE FROM auction_bids; DELETE FROM auctions; DELETE FROM quiz_questions; DELETE FROM knowledge_stats; DELETE FROM external_cache; DELETE FROM listings; DELETE FROM cards; DELETE FROM supplies; DELETE FROM users;");
}

migrate();
seedDemoMarket();
