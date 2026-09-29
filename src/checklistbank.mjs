const BASE = process.env.CHECKLISTBANK_BASE_URL || "https://api.checklistbank.org";
const DATASET = process.env.CHECKLISTBANK_DATASET || "3LXR";
const cache = new Map();
const TTL = 10 * 60 * 1000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL) return null;
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(path, params = {}, timeoutMs = 6000) {
  const url = new URL(path, BASE.endsWith("/") ? BASE : BASE + "/");
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  const key = url.toString();
  const cached = cacheGet(key);
  if (cached) return cached;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: "application/json",
      "User-Agent": "LifeCards/0.1 (Catalogue of Life live taxonomy client)",
    },
  });
  if (!response.ok) throw new Error(`ChecklistBank returned HTTP ${response.status}`);
  return cacheSet(key, await response.json());
}

function mapUsage(usage, classification = null) {
  if (!usage) return null;
  const name = usage.name || {};
  return {
    id: String(usage.id || usage.taxonID || ""),
    parentId: usage.parentId ? String(usage.parentId) : null,
    scientificName: name.scientificName || usage.scientificName || usage.label || "",
    canonicalName: name.scientificName || usage.scientificName || usage.label || "",
    commonName: name.scientificName || usage.scientificName || usage.label || "",
    rank: name.rank || usage.rank || "unranked",
    status: usage.status || "accepted",
    extinct: Boolean(usage.extinct),
    childCount: Number(usage.childCount || usage.count || 0),
    kind: String(name.rank || usage.rank || "").toLowerCase() === "species" ? "species" : "taxon",
    source: "Catalogue of Life live",
    sourceId: String(usage.id || usage.taxonID || ""),
    classification,
  };
}

function mapTreeNode(node) {
  if (!node) return null;
  const name = typeof node.name === "string"
    ? node.name
    : node.name?.scientificName || node.scientificName || node.label || "";
  return {
    id: String(node.id || node.taxonID || ""),
    parentId: node.parentId ? String(node.parentId) : null,
    scientificName: name,
    canonicalName: name,
    commonName: node.vernacularName || name,
    rank: node.rank || node.name?.rank || "unranked",
    status: node.status || "accepted",
    extinct: Boolean(node.extinct),
    childCount: Number(node.childCount ?? node.count ?? 0),
    kind: String(node.rank || node.name?.rank || "").toLowerCase() === "species" ? "species" : "taxon",
    source: "Catalogue of Life live",
    sourceId: String(node.id || node.taxonID || ""),
  };
}

async function paged(path, params = {}, limit = 50) {
  const page = await fetchJson(path, { ...params, limit, offset: 0 });
  return {
    result: Array.isArray(page?.result) ? page.result : Array.isArray(page) ? page : [],
    total: Number(page?.total ?? 0),
  };
}

export async function remoteSearchTaxa(query, limit = 30) {
  const q = String(query || "").trim();
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));

  const [usagePage, vernacularPage] = await Promise.allSettled([
    paged(`dataset/${DATASET}/nameusage/search`, { q, status: "accepted" }, safeLimit),
    paged(`dataset/${DATASET}/vernacular`, { q, lang: "eng" }, Math.min(20, safeLimit)),
  ]);

  const results = [];
  const seen = new Set();

  if (usagePage.status === "fulfilled") {
    for (const wrapper of usagePage.value.result) {
      const mapped = mapUsage(wrapper?.usage || wrapper, wrapper?.classification || null);
      if (!mapped?.id || seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      results.push(mapped);
    }
  }

  if (vernacularPage.status === "fulfilled") {
    for (const row of vernacularPage.value.result) {
      const id = String(row.taxonID || row.taxonId || row.id || "");
      if (!id || seen.has(id)) continue;
      const scientific = row.latin || row.scientificName || row.name || "";
      seen.add(id);
      results.push({
        id,
        parentId: null,
        scientificName: scientific,
        canonicalName: scientific,
        commonName: row.name || scientific,
        rank: row.rank || "taxon",
        status: "accepted",
        extinct: false,
        childCount: Number(row.childCount || 0),
        kind: String(row.rank || "").toLowerCase() === "species" ? "species" : "taxon",
        source: "Catalogue of Life live",
        sourceId: id,
      });
    }
  }

  return results.slice(0, safeLimit);
}

export async function remoteGetTaxon(id) {
  const raw = await fetchJson(`dataset/${DATASET}/nameusage/${encodeURIComponent(id)}`);
  return mapUsage(raw);
}

export async function remoteGetChildren(id, limit = 80) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 80));
  const page = await paged(
    `dataset/${DATASET}/tree/${encodeURIComponent(id)}/children`,
    { extinct: true },
    safeLimit
  );
  return page.result.map(mapTreeNode).filter(Boolean);
}

export async function remoteGetPath(id) {
  const raw = await fetchJson(`dataset/${DATASET}/tree/${encodeURIComponent(id)}`, { extinct: true });
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.result) ? raw.result : [];
  return rows.map(mapTreeNode).filter(Boolean);
}

export async function remoteAnimaliaRoot() {
  const cached = cacheGet("animalia-root");
  if (cached) return cached;
  const results = await remoteSearchTaxa("Animalia", 20);
  const root = results.find((row) =>
    row.scientificName.toLowerCase() === "animalia" &&
    String(row.rank).toLowerCase() === "kingdom"
  ) || results.find((row) => row.scientificName.toLowerCase() === "animalia") || results[0] || null;
  return cacheSet("animalia-root", root);
}

async function pool(items, concurrency, worker) {
  const queue = [...items];
  const output = [];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item == null) break;
      output.push(await worker(item));
    }
  });
  await Promise.all(runners);
  return output;
}

export async function remoteGetSubtree(rootId, { depth = 2, childLimit = 30, nodeLimit = 360 } = {}) {
  const root = rootId ? await remoteGetTaxon(rootId) : await remoteAnimaliaRoot();
  if (!root) return null;

  let used = 1;
  async function expand(node, level) {
    const output = { ...node, children: [] };
    if (level >= depth || used >= nodeLimit) return output;

    let children = [];
    try {
      children = await remoteGetChildren(node.id, childLimit);
    } catch {
      children = [];
    }
    const room = Math.max(0, nodeLimit - used);
    children = children.slice(0, room);
    used += children.length;

    if (level + 1 >= depth) {
      output.children = children.map((child) => ({ ...child, children: [] }));
    } else {
      output.children = await pool(children, 5, (child) => expand(child, level + 1));
    }
    output.childCount = Math.max(Number(node.childCount || 0), output.children.length);
    output.truncatedChildren = Math.max(0, Number(node.childCount || 0) - output.children.length);
    return output;
  }

  let path = [];
  try { path = await remoteGetPath(root.id); } catch {}
  if (!path.length || String(path.at(-1)?.id) !== String(root.id)) path.push(root);

  return {
    root: await expand(root, 0),
    nodesUsed: used,
    maxNodes: nodeLimit,
    path,
    status: {
      ready: true,
      mode: "catalogue-of-life-live",
      remote: true,
      datasetKey: DATASET,
      scope: "Animalia",
      rootId: root.id,
      source: "Catalogue of Life / ChecklistBank live API",
    },
  };
}

export function remoteStatusHint() {
  return {
    ready: true,
    mode: "catalogue-of-life-live",
    remote: true,
    datasetKey: DATASET,
    scope: "Animalia",
    rootId: null,
    taxonCount: null,
    speciesCount: null,
    source: "Catalogue of Life / ChecklistBank live API",
  };
}
