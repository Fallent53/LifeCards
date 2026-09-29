import test from "node:test";
import assert from "node:assert/strict";
process.env.LIFECARDS_DB_PATH="/tmp/lifecards-test.sqlite";
const database=await import("../src/database.mjs");
function lucaHitRng(){return{float:()=>0.1,int:()=>0}}
test("a claimed pack issues six cards plus at most one LUCA",()=>{
  database.resetForTests();database.ensureUser("tester","Tester");
  const config={packIntervalMs:8*60*1000,maxStoredPacks:8,cardsPerPack:6,holoRate:0.075,lucaDenominator:1};
  const first=database.claimPack("tester",config,lucaHitRng());
  assert.equal(first.cards.length,6);assert.equal(first.originCard?.definitionId,"luca");assert.equal(first.originCard?.serialCap,1);
});
test("LUCA remains one-of-one even when the Origin roll hits again",()=>{
  database.db.prepare("UPDATE users SET pack_balance = 1 WHERE id = ?").run("tester");
  const config={packIntervalMs:8*60*1000,maxStoredPacks:8,cardsPerPack:6,holoRate:0.075,lucaDenominator:1};
  const second=database.claimPack("tester",config,lucaHitRng());assert.equal(second.originCard,null);
  const count=database.db.prepare("SELECT COUNT(*) AS c FROM cards WHERE definition_id = 'luca'").get().c;assert.equal(Number(count),1);
  const audit=database.getAuditHead();
  assert.equal(audit.count,2);
  assert.equal(audit.auditHash.length,64);
  assert.ok(audit.prevHash);
});
