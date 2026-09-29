import { catalog } from "../src/catalog.mjs";
import { getScientificEnrichment } from "../src/science.mjs";
import { searchCommonsImage } from "../src/media.mjs";

const langArg = process.argv.find((arg) => arg.startsWith("--lang="));
const lang = langArg ? langArg.split("=")[1] : "fr";
const delayMs = Number(process.env.LIFECARDS_ENRICH_DELAY_MS || 750);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`LifeCards enrichment: ${catalog.length} definitions, Wikipedia language=${lang}`);

let ok = 0;
let partial = 0;

for (const [index, definition] of catalog.entries()) {
  if (definition.kind === "origin") {
    console.log(`[${index + 1}/${catalog.length}] ${definition.commonName}: local-only origin concept`);
    continue;
  }

  process.stdout.write(`[${index + 1}/${catalog.length}] ${definition.scientificName} ... `);

  const [scienceResult, mediaResult] = await Promise.allSettled([
    getScientificEnrichment(definition.id, { lang }),
    searchCommonsImage(definition.mediaQuery || definition.scientificName || definition.commonName),
  ]);

  const science = scienceResult.status === "fulfilled" ? scienceResult.value : null;
  const media = mediaResult.status === "fulfilled" ? mediaResult.value : null;
  const status = [
    science?.wikipedia?.available ? "wiki" : null,
    science?.ncbi?.available ? `ncbi:${science.ncbi.taxId}` : null,
    science?.lifemap?.available ? "lifemap" : null,
    media?.imageUrl ? "image" : null,
  ].filter(Boolean);

  if (status.length >= 3) ok += 1;
  else partial += 1;

  console.log(status.join(", ") || "no external data");
  await sleep(delayMs);
}

console.log(`Done. enriched=${ok}, partial=${partial}`);
