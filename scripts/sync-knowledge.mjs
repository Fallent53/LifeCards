import { writeFile, mkdir } from "node:fs/promises";
import { catalog } from "../src/catalog.mjs";
import { getKnowledge } from "../src/knowledge.mjs";

const outFile = new URL("../data/knowledge-snapshot.json", import.meta.url);
await mkdir(new URL("../data/", import.meta.url), { recursive: true });

const snapshot = {
  generatedAt: new Date().toISOString(),
  language: "en",
  note: "Snapshot of externally sourced metadata. Upstream licenses and attribution remain applicable.",
  records: {},
};

for (const definition of catalog) {
  const query = definition.kind === "origin"
    ? definition.commonName
    : definition.scientificName || definition.commonName;
  process.stdout.write(`Resolving ${definition.id} ... `);
  try {
    snapshot.records[definition.id] = await getKnowledge(query, { lang: "en" });
    console.log("ok");
  } catch (error) {
    snapshot.records[definition.id] = { error: error.message, query };
    console.log("failed");
  }
  await new Promise((resolve) => setTimeout(resolve, 125));
}

await writeFile(outFile, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(`Wrote ${outFile.pathname}`);
