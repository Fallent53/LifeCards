import { byId, catalog } from "./catalog.mjs";
import { getTaxon, pickDropTaxon, taxonomyStatus } from "./taxonomy-store.mjs";

const curatedByScientificName = new Map(
  catalog
    .filter((entry) => entry.scientificName)
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
  return "COMMON";
}

function taxonEditionCap(rank) {
  const value = String(rank || "").toLowerCase();
  if (["genus", "subgenus"].includes(value)) return 100000;
  if (["family", "subfamily", "superfamily", "tribe", "subtribe"].includes(value)) return 50000;
  if (["order", "suborder", "superorder", "infraorder"].includes(value)) return 25000;
  if (["class", "subclass", "superclass"].includes(value)) return 10000;
  if (["phylum", "subphylum", "superphylum"].includes(value)) return 5000;
  if (value === "kingdom") return 1000;
  if (value === "domain") return 250;
  return 0;
}

function iconForRank(rank, kind) {
  if (kind === "species") return "◉";
  const value = String(rank || "").toLowerCase();
  if (value === "kingdom") return "✦";
  if (value === "phylum") return "◆";
  if (value === "class") return "◈";
  if (value === "order") return "⌘";
  if (value === "family") return "◇";
  if (value === "genus") return "◐";
  return "◎";
}

export function definitionFromTaxon(taxon) {
  if (!taxon) return null;

  const curated =
    curatedByScientificName.get(String(taxon.scientificName || "").toLowerCase()) ||
    curatedByScientificName.get(String(taxon.canonicalName || "").toLowerCase());

  const kind = taxon.kind || (String(taxon.rank).toLowerCase() === "species" ? "species" : "taxon");
  const scientificName = taxon.scientificName || taxon.canonicalName || "Unknown taxon";
  const commonName = curated?.commonName || taxon.commonName || taxon.canonicalName || scientificName;
  const rarity = curated?.rarity || taxon.gameRarity || rarityForRank(taxon.rank);
  const taxonomy = taxonomyStatus();

  return {
    ...(curated || {}),
    id: String(taxon.id),
    taxonomyId: String(taxon.id),
    curatedDefinitionId: curated?.id || null,
    kind,
    scientificName,
    commonName,
    parentId: taxon.parentId ? String(taxon.parentId) : null,
    rank: taxon.rank || (kind === "species" ? "species" : "unranked"),
    rarity,
    selectionWeight: 1,
    temporalStatus: taxon.extinct ? "extinct" : "extant",
    editionCap: curated?.editionCap ?? (kind === "taxon" ? taxonEditionCap(taxon.rank) : 0),
    icon: curated?.icon || iconForRank(taxon.rank, kind),
    conservation: curated?.conservation || null,
    mediaQuery: curated?.mediaQuery || scientificName,
    summary: curated?.summary || (
      kind === "species"
        ? "Catalogue of Life species. Scientific details and media are resolved lazily when viewed."
        : `Catalogue of Life ${taxon.rank || "taxon"} node.`
    ),
    source: taxon.source || "Catalogue of Life",
    taxonomyRelease: taxonomy.release || taxonomy.datasetKey || taxonomy.mode,
    taxonomyImportedAt: taxonomy.importedAt || null,
  };
}

export function resolveDefinition(id) {
  const seed = byId.get(String(id));
  if (seed) return seed;
  return definitionFromTaxon(getTaxon(String(id)));
}

export function selectImportedDefinition(rarity, rng) {
  const taxon = pickDropTaxon(rarity, rng);
  return taxon ? definitionFromTaxon(taxon) : null;
}
