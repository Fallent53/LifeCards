import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { catalog, byId } from "./catalog.mjs";

const gameplayTaxonomyPath = resolve(
  process.env.LIFECARDS_TAXONOMY_DB ?? "./data/eukaryota.sqlite"
);
const mapTaxonomyPath = resolve(
  process.env.LIFECARDS_MAP_TAXONOMY_DB ?? "./data/life.sqlite"
);
const cardQualityPath = resolve(
  process.env.LIFECARDS_CARD_QUALITY_DB ?? "./data/card-quality.sqlite"
);

const openDatabases = new Map();

function openValidatedDb(path) {
  if (openDatabases.has(path)) return openDatabases.get(path);
  if (!existsSync(path)) return null;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON;");

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='taxa'"
    ).get();

    if (!table) {
      db.close();
      return null;
    }

    let schemaVersion = 0;
    try {
      schemaVersion = Number(
        db.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get()?.value || 0
      );
    } catch {
      schemaVersion = 0;
    }

    if (schemaVersion < 4) {
      db.close();
      return null;
    }

    openDatabases.set(path, db);
    return db;
  } catch {
    return null;
  }
}

function openGameplayDb() {
  return openValidatedDb(gameplayTaxonomyPath);
}

function openMapDb() {
  return openValidatedDb(mapTaxonomyPath) || openGameplayDb();
}

let qualityDb = null;
let qualityDbChecked = false;

function openQualityDb() {
  if (qualityDbChecked) return qualityDb;
  qualityDbChecked = true;
  if (!existsSync(cardQualityPath)) return null;

  try {
    const db = new DatabaseSync(cardQualityPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON;");
    if (!tableExists(db, "card_quality") || !tableExists(db, "meta")) {
      db.close();
      return null;
    }
    qualityDb = db;
    return qualityDb;
  } catch {
    return null;
  }
}

function cardQualityStatus() {
  const db = openQualityDb();
  const gameplayDb = openGameplayDb();

  if (!db) {
    return {
      available: false,
      complete: false,
      ready: 0,
      review: 0,
      noImage: 0,
      badData: 0,
      error: 0,
      checked: 0,
      totalDroppable: 0,
      readyPoolActive: false,
    };
  }

  const expectedScope = gameplayDb ? String(metaValue(gameplayDb, "scope") || "") : "";
  const auditedScope = String(metaValue(db, "taxonomy_scope") || "");
  const resolverVersion = String(metaValue(db, "resolver_version") || "");
  const expectedResolver = "v7-wikipedia-commons-metadata-batch";
  const compatible =
    Boolean(expectedScope) &&
    auditedScope.toLowerCase() === expectedScope.toLowerCase() &&
    resolverVersion === expectedResolver;

  let counts = {};
  let totalDroppable = 0;

  if (compatible && gameplayDb && tableExists(gameplayDb, "drop_pool")) {
    try {
      gameplayDb.prepare("ATTACH DATABASE ? AS qualitystatus").run(cardQualityPath);
      try {
        counts = Object.fromEntries(
          gameplayDb.prepare(`
            SELECT q.status,COUNT(*) AS count
            FROM drop_pool p
            JOIN qualitystatus.card_quality q ON q.taxon_id=p.taxon_id
            WHERE q.resolver_version=?
            GROUP BY q.status
          `).all(expectedResolver)
            .map((row) => [String(row.status), Number(row.count)])
        );
        totalDroppable = Number(
          gameplayDb.prepare("SELECT COUNT(*) AS count FROM drop_pool").get()?.count || 0
        );
      } finally {
        gameplayDb.exec("DETACH DATABASE qualitystatus");
      }
    } catch {
      counts = {};
      totalDroppable = 0;
    }
  }

  const complete =
    compatible &&
    metaValue(db, "complete") === "1" &&
    totalDroppable > 0 &&
    Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0) >= totalDroppable;

  const checked = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  const readyPoolActive =
    complete &&
    tableExists(db, "ready_drop_pool") &&
    tableExists(db, "ready_drop_pool_stats");

  return {
    available: true,
    compatible,
    complete,
    ready: counts.READY || 0,
    review: counts.REVIEW || 0,
    noImage: counts.NO_IMAGE || 0,
    badData: counts.BAD_DATA || 0,
    error: counts.ERROR || 0,
    checked,
    totalDroppable,
    readyPoolActive,
    resolverVersion,
    auditedScope,
    databasePath: cardQualityPath,
  };
}

function metaValue(db, key) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  if (!db) return false;
  try {
    return Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name)
    );
  } catch {
    return false;
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
    descendantSpeciesCount: Number(
      row.descendant_species_count ||
      (String(row.rank || "").toLowerCase() === "species" ? 1 : 0)
    ),
    kind: String(row.rank || "").toLowerCase() === "species" ? "species" : "taxon",
    source: "Catalogue of Life",
    sourceId: String(row.id),
    gameRarity: row.game_rarity || row.pool_rarity || null,
  };
}

function selectTaxon(db, id) {
  if (!db || id == null) return null;
  try {
    return mapRow(
      db.prepare(`
        SELECT
          id,parent_id,scientific_name,canonical_name,common_name,
          rank,status,extinct,child_count,descendant_species_count,game_rarity
        FROM taxa
        WHERE id = ?
      `).get(String(id))
    );
  } catch {
    return null;
  }
}

function findTaxonByScientificName(db, scientificName) {
  if (!db) return null;
  try {
    return mapRow(
      db.prepare(`
        SELECT
          id,parent_id,scientific_name,canonical_name,common_name,
          rank,status,extinct,child_count,descendant_species_count,game_rarity
        FROM taxa
        WHERE scientific_name = ? COLLATE NOCASE
           OR canonical_name = ? COLLATE NOCASE
        ORDER BY
          CASE WHEN scientific_name = ? COLLATE NOCASE THEN 0 ELSE 1 END,
          descendant_species_count DESC
        LIMIT 1
      `).get(scientificName, scientificName, scientificName)
    );
  } catch {
    return null;
  }
}

function seedDescendantSpeciesCount(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  const item = byId.get(id);
  if (!item) return 0;
  if (item.kind === "species") return 1;

  return catalog
    .filter((entry) => entry.parentId === id)
    .reduce(
      (sum, child) =>
        sum + seedDescendantSpeciesCount(child.id, new Set(seen)),
      0
    );
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
  return catalog
    .filter((entry) => entry.parentId === id)
    .map((entry) => seedDefinition(entry.id));
}

function rankWeight(rank) {
  const order = {
    domain: 1,
    kingdom: 2,
    phylum: 3,
    class: 4,
    order: 5,
    family: 6,
    genus: 7,
    species: 8,
    subspecies: 9,
  };
  return order[String(rank || "").toLowerCase()] ?? 20;
}

function databaseStatus(db, path) {
  if (!db) return null;

  return {
    databasePath: path,
    taxonCount: Number(metaValue(db, "taxon_count") || 0),
    speciesCount: Number(metaValue(db, "species_count") || 0),
    rootId: metaValue(db, "root_id") || null,
    scope: metaValue(db, "scope") || "unknown",
    datasetKey: metaValue(db, "dataset_key"),
    release: metaValue(db, "release"),
    importedAt: metaValue(db, "imported_at"),
    schemaVersion: metaValue(db, "schema_version") || "legacy",
  };
}

export function taxonomyStatus() {
  const mapDb = openMapDb();
  const gameplayDb = openGameplayDb();

  if (!mapDb) {
    return {
      ready: false,
      mode: "seed",
      databasePath: gameplayTaxonomyPath,
      mapDatabasePath: mapTaxonomyPath,
      dropDatabasePath: gameplayTaxonomyPath,
      taxonCount: catalog.length,
      speciesCount: catalog.filter((x) => x.kind === "species").length,
      rootId: "animalia",
      mapRootId: "luca",
      scope: "seed",
      source: "LifeCards seed catalog",
      fullLifeMap: false,
      dropPoolReady: false,
      dropPool: {},
      cardQuality: cardQualityStatus(),
      hint:
        "Run npm install && npm run sync:col to build the Eukaryota gameplay taxonomy. " +
        "Run npm run sync:map for the optional full-life map.",
    };
  }

  const mapInfo = databaseStatus(
    mapDb,
    mapDb === gameplayDb ? gameplayTaxonomyPath : mapTaxonomyPath
  );
  const dropInfo = databaseStatus(gameplayDb, gameplayTaxonomyPath);

  const hasDropPool =
    Boolean(gameplayDb) &&
    tableExists(gameplayDb, "drop_pool") &&
    tableExists(gameplayDb, "drop_pool_stats");

  const dropPool = hasDropPool
    ? Object.fromEntries(
        gameplayDb
          .prepare("SELECT rarity, card_count FROM drop_pool_stats")
          .all()
          .map((row) => [row.rarity, Number(row.card_count)])
      )
    : {};

  const fullLifeMap =
    Boolean(mapDb) &&
    mapDb !== gameplayDb &&
    String(mapInfo?.scope || "").toLowerCase() === "all";

  return {
    ready: true,
    mode: fullLifeMap ? "catalogue-of-life-full-map" : "catalogue-of-life",
    databasePath: mapInfo.databasePath,
    mapDatabasePath: mapInfo.databasePath,
    dropDatabasePath: dropInfo?.databasePath || gameplayTaxonomyPath,
    taxonCount: mapInfo.taxonCount,
    speciesCount: mapInfo.speciesCount,
    rootId: mapInfo.rootId,
    mapRootId: "luca",
    scope: mapInfo.scope,
    mapScope: mapInfo.scope,
    dropScope: dropInfo?.scope || null,
    datasetKey: mapInfo.datasetKey,
    release: mapInfo.release,
    importedAt: mapInfo.importedAt,
    source: "Catalogue of Life / ChecklistBank",
    schemaVersion: mapInfo.schemaVersion,
    fullLifeMap,
    dropPoolReady: hasDropPool,
    dropPool,
    cardQuality: cardQualityStatus(),
  };
}

export function getTaxon(id) {
  const db = openMapDb();
  if (!db) return seedDefinition(String(id));
  return selectTaxon(db, id);
}

export function getGameplayTaxon(id) {
  const db = openGameplayDb();
  if (!db) return seedDefinition(String(id));
  return selectTaxon(db, id);
}

export function pickDropTaxon(rarity, rng) {
  const db = openGameplayDb();
  if (!db) return null;

  try {
    const quality = cardQualityStatus();
    if (quality.readyPoolActive) {
      const qdb = openQualityDb();
      const stat = qdb
        .prepare("SELECT card_count FROM ready_drop_pool_stats WHERE rarity = ?")
        .get(String(rarity));
      const count = Number(stat?.card_count || 0);
      if (!count) return null;

      const slot =
        (rng?.int ? rng.int(count) : Math.floor(Math.random() * count)) + 1;
      const ready = qdb
        .prepare("SELECT taxon_id FROM ready_drop_pool WHERE rarity = ? AND slot = ? LIMIT 1")
        .get(String(rarity), slot);
      if (!ready?.taxon_id) return null;

      const row = db
        .prepare(`
          SELECT t.*, ? AS pool_rarity
          FROM taxa t
          WHERE t.id = ?
          LIMIT 1
        `)
        .get(String(rarity), String(ready.taxon_id));
      return mapRow(row);
    }

    const stat = db
      .prepare("SELECT card_count FROM drop_pool_stats WHERE rarity = ?")
      .get(String(rarity));
    const count = Number(stat?.card_count || 0);
    if (!count) return null;

    const slot =
      (rng?.int ? rng.int(count) : Math.floor(Math.random() * count)) + 1;

    const row = db
      .prepare(`
        SELECT t.*, p.rarity AS pool_rarity
        FROM drop_pool p
        JOIN taxa t ON t.id = p.taxon_id
        WHERE p.rarity = ? AND p.slot = ?
        LIMIT 1
      `)
      .get(String(rarity), slot);

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

  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

export function searchTaxa(query, limit = 30) {
  const q = String(query || "").trim();
  if (!q) return [];

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const db = openMapDb();

  if (!db) {
    const needle = q.toLowerCase();
    return catalog
      .filter((entry) =>
        [entry.commonName, entry.scientificName, entry.rank, entry.kind].some(
          (value) => String(value || "").toLowerCase().includes(needle)
        )
      )
      .slice(0, safeLimit)
      .map((entry) => seedDefinition(entry.id));
  }

  const fts = ftsQuery(q);
  if (fts) {
    try {
      const rows = db
        .prepare(`
          SELECT
            t.id,t.parent_id,t.scientific_name,t.canonical_name,t.common_name,
            t.rank,t.status,t.extinct,t.child_count,t.descendant_species_count,
            t.game_rarity
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
        `)
        .all(fts, q, q, q, safeLimit);

      if (rows.length) return rows.map(mapRow);
    } catch {
      // Fallback below handles old/incomplete local databases.
    }
  }

  const prefix = `${q}%`;
  const rows = db
    .prepare(`
      SELECT
        id,parent_id,scientific_name,canonical_name,common_name,
        rank,status,extinct,child_count,descendant_species_count,game_rarity
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
        descendant_species_count DESC,
        scientific_name
      LIMIT ?
    `)
    .all(prefix, prefix, prefix, q, q, q, safeLimit);

  return rows.map(mapRow);
}

export function getChildren(id, limit = 120) {
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 120));
  const db = openMapDb();

  if (!db) {
    return seedChildren(String(id))
      .sort(
        (a, b) =>
          rankWeight(a.rank) - rankWeight(b.rank) ||
          a.scientificName.localeCompare(b.scientificName)
      )
      .slice(0, safeLimit);
  }

  const rows = db
    .prepare(`
      SELECT
        id,parent_id,scientific_name,canonical_name,common_name,
        rank,status,extinct,child_count,descendant_species_count,game_rarity
      FROM taxa
      WHERE parent_id = ?
      ORDER BY
        descendant_species_count DESC,
        child_count DESC,
        rank,
        scientific_name
      LIMIT ?
    `)
    .all(String(id), safeLimit);

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

function rawDatabasePath(db, id, maxDepth = 64) {
  const path = [];
  const seen = new Set();
  let currentId = String(id);

  for (
    let i = 0;
    i < maxDepth && currentId && !seen.has(currentId);
    i += 1
  ) {
    seen.add(currentId);
    const mapped = selectTaxon(db, currentId);
    if (!mapped) break;
    path.unshift(mapped);
    currentId = mapped.parentId;
  }

  return path;
}

const EUKARYOTE_KINGDOMS = new Set([
  "animalia",
  "plantae",
  "fungi",
  "chromista",
  "protozoa",
  "protista",
]);

function syntheticBackboneNode(
  id,
  scientificName,
  commonName,
  rank,
  childCount = 0,
  descendantSpeciesCount = 0
) {
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
    descendantSpeciesCount,
    kind: id === "luca" ? "origin" : "taxon",
    source: "LifeCards universal backbone",
    sourceId: id,
  };
}

function normalizeBackbonePath(path) {
  if (!Array.isArray(path) || !path.length) return path || [];

  const names = path.map((node) =>
    String(node.scientificName || "").toLowerCase()
  );

  let domain = null;
  let startIndex = 0;

  const bacteriaIndex = names.indexOf("bacteria");
  const archaeaIndex = names.indexOf("archaea");
  const eukaryotaIndex = names.indexOf("eukaryota");
  const eukaryoteKingdomIndex = names.findIndex((name) =>
    EUKARYOTE_KINGDOMS.has(name)
  );

  if (bacteriaIndex >= 0) {
    domain = syntheticBackboneNode("bacteria", "Bacteria", "Bacteria", "domain");
    startIndex = bacteriaIndex + 1;
  } else if (archaeaIndex >= 0) {
    domain = syntheticBackboneNode("archaea", "Archaea", "Archaea", "domain");
    startIndex = archaeaIndex + 1;
  } else if (eukaryotaIndex >= 0) {
    domain = syntheticBackboneNode(
      "eukaryota",
      "Eukaryota",
      "Eukaryotes",
      "domain"
    );
    startIndex = eukaryotaIndex + 1;
  } else if (eukaryoteKingdomIndex >= 0) {
    domain = syntheticBackboneNode(
      "eukaryota",
      "Eukaryota",
      "Eukaryotes",
      "domain"
    );
    startIndex = eukaryoteKingdomIndex;
  }

  if (!domain) return path;

  return [
    syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
    domain,
    ...path.slice(startIndex),
  ];
}

export function getPath(id, maxDepth = 64) {
  const db = openMapDb();
  if (!db) {
    const path = seedPath(id);
    return normalizeBackbonePath(path);
  }

  return normalizeBackbonePath(rawDatabasePath(db, id, maxDepth));
}

function getChildrenBatch(db, parentIds, childLimit) {
  if (!db) {
    const output = new Map();
    for (const id of parentIds) {
      output.set(
        String(id),
        seedChildren(String(id)).slice(0, childLimit)
      );
    }
    return output;
  }

  const output = new Map(parentIds.map((id) => [String(id), []]));
  const chunkSize = 160;

  for (let offset = 0; offset < parentIds.length; offset += chunkSize) {
    const chunk = parentIds
      .slice(offset, offset + chunkSize)
      .map(String);

    if (!chunk.length) continue;

    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`
        SELECT
          id,parent_id,scientific_name,canonical_name,common_name,
          rank,status,extinct,child_count,descendant_species_count,game_rarity
        FROM (
          SELECT
            t.*,
            ROW_NUMBER() OVER (
              PARTITION BY parent_id
              ORDER BY
                descendant_species_count DESC,
                child_count DESC,
                rank,
                scientific_name
            ) AS rn
          FROM taxa t
          WHERE parent_id IN (${placeholders})
        )
        WHERE rn <= ?
        ORDER BY parent_id, rn
      `)
      .all(...chunk, childLimit);

    for (const row of rows) {
      const mapped = mapRow(row);
      const key = String(mapped.parentId);
      if (!output.has(key)) output.set(key, []);
      output.get(key).push(mapped);
    }
  }

  return output;
}

function buildDatabaseSubtree(
  root,
  status,
  db,
  { depth = 3, childLimit = 48, nodeLimit = 900 } = {}
) {
  const rootOutput = {
    ...root,
    children: [],
    truncatedChildren: 0,
  };
  const outputById = new Map([[String(root.id), rootOutput]]);
  let frontier = [root];
  let nodesUsed = 1;

  for (
    let level = 0;
    level < depth && frontier.length && nodesUsed < nodeLimit;
    level += 1
  ) {
    const parents = frontier.filter(
      (node) => Number(node.childCount || 0) > 0
    );
    if (!parents.length) break;

    const grouped = getChildrenBatch(
      db,
      parents.map((node) => node.id),
      childLimit
    );
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
        const childOutput = {
          ...child,
          children: [],
          truncatedChildren: 0,
        };
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

  return {
    root: rootOutput,
    nodesUsed,
    maxNodes: nodeLimit,
    status,
  };
}

function domainSource(db, domainId) {
  const scientificName =
    domainId === "bacteria"
      ? "Bacteria"
      : domainId === "archaea"
        ? "Archaea"
        : "Eukaryota";

  const exact = findTaxonByScientificName(db, scientificName);
  if (exact) return { exact: true, roots: [exact] };

  if (domainId === "eukaryota") {
    const names = [
      "Animalia",
      "Plantae",
      "Fungi",
      "Chromista",
      "Protozoa",
      "Protista",
    ];
    const roots = names
      .map((name) => findTaxonByScientificName(db, name))
      .filter(Boolean);

    if (roots.length) return { exact: false, roots };
  }

  return { exact: false, roots: [] };
}

function buildSyntheticDomain(
  domainId,
  status,
  db,
  { depth = 3, childLimit = 48, nodeLimit = 900 } = {}
) {
  const commonName =
    domainId === "eukaryota"
      ? "Eukaryotes"
      : domainId === "bacteria"
        ? "Bacteria"
        : "Archaea";

  const scientificName =
    domainId === "eukaryota"
      ? "Eukaryota"
      : domainId === "bacteria"
        ? "Bacteria"
        : "Archaea";

  const source = domainSource(db, domainId);

  let domain = syntheticBackboneNode(
    domainId,
    scientificName,
    commonName,
    "domain",
    0,
    0
  );
  domain.parentId = "luca";
  domain.children = [];
  domain.truncatedChildren = 0;

  let nodesUsed = 1;

  if (source.exact && source.roots[0]) {
    const actual = source.roots[0];
    domain.childCount = actual.childCount;
    domain.descendantSpeciesCount = actual.descendantSpeciesCount;

    if (depth > 0) {
      const payload = buildDatabaseSubtree(
        actual,
        status,
        db,
        {
          depth,
          childLimit,
          nodeLimit,
        }
      );
      domain.children = payload.root.children;
      domain.truncatedChildren = payload.root.truncatedChildren;
      nodesUsed += Math.max(0, payload.nodesUsed - 1);
    }

    return { root: domain, nodesUsed };
  }

  const fallbackRoots =
    source.roots.length
      ? source.roots
      : domainId === "eukaryota"
        ? [
            findTaxonByScientificName(db, "Animalia") ||
              seedDefinition("animalia"),
          ].filter(Boolean)
        : [];

  domain.childCount = fallbackRoots.length;
  domain.descendantSpeciesCount = fallbackRoots.reduce(
    (sum, root) => sum + Number(root.descendantSpeciesCount || 0),
    0
  );

  if (depth <= 0) return { root: domain, nodesUsed };

  const perRootBudget = Math.max(
    20,
    Math.floor((nodeLimit - 1) / Math.max(1, fallbackRoots.length))
  );

  for (const root of fallbackRoots) {
    const payload = buildDatabaseSubtree(
      root,
      status,
      db,
      {
        depth: Math.max(0, depth - 1),
        childLimit,
        nodeLimit: perRootBudget,
      }
    );

    domain.children.push(payload.root);
    nodesUsed += payload.nodesUsed;
  }

  return { root: domain, nodesUsed };
}

function buildUniversalSubtree(
  status,
  db,
  { depth = 4, childLimit = 48, nodeLimit = 900 } = {}
) {
  const luca = {
    ...syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
    children: [],
    truncatedChildren: 0,
  };

  const domainBudget = Math.max(30, Math.floor((nodeLimit - 1) / 3));

  for (const domainId of ["bacteria", "archaea", "eukaryota"]) {
    const branch = buildSyntheticDomain(
      domainId,
      status,
      db,
      {
        depth: Math.max(0, depth - 1),
        childLimit,
        nodeLimit: domainBudget,
      }
    );
    luca.children.push(branch.root);
  }

  luca.descendantSpeciesCount = luca.children.reduce(
    (sum, child) => sum + Number(child.descendantSpeciesCount || 0),
    0
  );

  const nodesUsed =
    1 +
    luca.children.reduce((sum, child) => {
      const count = (() => {
        let total = 0;
        const stack = [child];
        while (stack.length) {
          const node = stack.pop();
          total += 1;
          stack.push(...(node.children || []));
        }
        return total;
      })();
      return sum + count;
    }, 0);

  return {
    root: luca,
    nodesUsed,
    maxNodes: nodeLimit,
    status,
    path: [
      syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
    ],
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

export function getSubtree(
  rootId,
  { depth = 3, childLimit = 48, nodeLimit = 900 } = {}
) {
  const status = taxonomyStatus();
  const db = openMapDb();
  const resolvedRoot =
    rootId || status.mapRootId || status.rootId || "luca";

  const cacheKey = [
    resolvedRoot,
    depth,
    childLimit,
    nodeLimit,
    status.mode,
    status.release || "",
    status.mapDatabasePath || "",
  ].join("|");

  if (subtreeCache.has(cacheKey)) {
    return subtreeCache.get(cacheKey);
  }

  if (resolvedRoot === "luca") {
    return cacheSubtree(
      cacheKey,
      buildUniversalSubtree(status, db, {
        depth,
        childLimit,
        nodeLimit,
      })
    );
  }

  if (["bacteria", "archaea", "eukaryota"].includes(resolvedRoot)) {
    const branch = buildSyntheticDomain(
      resolvedRoot,
      status,
      db,
      {
        depth,
        childLimit,
        nodeLimit,
      }
    );

    return cacheSubtree(cacheKey, {
      root: branch.root,
      nodesUsed: branch.nodesUsed,
      maxNodes: nodeLimit,
      status,
      path: [
        syntheticBackboneNode("luca", "LUCA", "LUCA", "origin", 3),
        syntheticBackboneNode(
          resolvedRoot,
          resolvedRoot === "eukaryota"
            ? "Eukaryota"
            : resolvedRoot === "bacteria"
              ? "Bacteria"
              : "Archaea",
          resolvedRoot === "eukaryota"
            ? "Eukaryotes"
            : resolvedRoot === "bacteria"
              ? "Bacteria"
              : "Archaea",
          "domain"
        ),
      ],
    });
  }

  const root =
    selectTaxon(db, resolvedRoot) ||
    selectTaxon(db, status.rootId) ||
    seedDefinition("animalia");

  if (!root) return null;

  const payload = buildDatabaseSubtree(
    root,
    status,
    db,
    {
      depth,
      childLimit,
      nodeLimit,
    }
  );

  payload.path = getPath(root.id);

  return cacheSubtree(cacheKey, payload);
}
