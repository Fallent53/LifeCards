import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { byId, catalog } from "../src/catalog.mjs";
import { getKnowledge } from "../src/knowledge.mjs";

const args = new Set(process.argv.slice(2));
const dbPath = resolve(process.env.LIFECARDS_DB_PATH ?? "./data/lifecards.sqlite");
const queries = new Map();

function addDefinition(definition) {
  if (!definition) return;
  const query = definition.kind === "origin"
    ? definition.commonName
    : definition.scientificName || definition.commonName;
  if (query) queries.set(definition.id, query);
}

if (args.has("--catalog") || !existsSync(dbPath)) {
  for (const definition of catalog) addDefinition(definition);
}

if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT DISTINCT definition_id FROM cards").all();
    for (const row of rows) addDefinition(byId.get(row.definition_id));
  } finally {
    db.close();
  }
}

const items = [...queries.entries()];
if (!items.length) {
  console.log("Nothing to prefetch.");
  process.exit(0);
}

const concurrency = Math.max(1, Math.min(8, Number(process.env.LIFECARDS_PREFETCH_CONCURRENCY || 4)));
let cursor = 0;
let completed = 0;
let failed = 0;

async function worker() {
  while (cursor < items.length) {
    const index = cursor++;
    const [id, query] = items[index];
    try {
      const result = await getKnowledge(query, { lang: "en" });
      const image = result?.media?.imageUrl ? "image" : "no-image";
      console.log(`[${index + 1}/${items.length}] ${id} · ${image}`);
    } catch (error) {
      failed += 1;
      console.warn(`[${index + 1}/${items.length}] ${id} · failed: ${error.message}`);
    } finally {
      completed += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(`Prefetch complete: ${completed - failed} ok, ${failed} failed.`);
