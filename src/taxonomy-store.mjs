import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { catalog, byId } from "./catalog.mjs";

const taxonomyPath = resolve(process.env.LIFECARDS_TAXONOMY_DB ?? "./data/animalia.sqlite");
let fullDb = null;

function openFullDb() {
  if (fullDb) return fullDb;
  if (!existsSync(taxonomyPath)) return null;
  try {
    mkdirSync(dirname(taxonomyPath), { recursive: true });
    fullDb = new DatabaseSync(taxonomyPath, { readOnly: true });
    fullDb.exec("PRAGMA query_only=ON;");
    const table = fullDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='taxa'").get();
    if (!table) {
      fullDb.close();
      fullDb = null;
      return null;
    }
    return fullDb;
  } catch {
    fullDb = null;
    return null;
  }
}

function metaValue(db, key) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    scientificName: row.scientific_name,
    canonicalName: row.canonical_name || row.scientific_name,
    commonName: row.common_name || row.canonical_name || row.scientific_name,
    rank: row.rank || "unranked",
    status: row.status || "accepted",
    extinct: Boolean(row.extinct),
    childCount: Number(row.child_count || 0),
    descendantSpeciesCount: Number(row.descendant_species_count || (String(row.rank || "").toLowerCase()==="species" ? 1 : 0)),
    kind: String(row.rank || "").toLowerCase() === "species" ? "species" : "taxon",
    source: "Catalogue of Life",
    sourceId: String(row.id),
    gameRarity: row.game_rarity || row.pool_rarity || null,
  };
}

function seedDescendantSpeciesCount(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  const item = byId.get(id);
  if (!item) return 0;
  if (item.kind === "species") return 1;
  return catalog
    .filter((entry) => entry.parentId === id)
    .reduce((sum, child) => sum + seedDescendantSpeciesCount(child.id, new Set(seen)), 0);
}

function seedDefinition(id) {
  const item = byId.get(id);
  if (!item) return null;
  return {
    id: item.id,
    parentId: item.parentId,
    scientificName: item.scientificName,
    canonicalName: item.scientificName,
    commonName: item.commonName,
    rank: item.rank || (item.kind === "species" ? "species" : item.kind),
    status: "seed",
    extinct: item.temporalStatus === "extinct",
    childCount: catalog.filter((entry) => entry.parentId === item.id).length,
    descendantSpeciesCount: seedDescendantSpeciesCount(item.id),
    kind: item.kind,
    source: "LifeCards seed",
    sourceId: item.id,
    rarity: item.rarity,
    icon: item.icon,
  };
}

function seedChildren(id) {
  return catalog.filter((entry) => entry.parentId === id).map((entry) => seedDefinition(entry.id));
}

function rankWeight(rank) {
  const order = {
    domain: 1, kingdom: 2, phylum: 3, class: 4, order: 5,
    family: 6, genus: 7, species: 8, subspecies: 9,
  };
  return order[String(rank || "").toLowerCase()] ?? 20;
}

export function taxonomyStatus() {
  const db = openFullDb();
  if (!db) {
    return {
      ready: false,
      mode: "seed",
      databasePath: taxonomyPath,
      taxonCount: catalog.length,
      speciesCount: catalog.filter((x) => x.kind === "species").length,
      rootId: "animalia",
      mapRootId: "luca",
      source: "LifeCards seed catalog",
      hint: "Run npm install && npm run sync:col to import Catalogue of Life Animalia.",
    };
  }
  const dropPoolTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drop_pool'").get();
  const dropPoolStatsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drop_pool_stats'").get();
  const dropPool = dropPoolStatsTable
    ? Object.fromEntries(db.prepare("SELECT rarity, card_count FROM drop_pool_stats").all().map((row) => [row.rarity, Number(row.card_count)]))
    : {};

  return {
    ready: true,
    mode: "catalogue-of-life",
    databasePath: taxonomyPath,
    taxonCount: Number(metaValue(db, "taxon_count") || 0),
    speciesCount: Number(metaValue(db, "species_count") || 0),
    rootId: metaValue(db, "root_id") || null,
    mapRootId: "luca",
    scope: metaValue(db, "scope") || "Animalia",
    datasetKey: metaValue(db, "dataset_key"),
    release: metaValue(db, "release"),
    importedAt: metaValue(db, "imported_at"),
    source: "Catalogue of Life / ChecklistBank",
    schemaVersion: metaValue(db, "schema_version") || "legacy",
    dropPoolReady: Boolean(dropPoolTable),
    dropPool,
  };
}

export function getTaxon(id) {
  const db = openFullDb();
  if (!db) return seedDefinition(String(id));
  const row = db.prepare(`
    SELECT id,parent_id,scientific_name,canonical_name,common_name,rank,status,extinct,child_count,descendant_species_count
    FROM taxa WHERE id = ?
  `).get(String(id));
  return mapRow(row);
}


export function pickDropTaxon(rarity, rng) {
  const db = openFullDb();
  if (!db) return null;

  try {
    const stat = db.prepare("SELECT card_count FROM drop_pool_stats WHERE rarity = ?").get(String(rarity));
    const count = Number(stat?.card_count || 0);
    if (!count) return null;

    const slot = (rng?.int ? rng.int(count) : Math.floor(Math.random() * count)) + 1;
    const row = db.prepare(`
      SELECT t.*, p.rarity AS pool_rarity
      FROM drop_pool p
      JOIN taxa t ON t.id = p.taxon_id
      WHERE p.rarity = ? AND p.slot = ?
      LIMIT 1
    `).get(String(rarity), slot);

    return mapRow(row);
  } catch {
    return null;
  }
}

function ftsQuery(query) {
  const tokens = String(query || "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export function searchTaxa(query, limit = 30) {
  const q = String(query || "").trim();
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const db = openFullDb();
  if (!db) {
    const needle = q.toLowerCase();
    return catalog
      .filter((entry) =>
        [entry.commonName, entry.scientificName, entry.rank, entry.kind]
          .some((value) => String(value || "").toLowerCase().includes(needle)))
      .slice(0, safeLimit)
      .map((entry) => seedDefinition(entry.id));
  }

  const fts = ftsQuery(q);
  if (fts) {
    try {
      const rows = db.prepare(`
        SELECT t.id,t.parent_id,t.scientific_name,t.canonical_name,t.common_name,
               t.rank,t.status,t.extinct,t.child_count,t.descendant_species_count
        FROM taxa_fts f
        JOIN taxa t ON t.id = f.id
        WHERE taxa_fts MATCH ?
        ORDER BY
          CASE
            WHEN t.scientific_name = ? COLLATE NOCASE THEN 0
            WHEN t.canonical_name = ? COLLATE NOCASE THEN 0
            WHEN t.common_name = ? COLLATE NOCASE THEN 0
            ELSE 1
          END,
          bm25(taxa_fts),
          LENGTH(t.scientific_name)
        LIMIT ?
      `).all(fts, q, q, q, safeLimit);
      if (rows.length) return rows.map(mapRow);
    } catch {
      // Older local DBs may not have the FTS table yet; fall back to LIKE.
    }
  }

  const prefix = `${q}%`;
  const rows = db.prepare(`
    SELECT id,parent_id,scientific_name,canonical_name,common_name,rank,status,extinct,child_count,descendant_species_count
    FROM taxa
    WHERE scientific_name LIKE ? COLLATE NOCASE
       OR canonical_name LIKE ? COLLATE NOCASE
       OR common_name LIKE ? COLLATE NOCASE
    ORDER BY
      CASE
        WHEN scientific_name = ? COLLATE NOCASE THEN 0
        WHEN canonical_name = ? COLLATE NOCASE THEN 0
        WHEN common_name = ? COLLATE NOCASE THEN 0
        ELSE 1
      END,
      scientific_name
    LIMIT ?
  `).all(prefix, prefix, prefix, q, q, q, safeLimit);
  return rows.map(mapRow);
}

export function getChildren(id, limit = 120) {
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 120));
  const db = openFullDb();
  if (!db) {
    return seedChildren(String(id))
      .sort((a, b) => rankWeight(a.rank) - rankWeight(b.rank) || a.scientificName.localeCompare(b.scientificName))
      .slice(0, safeLimit);
  }

  const rows = db.prepare(`
    SELECT id,parent_id,scientific_name,canonical_name,common_name,rank,status,extinct,child_count,descendant_species_count
    FROM taxa
    WHERE parent_id = ?
    ORDER BY descendant_species_count DESC, child_count DESC, rank, scientific_name
    LIMIT ?
  `).all(String(id), safeLimit);
  return rows.map(mapRow);
}

function seedPath(id) {
  const path = [];
  const seen = new Set();
  let current = byId.get(String(id));
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(seedDefinition(current.id));
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return path;
}

export function getPath(id, maxDepth = 64) {
  const db = openFullDb();
  if (!db) return seedPath(id);
  const path = [];
  const seen = new Set();
  let currentId = String(id);
  for (let i = 0; i < maxDepth && currentId && !seen.has(currentId); i += 1) {
    seen.add(currentId);
    const row = db.prepare(`
      SELECT id,parent_id,scientific_name,canonical_name,common_name,rank,status,extinct,child_count,descendant_species_count
      FROM taxa WHERE id = ?
    `).get(currentId);
    if (!row) break;
    const mapped = mapRow(row);
    path.unshift(mapped);
    currentId = mapped.parentId;
  }
  return path;
}


function syntheticBackboneNode(id, scientificName, commonName, rank, childCount = 0) {
  return {
    id,
    parentId: null,
    scientificName,
    canonicalName: scientificName,
    commonName,
    rank,
    status: "backbone",
    extinct: false,
    childCount,
    kind: id === "luca" ? "origin" : "taxon",
    source: "LifeCards universal backbone",
    sourceId: id,
  };
}

function backbonePathForAnimalia(path) {
  if (!Array.isArray(path) || !path.length) return path || [];
  const hasAnimalia = path.some((node) => String(node.scientificName).toLowerCase() === "animalia");
  if (!hasAnimalia) return path;
  const prefix = [
    syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
    syntheticBackboneNode("eukaryota", "Eukaryota", "Eukaryotes", "domain", 1),
  ];
  const existing = new Set(path.map((node) => String(node.id)));
  return [...prefix.filter((node) => !existing.has(node.id)), ...path];
}

function buildUniversalSubtree(status, { depth = 4, childLimit = 48, nodeLimit = 900 } = {}) {
  const luca = { ...syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3), children: [], truncatedChildren: 0 };
  const bacteria = { ...syntheticBackboneNode("bacteria", "Bacteria", "Bacteria", "domain", 0), parentId: "luca", children: [], truncatedChildren: 0 };
  const archaea = { ...syntheticBackboneNode("archaea", "Archaea", "Archaea", "domain", 0), parentId: "luca", children: [], truncatedChildren: 0 };
  const eukaryota = { ...syntheticBackboneNode("eukaryota", "Eukaryota", "Eukaryotes", "domain", 1), parentId: "luca", children: [], truncatedChildren: 0 };
  luca.children.push(bacteria, archaea, eukaryota);

  let nodesUsed = 4;
  if (depth >= 2) {
    const importedRoot = status.ready ? getTaxon(status.rootId) : seedDefinition("animalia");
    if (importedRoot) {
      if (depth <= 2) {
        eukaryota.children.push({ ...importedRoot, parentId: "eukaryota", children: [], truncatedChildren: importedRoot.childCount || 0 });
        nodesUsed += 1;
      } else {
        const animalPayload = getSubtree(importedRoot.id, {
          depth: Math.max(1, depth - 2),
          childLimit,
          nodeLimit: Math.max(20, nodeLimit - nodesUsed),
        });
        if (animalPayload?.root) {
          eukaryota.children.push({ ...animalPayload.root, parentId: "eukaryota" });
          nodesUsed += animalPayload.nodesUsed;
        }
      }
    }
  }

  return {
    root: luca,
    nodesUsed,
    maxNodes: nodeLimit,
    status,
    path: [syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3)],
  };
}

const subtreeCache = new Map();
const SUBTREE_CACHE_MAX = 80;

function cacheSubtree(key, value) {
  if (subtreeCache.has(key)) subtreeCache.delete(key);
  subtreeCache.set(key, value);
  while (subtreeCache.size > SUBTREE_CACHE_MAX) {
    subtreeCache.delete(subtreeCache.keys().next().value);
  }
  return value;
}

function getChildrenBatch(parentIds, childLimit) {
  const db = openFullDb();
  if (!db) {
    const output = new Map();
    for (const id of parentIds) output.set(String(id), seedChildren(String(id)).slice(0, childLimit));
    return output;
  }

  const output = new Map(parentIds.map((id) => [String(id), []]));
  const chunkSize = 160;
  for (let offset = 0; offset < parentIds.length; offset += chunkSize) {
    const chunk = parentIds.slice(offset, offset + chunkSize).map(String);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT id,parent_id,scientific_name,canonical_name,common_name,rank,status,extinct,child_count,descendant_species_count
      FROM (
        SELECT t.*,
               ROW_NUMBER() OVER (
                 PARTITION BY parent_id
                 ORDER BY descendant_species_count DESC, child_count DESC, rank, scientific_name
               ) AS rn
        FROM taxa t
        WHERE parent_id IN (${placeholders})
      )
      WHERE rn <= ?
      ORDER BY parent_id, rn
    `).all(...chunk, childLimit);

    for (const row of rows) {
      const mapped = mapRow(row);
      const key = String(mapped.parentId);
      if (!output.has(key)) output.set(key, []);
      output.get(key).push(mapped);
    }
  }
  return output;
}

export function getSubtree(rootId, { depth = 3, childLimit = 48, nodeLimit = 900 } = {}) {
  const status = taxonomyStatus();
  const resolvedRoot = rootId || status.mapRootId || status.rootId || "luca";

  if (resolvedRoot === "luca") {
    const cacheKey = ["universal", depth, childLimit, nodeLimit, status.mode, status.release || ""].join("|");
    if (subtreeCache.has(cacheKey)) return subtreeCache.get(cacheKey);
    return cacheSubtree(cacheKey, buildUniversalSubtree(status, { depth, childLimit, nodeLimit }));
  }

  if (resolvedRoot === "eukaryota") {
    const universal = buildUniversalSubtree(status, { depth: depth + 1, childLimit, nodeLimit });
    const root = universal.root.children.find((node) => node.id === "eukaryota");
    return {
      ...universal,
      root,
      nodesUsed: Math.max(1, universal.nodesUsed - 3),
      path: [
        syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
        syntheticBackboneNode("eukaryota", "Eukaryota", "Eukaryotes", "domain", 1),
      ],
    };
  }

  if (resolvedRoot === "bacteria" || resolvedRoot === "archaea") {
    const node = syntheticBackboneNode(
      resolvedRoot,
      resolvedRoot === "bacteria" ? "Bacteria" : "Archaea",
      resolvedRoot === "bacteria" ? "Bacteria" : "Archaea",
      "domain",
      0
    );
    return {
      root: { ...node, parentId: "luca", children: [], truncatedChildren: 0 },
      nodesUsed: 1,
      maxNodes: nodeLimit,
      status,
      path: [
        syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
        node,
      ],
    };
  }
  const cacheKey = [resolvedRoot, depth, childLimit, nodeLimit, status.mode, status.release || ""].join("|");
  if (subtreeCache.has(cacheKey)) return subtreeCache.get(cacheKey);

  const root = getTaxon(resolvedRoot) || getTaxon(status.rootId) || seedDefinition("animalia");
  if (!root) return null;

  const rootOutput = { ...root, children: [], truncatedChildren: 0 };
  const outputById = new Map([[String(root.id), rootOutput]]);
  let frontier = [root];
  let nodesUsed = 1;

  for (let level = 0; level < depth && frontier.length && nodesUsed < nodeLimit; level += 1) {
    const parents = frontier.filter((node) => Number(node.childCount || 0) > 0);
    if (!parents.length) break;

    const grouped = getChildrenBatch(parents.map((node) => node.id), childLimit);
    const next = [];

    for (const parent of parents) {
      const parentOutput = outputById.get(String(parent.id));
      const children = grouped.get(String(parent.id)) || [];
      const room = Math.max(0, nodeLimit - nodesUsed);
      const acceptedChildren = children.slice(0, room);

      parentOutput.truncatedChildren = Math.max(
        0,
        Number(parent.childCount || 0) - acceptedChildren.length
      );

      for (const child of acceptedChildren) {
        const childOutput = { ...child, children: [], truncatedChildren: 0 };
        parentOutput.children.push(childOutput);
        outputById.set(String(child.id), childOutput);
        next.push(child);
        nodesUsed += 1;
        if (nodesUsed >= nodeLimit) break;
      }
      if (nodesUsed >= nodeLimit) break;
    }

    frontier = next;
  }

  const payload = {
    root: rootOutput,
    nodesUsed,
    maxNodes: nodeLimit,
    status,
    path: backbonePathForAnimalia(getPath(root.id)),
  };
  return cacheSubtree(cacheKey, payload);
}
