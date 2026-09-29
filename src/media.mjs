import crypto from "node:crypto";
const ACCEPTED_LICENSE_MARKERS = ["cc by", "cc-by", "cc0", "public domain", "pd-"];
const memoryCache = new Map();

function cleanHtml(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function acceptedLicense(metadata = {}) {
  const raw = [metadata.LicenseShortName?.value, metadata.License?.value, metadata.UsageTerms?.value]
    .filter(Boolean).join(" ").toLowerCase();

  const disallowed = [
    "cc by-nc", "cc-by-nc", "noncommercial", "non-commercial",
    "cc by-nd", "cc-by-nd", "no derivatives", "noderivatives",
  ];
  if (disallowed.some((marker) => raw.includes(marker))) return false;

  return ACCEPTED_LICENSE_MARKERS.some((marker) => raw.includes(marker));
}

function mediaFromPage(page, sourceLabel = "Wikimedia Commons") {
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata ?? {};
  if (!info?.thumburl || !acceptedLicense(meta)) return null;
  return {
    imageUrl: info.thumburl,
    originalUrl: info.descriptionurl ?? info.url,
    title: page.title,
    creator: cleanHtml(meta.Artist?.value || meta.Credit?.value || "Unknown creator"),
    license: cleanHtml(meta.LicenseShortName?.value || meta.UsageTerms?.value || "See source"),
    licenseUrl: meta.LicenseUrl?.value || info.descriptionurl || null,
    attribution: cleanHtml(meta.Attribution?.value || meta.Credit?.value || meta.Artist?.value || "Wikimedia Commons"),
    source: sourceLabel,
  };
}

async function commonsQuery(params) {
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    signal: AbortSignal.timeout(3500),
    headers: { "User-Agent": "LifeCards/0.1 (licensed media resolver)" },
  });
  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}`);
  return response.json();
}

async function wikipediaFileQuery(lang, params) {
  const safeLang=String(lang||"en").replace(/[^a-z-]/gi,"").slice(0,12)||"en";
  const response=await fetch(`https://${safeLang}.wikipedia.org/w/api.php?${params}`,{
    signal:AbortSignal.timeout(3500),
    headers:{"User-Agent":"LifeCards/0.1 (licensed Wikipedia media resolver)"},
  });
  if(!response.ok)throw new Error(`Wikipedia returned ${response.status}`);
  return response.json();
}

export async function getWikipediaFileMetadata(fileName, lang = "en") {
  const normalized=String(fileName||"").replace(/^File:/i,"").trim();
  if(!normalized)return null;
  const key=`wiki-file:${lang}:${normalized.toLowerCase()}`;
  if(memoryCache.has(key))return memoryCache.get(key);

  const params=new URLSearchParams({
    action:"query",
    format:"json",
    origin:"*",
    titles:`File:${normalized}`,
    prop:"imageinfo",
    iiprop:"url|extmetadata",
    iiextmetadatafilter:"Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth:"1200",
  });

  const json=await wikipediaFileQuery(lang,params);
  const page=Object.values(json?.query?.pages??{})[0]??null;
  const result=mediaFromPage(page,`Wikipedia (${lang})`);
  memoryCache.set(key,result);
  return result;
}

export async function getCommonsFileMetadata(fileName) {
  const normalized = String(fileName || "").replace(/^File:/i, "").trim();
  if (!normalized) return null;
  const key = `file:${normalized.toLowerCase()}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    titles: `File:${normalized}`,
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiextmetadatafilter: "Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth: "1200",
  });

  const json = await commonsQuery(params);
  const page = Object.values(json?.query?.pages ?? {})[0] ?? null;
  const result = mediaFromPage(page);
  memoryCache.set(key, result);
  return result;
}

export async function searchCommonsImage(query, { exact = false } = {}) {
  const normalized=String(query || "").trim();
  const key = `search:${exact?"exact:":"broad:"}${normalized.toLowerCase()}`;
  if (!normalized) return null;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const searchExpression = exact ? `intitle:"${normalized.replaceAll('"', '')}"` : normalized;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: searchExpression,
    gsrnamespace: "6",
    gsrlimit: exact ? "12" : "6",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiextmetadatafilter: "Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth: "1200",
  });

  const json = await commonsQuery(params);
  const pages = Object.values(json?.query?.pages ?? {});
  const needle=normalized.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  for (const page of pages) {
    if(exact){
      const title=String(page.title||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
      if(!needle.split(/\s+/).every(token=>title.includes(token)))continue;
    }
    const result = mediaFromPage(page);
    if (!result) continue;
    memoryCache.set(key, result);
    return result;
  }

  memoryCache.set(key, null);
  return null;
}


function acceptedGbifMediaLicense(value = "") {
  const license = String(value).trim().toLowerCase();
  if (!license) return false;
  if (license.includes("creativecommons.org/publicdomain") || license.includes("creativecommons.org/zero") || license === "cc0") return true;
  if (license.includes("creativecommons.org/licenses/by/") || license.includes("creativecommons.org/licenses/by-sa/")) return true;
  if (/^cc\s*by(?:-sa)?(?:\s|$)/i.test(String(value))) return true;
  return false;
}

function gbifImageUrl(recordKey, identifier) {
  if (!recordKey || !identifier) return identifier || null;
  const hash = crypto.createHash("md5").update(String(identifier)).digest("hex");
  return `https://api.gbif.org/v1/image/cache/800x/occurrence/${recordKey}/media/${hash}`;
}

export async function searchGbifImage(scientificName) {
  const query = String(scientificName || "").trim();
  if (!query) return null;

  const key = `gbif:${query.toLowerCase()}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const params = new URLSearchParams({
    scientificName: query,
    mediaType: "StillImage",
    occurrenceStatus: "present",
    limit: "30",
  });

  const response = await fetch(`https://api.gbif.org/v1/occurrence/search?${params}`, {
    signal: AbortSignal.timeout(4500),
    headers: { "User-Agent": "LifeCards/0.1 (licensed media fallback)" },
  });
  if (!response.ok) throw new Error(`GBIF returned ${response.status}`);
  const json = await response.json();

  const canonical = query.toLowerCase().replace(/\s+/g," ").trim();
  for (const occurrence of json?.results ?? []) {
    const occurrenceName=String(occurrence.species||occurrence.scientificName||"").toLowerCase().replace(/\s+/g," ").trim();
    if(!occurrenceName.startsWith(canonical))continue;
    for (const item of occurrence.media ?? []) {
      const identifier = item.identifier || item.references;
      const license = item.license || "";
      if (!identifier || !acceptedGbifMediaLicense(license)) continue;

      const result = {
        imageUrl: gbifImageUrl(occurrence.key, identifier),
        originalUrl: item.references || identifier,
        title: occurrence.scientificName || query,
        creator: cleanHtml(item.creator || occurrence.recordedBy || "Unknown creator"),
        license: cleanHtml(license),
        licenseUrl: /^https?:/i.test(license) ? license : null,
        attribution: cleanHtml(item.rightsHolder || item.creator || occurrence.datasetTitle || "GBIF occurrence media"),
        source: "GBIF occurrence media",
        occurrenceKey: occurrence.key || null,
      };
      memoryCache.set(key, result);
      return result;
    }
  }

  memoryCache.set(key, null);
  return null;
}
