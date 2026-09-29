import { byId, catalog } from "./catalog.mjs";
import { getGameplayTaxon, pickDropTaxon, taxonomyStatus } from "./taxonomy-store.mjs";

const curatedByScientificName = new Map(
  catalog
    .filter((entry) => entry.scientificName)
    .map((entry) => [String(entry.scientificName).toLowerCase(), entry])
);

function rarityForRank(rank) {
  const value = String(rank || "").toLowerCase().trim();
  if (["species","subspecies","variety","subvariety","form","subform","strain","pathovar","cultivar"].includes(value)) return "COMMON";
  if (["genus","subgenus","section","subsection","series","subseries","species group","species subgroup"].includes(value)) return "UNCOMMON";
  if (["family","subfamily","superfamily","tribe","subtribe","supertribe"].includes(value)) return "RARE";
  if (["order","suborder","superorder","infraorder","parvorder"].includes(value)) return "SUPER_RARE";
  if (["class","subclass","superclass","infraclass","parvclass"].includes(value)) return "ULTRA_RARE";
  if (["phylum","subphylum","superphylum","division","subdivision","superdivision"].includes(value)) return "LEGENDARY";
  if (["kingdom","subkingdom","superkingdom","domain","empire"].includes(value)) return "MYTHIC";
  return "UNCOMMON";
}

function taxonEditionCap(rank) {
  const value = String(rank || "").toLowerCase().trim();
  if (["species","subspecies","variety","subvariety","form","subform","strain","pathovar","cultivar"].includes(value)) return 0;
  if (["genus","subgenus","section","subsection","series","subseries","species group","species subgroup"].includes(value)) return 100000;
  if (["family","subfamily","superfamily","tribe","subtribe","supertribe"].includes(value)) return 50000;
  if (["order","suborder","superorder","infraorder","parvorder"].includes(value)) return 25000;
  if (["class","subclass","superclass","infraclass","parvclass"].includes(value)) return 10000;
  if (["phylum","subphylum","superphylum","division","subdivision","superdivision"].includes(value)) return 5000;
  if (["kingdom","subkingdom","superkingdom"].includes(value)) return 1000;
  if (["domain","empire"].includes(value)) return 250;
  return 75000;
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

function cleanTaxonLabel(value, rank = "") {
  const text=String(value||"").replace(/\s+/g," ").trim();
  if(!text)return text;

  const r=String(rank||"").toLowerCase();
  const hasAuthority=/\b(?:17|18|19|20)\d{2}\b/.test(text);
  if(!hasAuthority)return text;

  if(["species"].includes(r)){
    const match=text.match(/^([A-ZÀ-ÖØ-Þ][\p{L}.-]+(?:\s+\([A-ZÀ-ÖØ-Þ][\p{L}.-]+\))?\s+[a-zà-öø-ÿ][\p{L}.-]+)/u);
    if(match)return match[1];
  }

  if(["subspecies","variety","subvariety","form","subform"].includes(r)){
    const match=text.match(/^([A-ZÀ-ÖØ-Þ][\p{L}.-]+(?:\s+\([A-ZÀ-ÖØ-Þ][\p{L}.-]+\))?\s+[a-zà-öø-ÿ][\p{L}.-]+(?:\s+(?:subsp\.|ssp\.|var\.|f\.)?\s*[a-zà-öø-ÿ][\p{L}.-]+)?)/u);
    if(match)return match[1];
  }

  if(["genus","subgenus"].includes(r)){
    const match=text.match(/^([A-ZÀ-ÖØ-Þ][\p{L}.-]+(?:\s+\([A-ZÀ-ÖØ-Þ][\p{L}.-]+\))?)/u);
    if(match)return match[1];
  }

  const first=text.match(/^([A-ZÀ-ÖØ-Þ][\p{L}.-]+)/u);
  return first?.[1]||text;
}

export function definitionFromTaxon(taxon) {
  if (!taxon) return null;

  const curated =
    curatedByScientificName.get(String(taxon.scientificName || "").toLowerCase()) ||
    curatedByScientificName.get(String(taxon.canonicalName || "").toLowerCase());

  const kind = taxon.kind || (String(taxon.rank).toLowerCase() === "species" ? "species" : "taxon");
  const scientificName = taxon.scientificName || taxon.canonicalName || "Unknown taxon";
  const canonicalName = cleanTaxonLabel(taxon.canonicalName || scientificName, taxon.rank);
  const rawCommonName = String(taxon.commonName || "").trim();
  const commonName = curated?.commonName ||
    (rawCommonName && rawCommonName.toLowerCase() !== String(taxon.scientificName||"").toLowerCase()
      ? cleanTaxonLabel(rawCommonName,taxon.rank)
      : canonicalName);
  const rarity = curated?.rarity || taxon.gameRarity || rarityForRank(taxon.rank);
  const taxonomy = taxonomyStatus();

  return {
    ...(curated || {}),
    id: String(taxon.id),
    taxonomyId: String(taxon.id),
    curatedDefinitionId: curated?.id || null,
    kind,
    scientificName,
    canonicalName,
    commonName,
    parentId: taxon.parentId ? String(taxon.parentId) : null,
    rank: taxon.rank || (kind === "species" ? "species" : "unranked"),
    rarity,
    selectionWeight: 1,
    temporalStatus: taxon.extinct ? "extinct" : "extant",
    editionCap: curated?.editionCap ?? (kind === "taxon" ? taxonEditionCap(taxon.rank) : 0),
    icon: curated?.icon || iconForRank(taxon.rank, kind),
    conservation: curated?.conservation || null,
    mediaQuery: curated?.mediaQuery || canonicalName || scientificName,
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
  return definitionFromTaxon(getGameplayTaxon(String(id)));
}

export function selectImportedDefinition(rarity, rng) {
  const taxon = pickDropTaxon(rarity, rng);
  return taxon ? definitionFromTaxon(taxon) : null;
}
