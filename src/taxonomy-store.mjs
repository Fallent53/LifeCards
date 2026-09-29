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
    commonName: row.canonical_name || row.scientific_name,
    rank: row.rank || "unranked",
    status: row.status || "accepted",
    extinct: Boolean(row.extinct),
    childCount: Number(row.child_count || 0),
    kind: String(row.rank || "").toLowerCase() === "species" ? "species" : "taxon",
    source: "Catalogue of Life",
    sourceId: String(row.id),
  };
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
      source: "LifeCards seed catalog",
      hint: "Run npm install && npm run sync:col to import Catalogue of Life Animalia.",
    };
  }
  return {
    ready: true,
    mode: "catalogue-of-life",
    databasePath: taxonomyPath,
    taxonCount: Number(metaValue(db, "taxon_count") || 0),
    speciesCount: Number(metaValue(db, "species_count") || 0),
    rootId: metaValue(db, "root_id") || null,
    scope: metaValue(db, "scope") || "Animalia",
    datasetKey: metaValue(db, "dataset_key"),
    release: metaValue(db, "release"),
    importedAt: metaValue(db, "imported_at"),
    source: "Catalogue of Life / ChecklistBank",
  };
}

export function getTaxon(id) {
  const db = openFullDb();
  if (!db) return seedDefinition(String(id));
  const row = db.prepare(`
    SELECT id,parent_id,scientific_name,canonical_name,rank,status,extinct,child_count
    FROM taxa WHERE id = ?
  `).get(String(id));
  return mapRow(row);
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

  const prefix = `${q}%`;
  const contains = `%${q}%`;
  const rows = db.prepare(`
    SELECT id,parent_id,scientific_name,canonical_name,rank,status,extinct,child_count
    FROM taxa
    WHERE scientific_name LIKE ? COLLATE NOCASE
       OR canonical_name LIKE ? COLLATE NOCASE
    ORDER BY
      CASE
        WHEN scientific_name = ? COLLATE NOCASE THEN 0
        WHEN canonical_name = ? COLLATE NOCASE THEN 0
        WHEN scientific_name LIKE ? COLLATE NOCASE THEN 1
        WHEN canonical_name LIKE ? COLLATE NOCASE THEN 1
        ELSE 2
      END,
      LENGTH(scientific_name),
      scientific_name
    LIMIT ?
  `).all(contains, contains, q, q, prefix, prefix, safeLimit);
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
    SELECT id,parent_id,scientific_name,canonical_name,rank,status,extinct,child_count
    FROM taxa
    WHERE parent_id = ?
    ORDER BY child_count DESC, rank, scientific_name
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
      SELECT id,parent_id,scientific_name,canonical_name,rank,status,extinct,child_count
      FROM taxa WHERE id = ?
    `).get(currentId);
    if (!row) break;
    const mapped = mapRow(row);
    path.unshift(mapped);
    currentId = mapped.parentId;
  }
  return path;
}

export function getSubtree(rootId, { depth = 3, childLimit = 48, nodeLimit = 900 } = {}) {
  const status = taxonomyStatus();
  const resolvedRoot = rootId || status.rootId || "animalia";
  const root = getTaxon(resolvedRoot) || getTaxon(status.rootId) || seedDefinition("animalia");
  if (!root) return null;

  let nodesUsed = 1;
  function expand(node, level) {
    const output = { ...node, children: [] };
    if (level >= depth || nodesUsed >= nodeLimit || node.childCount === 0) return output;

    const children = getChildren(node.id, childLimit);
    for (const child of children) {
      if (nodesUsed >= nodeLimit) break;
      nodesUsed += 1;
      output.children.push(expand(child, level + 1));
    }
    output.truncatedChildren = Math.max(0, Number(node.childCount || 0) - output.children.length);
    return output;
  }

  return {
    root: expand(root, 0),
    nodesUsed,
    maxNodes: nodeLimit,
    status,
    path: getPath(root.id),
  };
}
