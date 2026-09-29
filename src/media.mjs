import { getExternalCache, setExternalCache } from "./database.mjs";
const ACCEPTED_LICENSE_MARKERS = ["cc by", "cc-by", "cc0", "public domain", "pd-"];
const memoryCache = new Map();
const MEDIA_CACHE_PROVIDER = "commons-media-v2";

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

  const persisted = getExternalCache(MEDIA_CACHE_PROVIDER, key);
  if (persisted) {
    memoryCache.set(key, persisted.value);
    return persisted.value;
  }
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "16",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "900",
  });
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    signal: AbortSignal.timeout(3000),
    headers: { "User-Agent": "LifeCards/0.1 (image metadata lookup)" },
  });
  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}`);
  const json = await response.json();
  const pages = Object.values(json?.query?.pages ?? {});
  const queryTokens = key.split(/\\s+/).filter((token) => token.length > 2);
  const avoid = ["map", "range", "distribution", "logo", "icon", "diagram", "coat of arms", "flag", "phylogeny", "cladogram"];

  const candidates = pages.flatMap((page) => {
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    if (!info?.thumburl || !acceptedLicense(meta)) return [];
    if (info.mime && !["image/jpeg", "image/png", "image/webp"].includes(info.mime)) return [];

    const title = String(page.title || "").toLowerCase();
    const description = cleanHtml(meta.ImageDescription?.value || "").toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      if (title.includes(token)) score += 5;
      if (description.includes(token)) score += 2;
    }

    if (info.mime === "image/jpeg") score += 4;
    if (Number(info.width) >= 1200 && Number(info.height) >= 700) score += 3;
    if (Number(info.width) >= 800 && Number(info.height) >= 500) score += 1;
    if (avoid.some((word) => title.includes(word))) score -= 12;

    return [{ page, info, meta, score }];
  }).sort((a, b) => b.score - a.score);

  const selected = candidates[0];
  if (selected) {
    const { page, info, meta } = selected;
    const result = {
      imageUrl: info.thumburl,
      originalUrl: info.descriptionurl ?? info.url,
      title: page.title,
      creator: cleanHtml(meta.Artist?.value || meta.Credit?.value || "Unknown creator"),
      license: cleanHtml(meta.LicenseShortName?.value || meta.UsageTerms?.value || "See source"),
      licenseUrl: meta.LicenseUrl?.value || info.descriptionurl || null,
      attribution: cleanHtml(meta.Attribution?.value || meta.Credit?.value || meta.Artist?.value || "Wikimedia Commons"),
      source: "Wikimedia Commons",
      width: Number(info.width) || null,
      height: Number(info.height) || null,
      score: selected.score,
    };
    memoryCache.set(key, result);
    setExternalCache(MEDIA_CACHE_PROVIDER, key, result, 30 * 24 * 60 * 60 * 1000);
    return result;
  }
  memoryCache.set(key, null);
  setExternalCache(MEDIA_CACHE_PROVIDER, key, null, 6 * 60 * 60 * 1000);
  return null;
}
