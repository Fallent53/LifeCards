import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { claimPack, createListing, cancelListing, buyListing, getState, listCollectionPage, listDefinitionCopies, ownedScientificNames, listMarketPage, getDefinitionSupplies, getCardProvenance } from "./src/database.mjs";
import { searchCommonsImage } from "./src/media.mjs";
import { getKnowledge, getKnowledgeBatch } from "./src/knowledge.mjs";
import { taxonomyStatus, searchTaxa, getTaxon, getChildren, getPath, getSubtree } from "./src/taxonomy-store.mjs";
import { remoteSearchTaxa, remoteGetTaxon, remoteGetChildren, remoteGetPath, remoteGetSubtree, remoteStatusHint } from "./src/checklistbank.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const preferredPort = Number(process.env.PORT ?? 3000);
const hasExplicitPort = process.env.PORT != null;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function userId(request) {
  return String(request.headers["x-lifecards-user"] || "explorer").slice(0, 80);
}

function json(response, status, value, { cacheControl = "no-store" } = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function publicJson(response, value, maxAge = 300) {
  return json(response, 200, value, {
    cacheControl: `public, max-age=${maxAge}, stale-while-revalidate=86400`,
  });
}

async function bodyJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function effectiveTaxonomyStatus() {
  const local = taxonomyStatus();
  return local.ready ? local : { ...remoteStatusHint(), localFallback: local };
}

async function effectiveSearchTaxa(query, limit) {
  const local = taxonomyStatus();
  if (local.ready) return { results: searchTaxa(query, limit), taxonomy: local };
  try {
    return { results: await remoteSearchTaxa(query, limit), taxonomy: effectiveTaxonomyStatus() };
  } catch {
    return { results: searchTaxa(query, limit), taxonomy: local };
  }
}

async function effectiveGetTaxon(id) {
  const local = taxonomyStatus();
  if (local.ready) return { taxon: getTaxon(id), path: getPath(id), taxonomy: local };
  try {
    const [taxon, path] = await Promise.all([remoteGetTaxon(id), remoteGetPath(id)]);
    return { taxon, path, taxonomy: effectiveTaxonomyStatus() };
  } catch {
    return { taxon: getTaxon(id), path: getPath(id), taxonomy: local };
  }
}

async function effectiveGetChildren(id, limit) {
  const local = taxonomyStatus();
  if (local.ready) return { children: getChildren(id, limit), taxonomy: local };
  try {
    return { children: await remoteGetChildren(id, limit), taxonomy: effectiveTaxonomyStatus() };
  } catch {
    return { children: getChildren(id, limit), taxonomy: local };
  }
}

async function effectiveGetPath(id) {
  const local = taxonomyStatus();
  if (local.ready) return { path: getPath(id), taxonomy: local };
  try {
    return { path: await remoteGetPath(id), taxonomy: effectiveTaxonomyStatus() };
  } catch {
    return { path: getPath(id), taxonomy: local };
  }
}

async function effectiveGetSubtree(root, options) {
  const local = taxonomyStatus();
  if (local.ready) return getSubtree(root, options);
  try {
    return await remoteGetSubtree(root, {
      depth: Math.min(2, options.depth || 2),
      childLimit: Math.min(36, options.childLimit || 30),
      nodeLimit: Math.min(420, options.nodeLimit || 360),
    });
  } catch {
    return getSubtree(root, options);
  }
}

async function api(request, response, url) {
  try {
    const uid = userId(request);
    if (request.method === "GET" && url.pathname === "/api/state") {
      return json(response, 200, getState(uid));
    }
    if (request.method === "GET" && url.pathname === "/api/collection") {
      const mode = url.searchParams.get("mode") || "DISCOVERIES";
      const filter = url.searchParams.get("filter") || "ALL";
      const query = url.searchParams.get("q") || "";
      const sort = url.searchParams.get("sort") || "RARITY";
      const limit = Number(url.searchParams.get("limit") || 36);
      const offset = Number(url.searchParams.get("offset") || 0);
      return json(response, 200, listCollectionPage(uid, { mode, filter, query, sort, limit, offset }));
    }
    if (request.method === "GET" && url.pathname === "/api/collection/copies") {
      const definitionId = url.searchParams.get("definitionId") || "";
      const limit = Number(url.searchParams.get("limit") || 100);
      return json(response, 200, {
        definitionId,
        items: listDefinitionCopies(uid, definitionId, limit),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/collection/owned") {
      const input = await bodyJson(request);
      const scientificNames = Array.isArray(input.scientificNames) ? input.scientificNames : [];
      return json(response, 200, {
        scientificNames: ownedScientificNames(uid, scientificNames),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/packs/open") {
      const result = claimPack(uid);
      return json(response, 200, result);
    }
    if (request.method === "GET" && url.pathname === "/api/market") {
      const scope = url.searchParams.get("scope") || "MARKET";
      const filter = url.searchParams.get("filter") || "ALL";
      const query = url.searchParams.get("q") || "";
      const sort = url.searchParams.get("sort") || "NEWEST";
      const limit = Number(url.searchParams.get("limit") || 24);
      const offset = Number(url.searchParams.get("offset") || 0);
      return json(response, 200, listMarketPage({
        viewerId: uid,
        scope,
        filter,
        query,
        sort,
        limit,
        offset,
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/market/list") {
      const input = await bodyJson(request);
      const listing = createListing(uid, String(input.cardId || ""), Number(input.price));
      return json(response, 201, listing);
    }
    if (request.method === "POST" && url.pathname === "/api/market/buy") {
      const input = await bodyJson(request);
      const result = buyListing(uid, String(input.listingId || ""));
      return json(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/api/market/cancel") {
      const input = await bodyJson(request);
      const result = cancelListing(uid, String(input.listingId || ""));
      return json(response, 200, result);
    }
    if (request.method === "GET" && url.pathname === "/api/supplies") {
      const definitionId = url.searchParams.get("definitionId") || "";
      return json(response, 200, {
        definitionId,
        items: getDefinitionSupplies(definitionId),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/cards/provenance") {
      const cardId = url.searchParams.get("cardId") || "";
      const provenance = getCardProvenance(cardId);
      if (!provenance) return json(response, 404, { error: "Card not found" });
      return json(response, 200, { provenance });
    }
    if (request.method === "GET" && url.pathname === "/api/media") {
      const query = url.searchParams.get("q") || "";
      const media = await searchCommonsImage(query);
      return publicJson(response, { media }, 86400);
    }
    if (request.method === "GET" && url.pathname === "/api/knowledge") {
      const query = url.searchParams.get("q") || "";
      const lang = (url.searchParams.get("lang") || "en").replace(/[^a-z-]/gi, "").slice(0, 12) || "en";
      const knowledge = await getKnowledge(query, { lang });
      return publicJson(response, { knowledge }, 86400);
    }
    if (request.method === "POST" && url.pathname === "/api/knowledge/batch") {
      const input = await bodyJson(request);
      const lang = String(input.lang || "en").replace(/[^a-z-]/gi, "").slice(0, 12) || "en";
      const entries = Array.isArray(input.entries) ? input.entries.slice(0, 24) : [];
      const knowledge = await getKnowledgeBatch(entries, { lang, concurrency: 4 });
      return json(response, 200, { knowledge });
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/status") {
      return json(response, 200, { taxonomy: effectiveTaxonomyStatus() });
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/search") {
      const query = url.searchParams.get("q") || "";
      const limit = Number(url.searchParams.get("limit") || 30);
      return json(response, 200, await effectiveSearchTaxa(query, limit));
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/resolve") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (!query) return json(response, 200, { taxon: null, path: [], taxonomy: effectiveTaxonomyStatus() });

      const searched = await effectiveSearchTaxa(query, 12);
      const needle = query.toLowerCase();
      const candidates = searched.results || [];
      const taxon =
        candidates.find((item) => String(item.scientificName || "").toLowerCase() === needle) ||
        candidates.find((item) => String(item.canonicalName || "").toLowerCase() === needle) ||
        candidates.find((item) => String(item.commonName || "").toLowerCase() === needle) ||
        candidates[0] ||
        null;

      if (!taxon) {
        return json(response, 200, { taxon: null, path: [], taxonomy: searched.taxonomy || effectiveTaxonomyStatus() });
      }

      const resolved = await effectiveGetTaxon(taxon.id);
      return json(response, 200, {
        taxon: resolved.taxon || taxon,
        path: resolved.path || [],
        taxonomy: resolved.taxonomy || searched.taxonomy || effectiveTaxonomyStatus(),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/taxon") {
      const id = url.searchParams.get("id") || "";
      return json(response, 200, await effectiveGetTaxon(id));
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/children") {
      const id = url.searchParams.get("id") || "";
      const limit = Number(url.searchParams.get("limit") || 120);
      return json(response, 200, await effectiveGetChildren(id, limit));
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/path") {
      const id = url.searchParams.get("id") || "";
      return json(response, 200, await effectiveGetPath(id));
    }
    if (request.method === "GET" && url.pathname === "/api/taxonomy/subtree") {
      const root = url.searchParams.get("root") || "";
      const depth = Math.max(1, Math.min(5, Number(url.searchParams.get("depth") || 3)));
      const childLimit = Math.max(6, Math.min(180, Number(url.searchParams.get("childLimit") || 42)));
      const nodeLimit = Math.max(50, Math.min(1800, Number(url.searchParams.get("nodeLimit") || 850)));
      return json(response, 200, await effectiveGetSubtree(root, { depth, childLimit, nodeLimit }));
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        service: "LifeCards",
        taxonomy: effectiveTaxonomyStatus(),
        time: new Date().toISOString(),
      });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 400, { error: error?.message || "Unexpected error" });
  }
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(requested).replace(/^([.][.][/\\])+/, "").replace(/^[/\\]+/, "");
  const file = join(publicDir, safe);
  if (!file.startsWith(publicDir)) {
    response.writeHead(403); return response.end("Forbidden");
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fallback);
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return api(request, response, url);
  return serveStatic(response, url.pathname);
}

function startServer(port, attemptsLeft = 10) {
  const server = http.createServer(handleRequest);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !hasExplicitPort && attemptsLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
      return startServer(nextPort, attemptsLeft - 1);
    }

    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set PORT to another value, for example PORT=3001.`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });

  server.listen(port, () => {
    console.log(`LifeCards running on http://localhost:${port}`);
  });
}

startServer(preferredPort);
