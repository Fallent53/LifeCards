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

  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  if (!html.includes("LifeCards") || !html.includes("/app.js")) {
    throw new Error("Web shell is incomplete");
  }

  const app = await fetch(`http://127.0.0.1:${port}/app.js`);
  if (!app.ok || !(await app.text()).includes("openPack")) {
    throw new Error("Client bundle is unavailable");
  }

  console.log("Smoke test passed: server, state, pack opening and web shell.");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(dbPath, { force: true }).catch(() => {});
}

if (child.exitCode && child.exitCode !== 0) {
  throw new Error(`Server exited with code ${child.exitCode}: ${stderr}`);
}
