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

export async function searchCommonsImage(query) {
  const key = String(query || "").trim().toLowerCase();
  if (!key) return null;
  if (memoryCache.has(key)) return memoryCache.get(key);
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "900",
  });
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}`);
  const json = await response.json();
  const pages = Object.values(json?.query?.pages ?? {});
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    if (!info?.thumburl || !acceptedLicense(meta)) continue;
    const result = {
      imageUrl: info.thumburl,
      originalUrl: info.descriptionurl ?? info.url,
      title: page.title,
      creator: cleanHtml(meta.Artist?.value || meta.Credit?.value || "Unknown creator"),
      license: cleanHtml(meta.LicenseShortName?.value || meta.UsageTerms?.value || "See source"),
      licenseUrl: meta.LicenseUrl?.value || info.descriptionurl || null,
      attribution: cleanHtml(meta.Attribution?.value || meta.Credit?.value || meta.Artist?.value || "Wikimedia Commons"),
      source: "Wikimedia Commons",
    };
    memoryCache.set(key, result);
    return result;
  }
  memoryCache.set(key, null);
  return null;
}
