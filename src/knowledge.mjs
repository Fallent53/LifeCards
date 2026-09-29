import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getCommonsFileMetadata, searchCommonsImage } from "./media.mjs";

const CACHE_TTL_MS = Number(process.env.LIFECARDS_KNOWLEDGE_CACHE_TTL_MS || 90 * 24 * 60 * 60 * 1000);
const CACHE_SCHEMA_VERSION = "v3";
const cache = new Map();
const knowledgeDbPath = resolve(process.env.LIFECARDS_KNOWLEDGE_DB || "./data/knowledge.sqlite");
mkdirSync(dirname(knowledgeDbPath), { recursive: true });
const knowledgeDb = new DatabaseSync(knowledgeDbPath);
knowledgeDb.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS knowledge_cache (
    query TEXT NOT NULL,
    lang TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY(query, lang)
  );
`);

function readPersistentCache(query, lang) {
  try {
    const row = knowledgeDb.prepare(
      "SELECT payload_json, fetched_at FROM knowledge_cache WHERE query = ? AND lang = ?"
    ).get(query, lang);
    if (!row) return null;

    const payload = JSON.parse(row.payload_json);
    const hasMedia = Boolean(payload?.media?.imageUrl);
    const ttl = hasMedia ? CACHE_TTL_MS : Math.min(CACHE_TTL_MS, 24 * 60 * 60 * 1000);
    if (Date.now() - Number(row.fetched_at) >= ttl) return null;

    return payload;
  } catch {
    return null;
  }
}

function writePersistentCache(query, lang, value) {
  try {
    knowledgeDb.prepare(`
      INSERT INTO knowledge_cache(query, lang, payload_json, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(query, lang) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at
    `).run(query, lang, JSON.stringify(value), Date.now());
  } catch {
    // Cache failures must never break gameplay.
  }
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Accept": "application/json",
      "User-Agent": "LifeCards/0.1 (scientific card knowledge resolver)",
    },
  });
  if (!response.ok) throw new Error(`Knowledge source returned ${response.status}`);
  return response.json();
}

function firstPage(query = {}) {
  return Object.values(query.pages ?? {})[0] ?? null;
}

async function wikipediaPage(query, lang = "en") {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    redirects: "1",
    prop: "extracts|pageimages|pageprops|pageterms|info",
    titles: query,
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail|name",
    pithumbsize: "1200",
    wbptterms: "description",
    inprop: "url",
  });
  let json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  let page = firstPage(json.query);
  if (page && !page.missing) return page;

  const search = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    list: "search",
    srsearch: query,
    srlimit: "1",
  });
  json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${search}`);
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;

  params.set("titles", title);
  json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  page = firstPage(json.query);
  return page && !page.missing ? page : null;
}

function claimValue(entity, property) {
  const claim = entity?.claims?.[property]?.[0];
  const value = claim?.mainsnak?.datavalue?.value;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "id" in value) return value.id;
  return null;
}

async function wikidataEntity(qid, lang = "en") {
  if (!qid) return null;
  const params = new URLSearchParams({
    action: "wbgetentities",
    format: "json",
    origin: "*",
    ids: qid,
    props: "claims|labels|descriptions|sitelinks",
    languages: `${lang}|en`,
  });
  const json = await fetchJson(`https://www.wikidata.org/w/api.php?${params}`);
  return json?.entities?.[qid] ?? null;
}

export function lifemapUrlForTaxId(taxId) {
  const safe = String(taxId ?? "").replace(/\D/g, "");
  return safe ? `https://lifemap-ncbi.univ-lyon1.fr/?tid=${safe}` : null;
}

export function ncbiUrlForTaxId(taxId) {
  const safe = String(taxId ?? "").replace(/\D/g, "");
  return safe ? `https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${safe}` : null;
}

export async function getKnowledge(query, { lang = "en" } = {}) {
  const normalized = String(query || "").trim();
  if (!normalized) return null;
  const persistedQuery = `${CACHE_SCHEMA_VERSION}:${normalized.toLowerCase()}`;
  const cacheKey = `${lang}:${persistedQuery}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) return cached.value;

  const persisted = readPersistentCache(persistedQuery, lang);
  if (persisted) {
    cache.set(cacheKey, { storedAt: Date.now(), value: persisted });
    return persisted;
  }

  let page = null;
  try {
    page = await wikipediaPage(normalized, lang);
  } catch {
    page = null;
  }

  const qid = page?.pageprops?.wikibase_item ?? null;
  let entity = null;
  try {
    entity = await wikidataEntity(qid, lang);
  } catch {
    entity = null;
  }

  const taxId = claimValue(entity, "P685");
  const taxonName = claimValue(entity, "P225") || normalized;
  const wikidataImage = claimValue(entity, "P18");
  const description =
    entity?.descriptions?.[lang]?.value ||
    entity?.descriptions?.en?.value ||
    page?.terms?.description?.[0] ||
    null;

  let media = null;
  const mediaAttempts = [
    async () => page?.pageimage ? getCommonsFileMetadata(page.pageimage) : null,
    async () => wikidataImage ? getCommonsFileMetadata(wikidataImage) : null,
    async () => searchCommonsImage(taxonName),
    async () => normalized !== taxonName ? searchCommonsImage(normalized) : null,
  ];
  for (const attempt of mediaAttempts) {
    if (media) break;
    try {
      media = await attempt();
    } catch {
      // A failed provider must not prevent the next fallback.
    }
  }

  const value = {
    query: normalized,
    wikipedia: page
      ? {
          title: page.title,
          extract: page.extract || "",
          description,
          pageUrl: page.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
          thumbnailUrl: page.thumbnail?.source || null,
          pageImage: page.pageimage || null,
          language: lang,
        }
      : null,
    wikidata: qid
      ? {
          id: qid,
          pageUrl: `https://www.wikidata.org/wiki/${qid}`,
          taxonName,
          ncbiTaxId: taxId,
          imageFile: wikidataImage,
        }
      : null,
    taxonomy: {
      ncbiTaxId: taxId,
      ncbiUrl: ncbiUrlForTaxId(taxId),
      lifemapUrl: lifemapUrlForTaxId(taxId),
    },
    media,
    sources: [
      page ? "Wikipedia" : null,
      entity ? "Wikidata" : null,
      media ? "Wikimedia Commons" : null,
      taxId ? "NCBI Taxonomy / Lifemap NCBI" : null,
    ].filter(Boolean),
    sourceStatus: {
      wikipedia: page ? "ok" : "unavailable",
      wikidata: entity ? "ok" : "unavailable",
      media: media ? "ok" : "unavailable",
      lifemap: taxId ? "linked" : "unresolved",
    },
    resolvedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, { storedAt: Date.now(), value });
  writePersistentCache(persistedQuery, lang, value);
  return value;
}
