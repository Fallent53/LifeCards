const ACCEPTED_LICENSE_MARKERS = ["cc by", "cc-by", "cc0", "public domain", "pd-"];
const memoryCache = new Map();

function cleanHtml(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function acceptedLicense(metadata = {}) {
  const raw = [metadata.LicenseShortName?.value, metadata.License?.value, metadata.UsageTerms?.value]
    .filter(Boolean).join(" ").toLowerCase();
  return ACCEPTED_LICENSE_MARKERS.some((marker) => raw.includes(marker));
}

function mediaFromPage(page) {
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
    source: "Wikimedia Commons",
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

export async function searchCommonsImage(query) {
  const key = `search:${String(query || "").trim().toLowerCase()}`;
  if (key === "search:") return null;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: String(query),
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiextmetadatafilter: "Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth: "1200",
  });

  const json = await commonsQuery(params);
  const pages = Object.values(json?.query?.pages ?? {});
  for (const page of pages) {
    const result = mediaFromPage(page);
    if (!result) continue;
    memoryCache.set(key, result);
    return result;
  }

  memoryCache.set(key, null);
  return null;
}
