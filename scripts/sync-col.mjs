import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import unzipper from "unzipper";
import { parse } from "csv-parse";
import { catalog } from "../src/catalog.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) {
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) args.set(key, inline);
    else if (process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) args.set(key, process.argv[++i]);
    else args.set(key, "true");
  }
}

const datasetKey = String(args.get("dataset") || process.env.COL_DATASET_KEY || "latest-base");
const scope = String(args.get("scope") || process.env.COL_SCOPE || "Animalia");
const outputPath = resolve(args.get("output") || process.env.LIFECARDS_TAXONOMY_DB || "./data/animalia.sqlite");
const archivePath = resolve(args.get("archive") || `./data/col-${datasetKey}-dwca.zip`);
const keepArchive = args.get("keep-archive") !== "false" && process.env.COL_KEEP_ARCHIVE !== "0";
const refreshArchive = args.get("refresh") === "true" || process.env.COL_REFRESH === "1";
const customUrl = args.get("url") || process.env.COL_DWCA_URL;
const mapOnly = args.get("map-only") === "true" || process.env.COL_MAP_ONLY === "1";
const sourceUrl = customUrl || (
  datasetKey === "latest-base"
    ? "https://download.checklistbank.org/col/latest_dwca.zip"
    : `https://api.checklistbank.org/dataset/${encodeURIComponent(datasetKey)}/archive`
);

const curatedByScientificName = new Map(
  catalog.filter((entry) => entry.scientificName)
    .map((entry) => [String(entry.scientificName).toLowerCase(), entry])
);

function rarityForRank(rank) {
  const value = String(rank || "").toLowerCase();
  if (value === "species") return "COMMON";
  if (["genus", "subgenus"].includes(value)) return "UNCOMMON";
  if (["family", "subfamily", "superfamily", "tribe", "subtribe"].includes(value)) return "RARE";
  if (["order", "suborder", "superorder", "infraorder"].includes(value)) return "SUPER_RARE";
  if (["class", "subclass", "superclass"].includes(value)) return "ULTRA_RARE";
  if (["phylum", "subphylum", "superphylum"].includes(value)) return "LEGENDARY";
  if (["kingdom", "domain"].includes(value)) return "MYTHIC";
  return null;
}

function gameRarity(scientificName, canonicalName, rank) {
  const curated =
    curatedByScientificName.get(String(scientificName || "").toLowerCase()) ||
    curatedByScientificName.get(String(canonicalName || "").toLowerCase());
  return curated?.rarity || rarityForRank(rank);
}

await mkdir(dirname(outputPath), { recursive: true });

async function downloadArchive() {
  if (!refreshArchive && existsSync(archivePath)) {
    const info = await stat(archivePath);
    if (info.size > 1024 * 1024) {
      console.log(`Using cached archive ${archivePath} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
      console.log("Use --refresh to download a newer Catalogue of Life snapshot.");
      return;
    }
  }
  console.log(`Downloading Catalogue of Life source ${datasetKey}…`);
  console.log(sourceUrl);
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    headers: { "User-Agent": "LifeCards/0.1 (Catalogue of Life importer)" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Catalogue of Life download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));
  const info = await stat(archivePath);
  console.log(`Downloaded ${(info.size / 1024 / 1024).toFixed(1)} MB`);
}

function normalizeKey(key = "") {
  return String(key).trim().split(/[\/#]/).at(-1).replace(/^dwc:/i, "").toLowerCase();
}

function normalizedRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) out[normalizeKey(key)] = value;
  return out;
}

function pick(row, ...keys) {
  for (const key of keys) {
    const value = row[String(key).toLowerCase()];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function acceptedRow(row) {
  const status = pick(row, "taxonomicstatus", "status").toLowerCase();
  const taxonId = pick(row, "taxonid", "nameusageid", "id");
  const accepted = pick(row, "acceptednameusageid");
  if (accepted && accepted !== taxonId) return false;
  if (/(synonym|misapplied|ambiguous|unresolved|excluded)/i.test(status)) return false;
  return true;
}

function inScope(row) {
  if (scope.toLowerCase() === "all") return true;
  const kingdom = pick(row, "kingdom");
  const scientific = pick(row, "scientificname", "canonicalname");
  return kingdom.toLowerCase() === scope.toLowerCase() || scientific.toLowerCase() === scope.toLowerCase();
}

function boolExtinct(value) {
  return /^(1|true|yes|extinct)$/i.test(String(value || "").trim()) ? 1 : 0;
}

await downloadArchive();
await rm(outputPath, { force: true });

const db = new DatabaseSync(outputPath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=OFF;
  PRAGMA temp_store=MEMORY;
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE taxa (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    scientific_name TEXT NOT NULL,
    canonical_name TEXT,
    common_name TEXT,
    common_name_priority INTEGER NOT NULL DEFAULT -1,
    authorship TEXT,
    rank TEXT,
    status TEXT,
    extinct INTEGER NOT NULL DEFAULT 0,
    kingdom TEXT,
    source_dataset TEXT,
    game_rarity TEXT,
    drop_eligible INTEGER NOT NULL DEFAULT 0,
    child_count INTEGER NOT NULL DEFAULT 0,
    descendant_species_count INTEGER NOT NULL DEFAULT 0
  );
`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO taxa
    (id,parent_id,scientific_name,canonical_name,authorship,rank,status,extinct,kingdom,source_dataset,game_rarity,drop_eligible)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);

let accepted = 0;
let species = 0;
let seen = 0;
let rootId = null;
let headerChecked = false;

db.exec("BEGIN");
try {
  const directory = await unzipper.Open.file(archivePath);
  const taxonEntry = directory.files.find((entry) => /(^|\/)taxon\.txt$/i.test(entry.path));
  if (!taxonEntry) throw new Error("DwCA archive does not contain taxon.txt");

  const parser = taxonEntry.stream().pipe(parse({
    columns: true,
    delimiter: "\t",
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
    skip_empty_lines: true,
  }));

  for await (const raw of parser) {
    seen += 1;
    const row = normalizedRecord(raw);

    if (!headerChecked) {
      headerChecked = true;
      const scientific = pick(row, "scientificname", "canonicalname");
      const id = pick(row, "taxonid", "nameusageid", "id");
      if (!scientific || !id) {
        throw new Error("Unsupported DwCA taxon.txt header: scientificName/taxonID were not found.");
      }
    }

    if (!acceptedRow(row) || !inScope(row)) continue;

    const id = pick(row, "taxonid", "nameusageid", "id");
    const parentId = pick(row, "parentnameusageid", "parentid") || null;
    const scientificName = pick(row, "scientificname", "canonicalname");
    const canonicalName = pick(row, "canonicalname") || scientificName;
    const authorship = pick(row, "scientificnameauthorship", "authorship");
    const rank = pick(row, "taxonrank", "rank").toLowerCase();
    const status = pick(row, "taxonomicstatus", "status") || "accepted";
    const extinct = boolExtinct(pick(row, "extinct"));
    const kingdom = pick(row, "kingdom");
    const sourceDataset = pick(row, "datasetid", "sourceid");
    const rarity = mapOnly ? null : gameRarity(scientificName, canonicalName, rank);
    const dropEligible = !mapOnly && rarity ? 1 : 0;

    if (!id || !scientificName) continue;

    insert.run(id, parentId, scientificName, canonicalName, authorship, rank, status, extinct, kingdom, sourceDataset, rarity, dropEligible);
    accepted += 1;
    if (rank === "species") species += 1;
    if (scientificName.toLowerCase() === scope.toLowerCase() && (!rootId || rank === "kingdom")) rootId = id;

    if (accepted % 50000 === 0) {
      db.exec("COMMIT; BEGIN");
      console.log(`Imported ${accepted.toLocaleString()} accepted taxa (${species.toLocaleString()} species)…`);
    }
  }
  db.exec("COMMIT");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  db.close();
  throw error;
}

console.log("Importing vernacular names when available…");
try {
  const directory = await unzipper.Open.file(archivePath);
  const vernacularEntry = directory.files.find((entry) => /(^|\/)(vernacular(name)?|commonname).*\.txt$/i.test(entry.path));
  if (vernacularEntry) {
    const updateCommon = db.prepare(`
      UPDATE taxa
      SET common_name = ?, common_name_priority = ?
      WHERE id = ? AND ? > common_name_priority
    `);
    let namesApplied = 0;
    db.exec("BEGIN");
    const parser = vernacularEntry.stream().pipe(parse({
      columns: true,
      delimiter: "\t",
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
      skip_empty_lines: true,
    }));
    for await (const raw of parser) {
      const row = normalizedRecord(raw);
      const taxonId = pick(row, "taxonid", "nameusageid", "id");
      const name = pick(row, "vernacularname", "commonname", "name");
      const language = pick(row, "language", "languagecode").toLowerCase();
      if (!taxonId || !name) continue;
      const priority = /^(en|eng|english)/.test(language) ? 3
        : /^(fr|fra|fre|french)/.test(language) ? 2
        : language ? 0 : 1;
      const result = updateCommon.run(name, priority, taxonId, priority);
      if (Number(result.changes || 0) > 0) namesApplied += 1;
      if (namesApplied && namesApplied % 50000 === 0) {
        db.exec("COMMIT; BEGIN");
        console.log(`Applied ${namesApplied.toLocaleString()} vernacular names…`);
      }
    }
    db.exec("COMMIT");
    console.log(`Applied ${namesApplied.toLocaleString()} preferred vernacular names.`);
  } else {
    console.log("No vernacular-name extension found; scientific names remain searchable.");
  }
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  console.warn(`Vernacular-name import skipped: ${error.message}`);
}

console.log("Building indexes and child counts…");
db.exec(`
  CREATE INDEX taxa_parent_idx ON taxa(parent_id);
  CREATE INDEX taxa_scientific_idx ON taxa(scientific_name COLLATE NOCASE);
  CREATE INDEX taxa_canonical_idx ON taxa(canonical_name COLLATE NOCASE);
  CREATE INDEX taxa_common_idx ON taxa(common_name COLLATE NOCASE);
  CREATE INDEX taxa_rank_idx ON taxa(rank);
  CREATE VIRTUAL TABLE taxa_fts USING fts5(
    id UNINDEXED,
    scientific_name,
    canonical_name,
    common_name,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO taxa_fts(id, scientific_name, canonical_name, common_name)
    SELECT id, scientific_name, COALESCE(canonical_name,''), COALESCE(common_name,'')
    FROM taxa;
  CREATE TEMP TABLE child_counts AS
    SELECT parent_id AS id, COUNT(*) AS c
    FROM taxa
    WHERE parent_id IS NOT NULL
    GROUP BY parent_id;
  CREATE INDEX child_counts_id_idx ON child_counts(id);
  UPDATE taxa
  SET child_count = COALESCE((SELECT c FROM child_counts WHERE child_counts.id = taxa.id), 0);
  DROP TABLE child_counts;

  ${mapOnly ? "" : `
  CREATE TABLE drop_pool (
    rarity TEXT NOT NULL,
    slot INTEGER NOT NULL,
    taxon_id TEXT NOT NULL,
    PRIMARY KEY (rarity, slot),
    UNIQUE (taxon_id)
  );
  INSERT INTO drop_pool(rarity, slot, taxon_id)
  SELECT game_rarity,
         ROW_NUMBER() OVER (PARTITION BY game_rarity ORDER BY id),
         id
  FROM taxa
  WHERE drop_eligible = 1 AND game_rarity IS NOT NULL;

  CREATE TABLE drop_pool_stats (
    rarity TEXT PRIMARY KEY,
    card_count INTEGER NOT NULL
  );
  INSERT INTO drop_pool_stats(rarity, card_count)
  SELECT rarity, COUNT(*)
  FROM drop_pool
  GROUP BY rarity;

  CREATE INDEX drop_pool_taxon_idx ON drop_pool(taxon_id);
  ` : ""}
`);

console.log("Calculating descendant species counts for radial map weighting…");
db.exec(`
  CREATE TEMP TABLE species_counts (
    id TEXT PRIMARY KEY,
    species_count INTEGER NOT NULL
  );

  INSERT INTO species_counts(id, species_count)
  WITH RECURSIVE lineage(species_id, ancestor_id) AS (
    SELECT id, parent_id
    FROM taxa
    WHERE rank = 'species' AND parent_id IS NOT NULL

    UNION ALL

    SELECT lineage.species_id, parent.parent_id
    FROM lineage
    JOIN taxa parent ON parent.id = lineage.ancestor_id
    WHERE parent.parent_id IS NOT NULL
  )
  SELECT ancestor_id, COUNT(*)
  FROM lineage
  WHERE ancestor_id IS NOT NULL
  GROUP BY ancestor_id;

  UPDATE taxa
  SET descendant_species_count =
    CASE
      WHEN rank = 'species' THEN 1
      ELSE COALESCE(
        (SELECT species_count FROM species_counts WHERE species_counts.id = taxa.id),
        0
      )
    END;

  CREATE INDEX taxa_descendant_species_idx ON taxa(descendant_species_count DESC);
  DROP TABLE species_counts;
`);

if (!rootId && scope.toLowerCase() !== "all") {
  rootId = db.prepare("SELECT id FROM taxa WHERE scientific_name = ? COLLATE NOCASE ORDER BY rank='kingdom' DESC LIMIT 1").get(scope)?.id ?? null;
}
if (!rootId) {
  rootId = db.prepare("SELECT id FROM taxa WHERE parent_id IS NULL ORDER BY child_count DESC LIMIT 1").get()?.id ?? null;
}

const setMeta = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
const release = `ChecklistBank dataset ${datasetKey}`;
for (const [key, value] of Object.entries({
  dataset_key: datasetKey,
  release,
  scope,
  source_url: sourceUrl,
  imported_at: new Date().toISOString(),
  taxon_count: String(accepted),
  species_count: String(species),
  scanned_rows: String(seen),
  root_id: String(rootId || ""),
  schema_version: "4",
  map_only: mapOnly ? "1" : "0",
})) setMeta.run(key, value);

db.exec("PRAGMA optimize;");
db.close();

if (!keepArchive) await rm(archivePath, { force: true });

console.log("");
console.log("Catalogue of Life import complete.");
console.log(`Scope: ${scope}`);
console.log(`Accepted taxa: ${accepted.toLocaleString()}`);
console.log(`Species: ${species.toLocaleString()}`);
console.log(`Database: ${outputPath}`);
console.log(`Root taxon id: ${rootId}`);
console.log(`Mode: ${mapOnly ? "map-only taxonomy" : "gameplay taxonomy + drop pools"}`);
