import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const port = 43127;
const dbPath = "/tmp/lifecards-smoke.sqlite";
await rm(dbPath, { force: true }).catch(() => {});

const child = spawn(process.execPath, ["server.mjs"], {
  env: {
    ...process.env,
    PORT: String(port),
    LIFECARDS_DB_PATH: dbPath,
    LIFECARDS_LUCA_DENOMINATOR: "1000000000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { "x-lifecards-user": "smoke" },
      });
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error("LifeCards server did not become ready");
}

try {
  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!healthResponse.ok || !(await healthResponse.json()).ok) {
    throw new Error("Health endpoint is unavailable");
  }

  const state = await waitForServer();
  if (state.user.packs < 1) throw new Error("Smoke user has no initial pack");
  if (state.config.cardsPerPack !== 6) throw new Error("cardsPerPack drifted from 6");
  if (state.config.maxStoredPacks !== 8) throw new Error("maxStoredPacks drifted from 8");

  const packResponse = await fetch(`http://127.0.0.1:${port}/api/packs/open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-lifecards-user": "smoke",
    },
    body: "{}",
  });
  if (!packResponse.ok) throw new Error(`Pack endpoint returned ${packResponse.status}`);
  const pack = await packResponse.json();
  if (pack.cards?.length !== 6) throw new Error("Pack endpoint did not return six cards");
  if (!pack.audit?.auditHash || pack.audit.auditHash.length !== 64) {
    throw new Error("Pack endpoint did not return a provenance audit hash");
  }

  const questionResponse = await fetch(`http://127.0.0.1:${port}/api/knowledge/question`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-lifecards-user": "smoke",
    },
    body: "{}",
  });
  if (!questionResponse.ok || !(await questionResponse.json()).question?.id) {
    throw new Error("Knowledge question endpoint is unavailable");
  }

  const shortTaxonomy = await fetch(`http://127.0.0.1:${port}/api/taxonomy/search?q=x`);
  const shortTaxonomyBody = await shortTaxonomy.json();
  if (!shortTaxonomy.ok || !Array.isArray(shortTaxonomyBody.results) || shortTaxonomyBody.results.length !== 0) {
    throw new Error("Taxonomy search guard is unavailable");
  }

  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  if (!html.includes("LifeCards") || !html.includes("/app.js")) {
    throw new Error("Web shell is incomplete");
  }

  const app = await fetch(`http://127.0.0.1:${port}/app.js`);
  if (!app.ok || !(await app.text()).includes("openPack")) {
    throw new Error("Client bundle is unavailable");
  }

  console.log("Smoke test passed: health, state, pack opening, audit, knowledge, taxonomy guard and web shell.");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(dbPath, { force: true }).catch(() => {});
}

if (child.exitCode && child.exitCode !== 0) {
  throw new Error(`Server exited with code ${child.exitCode}: ${stderr}`);
}
