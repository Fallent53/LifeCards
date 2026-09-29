import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { claimPack, createListing, buyListing, getState } from "./src/database.mjs";
import { searchCommonsImage } from "./src/media.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT ?? 3000);

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

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function bodyJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function api(request, response, url) {
  try {
    const uid = userId(request);
    if (request.method === "GET" && url.pathname === "/api/state") {
      return json(response, 200, getState(uid));
    }
    if (request.method === "POST" && url.pathname === "/api/packs/open") {
      const result = claimPack(uid);
      return json(response, 200, result);
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
    if (request.method === "GET" && url.pathname === "/api/media") {
      const query = url.searchParams.get("q") || "";
      const media = await searchCommonsImage(query);
      return json(response, 200, { media });
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

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return api(request, response, url);
  return serveStatic(response, url.pathname);
}).listen(port, () => {
  console.log(`LifeCards running on http://localhost:${port}`);
});
