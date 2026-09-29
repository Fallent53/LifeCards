import { byId } from "./catalog.mjs";
import { getExternalCache, setExternalCache } from "./database.mjs";

const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NCBI_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function safeLanguage(value) {
  const lang = String(value || "en").toLowerCase().split("-")[0];
  return /^[a-z]{2,3}$/.test(lang) ? lang : "en";
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "LifeCards/0.1 (scientific enrichment; contact via project repository)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function firstPage(json) {
  const pages = json?.query?.pages;
  if (!pages) return null;
  if (Array.isArray(pages)) return pages.find((page) => !page.missing) ?? null;
  return Object.values(pages).find((page) => !page.missing) ?? null;
}

export function parseWikipediaPage(page, lang = "en") {
  if (!page) return null;
  const canonical = page.canonicalurl || page.fullurl || null;
  return {
    language: safeLanguage(lang),
    title: page.title || null,
    extract: page.extract || null,
    pageUrl: canonical,
    thumbnailUrl: page.thumbnail?.source || null,
    originalImageUrl: page.original?.source || null,
    wikibaseItem: page.pageprops?.wikibase_item || null,
  };
}

async function queryWikipediaTitle(title, lang, options) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "extracts|pageimages|info|pageprops",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail|original",
    pithumbsize: "1200",
    titles: title,
  });
  const json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, options);
  return parseWikipediaPage(firstPage(json), lang);
}

async function searchWikipediaTitle(query, lang, options) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    list: "search",
    srsearch: query,
    srlimit: "1",
    srnamespace: "0",
  });
  const json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, options);
  return json?.query?.search?.[0]?.title || null;
}

export async function fetchWikipedia(definition, { lang = "en", fetchImpl = fetch } = {}) {
  const language = safeLanguage(lang);
  const key = `${language}:${definition.id}`;
  const cached = getExternalCache("wikipedia", key);
  if (cached) return { ...cached.value, cached: true };

  const candidates = [definition.scientificName, definition.commonName]
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);

  let page = null;
  let error = null;

  for (const candidate of candidates) {
    try {
      page = await queryWikipediaTitle(candidate, language, { fetchImpl });
      if (page?.extract || page?.pageUrl) break;
    } catch (cause) {
      error = cause;
    }
  }

  if (!page && candidates[0]) {
    try {
      const title = await searchWikipediaTitle(candidates[0], language, { fetchImpl });
      if (title) page = await queryWikipediaTitle(title, language, { fetchImpl });
    } catch (cause) {
      error = cause;
    }
  }

  // French Wikipedia does not necessarily have every taxon. Fall back to English.
  if (!page && language !== "en") {
    try {
      page = await queryWikipediaTitle(definition.scientificName || definition.commonName, "en", { fetchImpl });
    } catch (cause) {
      error = cause;
    }
  }

  const value = page
    ? { ...page, provider: "Wikipedia", available: true }
    : { provider: "Wikipedia", available: false, language, error: error?.message || null };

  setExternalCache("wikipedia", key, value, page ? WIKI_TTL_MS : 60 * 60 * 1000);
  return value;
}

export function parseNcbiSummary(json, taxId) {
  const id = String(taxId || "");
  const record = json?.result?.[id];
  if (!record) return null;
  return {
    taxId: id,
    scientificName: record.scientificname || record.scientificName || null,
    commonName: record.commonname || record.commonName || null,
    rank: record.rank || null,
    division: record.division || null,
    status: record.status || null,
  };
}

async function ncbiSearchTaxId(definition, options) {
  const term = definition.scientificName || definition.commonName;
  if (!term) return null;
  const params = new URLSearchParams({
    db: "taxonomy",
    term: `"${term}"[Scientific Name]`,
    retmode: "json",
    retmax: "5",
    tool: "lifecards",
  });
  if (process.env.NCBI_API_KEY) params.set("api_key", process.env.NCBI_API_KEY);
  const json = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`,
    options
  );
  return json?.esearchresult?.idlist?.[0] || null;
}

async function ncbiSummary(taxId, options) {
  const params = new URLSearchParams({
    db: "taxonomy",
    id: String(taxId),
    retmode: "json",
    tool: "lifecards",
  });
  if (process.env.NCBI_API_KEY) params.set("api_key", process.env.NCBI_API_KEY);
  const json = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`,
    options
  );
  return parseNcbiSummary(json, taxId);
}

export function lifemapUrl(taxId) {
  if (!taxId) return null;
  return `https://lifemap.cnrs.fr/tree?tool=search&efficiency-mode=false&tid=${encodeURIComponent(String(taxId))}`;
}

export function ncbiTaxonomyUrl(taxId) {
  if (!taxId) return null;
  return `https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${encodeURIComponent(String(taxId))}`;
}

export async function fetchNcbi(definition, { fetchImpl = fetch } = {}) {
  const key = definition.id;
  const cached = getExternalCache("ncbi-taxonomy", key);
  if (cached) return { ...cached.value, cached: true };

  let taxId = definition.ncbiTaxId ? String(definition.ncbiTaxId) : null;
  let record = null;
  let error = null;

  try {
    if (!taxId) taxId = await ncbiSearchTaxId(definition, { fetchImpl });
    if (taxId) record = await ncbiSummary(taxId, { fetchImpl });
  } catch (cause) {
    error = cause;
  }

  const value = taxId
    ? {
        provider: "NCBI Taxonomy",
        available: true,
        ...(record || {}),
        taxId,
        lifemapUrl: lifemapUrl(taxId),
        ncbiUrl: ncbiTaxonomyUrl(taxId),
      }
    : {
        provider: "NCBI Taxonomy",
        available: false,
        taxId: null,
        lifemapUrl: null,
        ncbiUrl: null,
        error: error?.message || null,
      };

  setExternalCache("ncbi-taxonomy", key, value, taxId ? NCBI_TTL_MS : 6 * 60 * 60 * 1000);
  return value;
}

export async function getScientificEnrichment(definitionId, { lang = "en", fetchImpl = fetch } = {}) {
  const definition = byId.get(definitionId);
  if (!definition) throw new Error("Unknown card definition");

  const [wikipedia, ncbi] = await Promise.all([
    fetchWikipedia(definition, { lang, fetchImpl }),
    fetchNcbi(definition, { fetchImpl }),
  ]);

  return {
    definitionId,
    fetchedAt: Date.now(),
    wikipedia,
    ncbi,
    lifemap: {
      available: Boolean(ncbi?.taxId),
      url: ncbi?.lifemapUrl || null,
      note: "LifeCards links to Lifemap using the NCBI Taxonomy ID; Lifemap code/assets are not embedded.",
    },
    provenance: [
      wikipedia?.available
        ? { provider: "Wikipedia", url: wikipedia.pageUrl, role: "overview text" }
        : null,
      ncbi?.available
        ? { provider: "NCBI Taxonomy", url: ncbi.ncbiUrl, role: "taxonomy identifier" }
        : null,
      ncbi?.lifemapUrl
        ? { provider: "Lifemap", url: ncbi.lifemapUrl, role: "external tree explorer" }
        : null,
    ].filter(Boolean),
  };
}
