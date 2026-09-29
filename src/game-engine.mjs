import crypto from "node:crypto";
import { getDroppableDefinitions } from "./catalog.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  packIntervalMs: 8 * 60 * 1000,
  maxStoredPacks: 8,
  cardsPerPack: 6,
  holoRate: Number(process.env.LIFECARDS_HOLO_RATE ?? 0.075),
  lucaDenominator: Number(process.env.LIFECARDS_LUCA_DENOMINATOR ?? 1_000_000_000),
});

export const RARITY_WEIGHTS = Object.freeze({
  COMMON: 50,
  UNCOMMON: 25,
  RARE: 14,
  SUPER_RARE: 6,
  ULTRA_RARE: 3,
  LEGENDARY: 1.5,
  MYTHIC: 0.5,
});

export function cryptoRng() {
  return {
    float() {
      return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
    },
    int(maxExclusive) {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error("maxExclusive must be a positive safe integer");
      }
      return crypto.randomInt(0, maxExclusive);
    },
  };
}

export function weightedPick(entries, getWeight, rng = cryptoRng()) {
  const weights = entries.map((entry) => Math.max(0, Number(getWeight(entry)) || 0));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error("No positive weight available");
  let target = rng.float() * total;
  for (let index = 0; index < entries.length; index += 1) {
    target -= weights[index];
    if (target < 0) return entries[index];
  }
  return entries.at(-1);
}

export function rollRarity(rng = cryptoRng()) {
  const entries = Object.entries(RARITY_WEIGHTS).map(([rarity, weight]) => ({ rarity, weight }));
  return weightedPick(entries, (entry) => entry.weight, rng).rarity;
}

export function selectDefinition(rarity, rng = cryptoRng(), definitions = getDroppableDefinitions()) {
  const candidates = definitions.filter((entry) => entry.rarity === rarity);
  if (!candidates.length) {
    const fallback = definitions.filter((entry) => entry.rarity !== "UNKNOWN");
    return weightedPick(fallback, (entry) => entry.selectionWeight ?? 1, rng);
  }
  return weightedPick(candidates, (entry) => entry.kind === "species" ? 1 : (entry.selectionWeight ?? 1), rng);
}

export function rollFinish(rng = cryptoRng(), holoRate = DEFAULT_CONFIG.holoRate) {
  return rng.float() < holoRate ? "HOLO" : "STANDARD";
}

export function rollOrigin(rng = cryptoRng(), denominator = DEFAULT_CONFIG.lucaDenominator) {
  if (!Number.isSafeInteger(denominator) || denominator < 1) {
    throw new Error("LUCA denominator must be a positive safe integer");
  }
  return rng.int(denominator) === 0;
}

export function generatePackBlueprint({ rng = cryptoRng(), config = DEFAULT_CONFIG, definitions, definitionSelector } = {}) {
  const cards = [];
  for (let i = 0; i < config.cardsPerPack; i += 1) {
    const rarity = rollRarity(rng);
    const external = definitionSelector ? definitionSelector(rarity, rng) : null;
    const definition = external || selectDefinition(rarity, rng, definitions ?? getDroppableDefinitions());
    if (!definition) throw new Error(`No card definition available for rarity ${rarity}`);
    cards.push({ definitionId: definition.id, finish: rollFinish(rng, config.holoRate) });
  }
  return {
    cards,
    originTriggered: rollOrigin(rng, config.lucaDenominator),
  };
}

export function packsAccrued({ now, anchorAt, balance, config = DEFAULT_CONFIG }) {
  if (balance >= config.maxStoredPacks) return { balance: config.maxStoredPacks, anchorAt: now };
  const elapsed = Math.max(0, now - anchorAt);
  const earned = Math.floor(elapsed / config.packIntervalMs);
  if (earned <= 0) return { balance, anchorAt };
  const room = config.maxStoredPacks - balance;
  const credited = Math.min(room, earned);
  const newBalance = balance + credited;
  const newAnchorAt = newBalance >= config.maxStoredPacks
    ? now
    : anchorAt + credited * config.packIntervalMs;
  return { balance: newBalance, anchorAt: newAnchorAt };
}
