import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { byId } from "../src/catalog.mjs";
import { definitionFromTaxon } from "../src/definitions.mjs";
import { getGameplayTaxon, taxonomyStatus } from "../src/taxonomy-store.mjs";

const dbPath=resolve(process.env.LIFECARDS_DB_PATH||"./data/lifecards.sqlite");
if(!existsSync(dbPath)){
  console.error("LifeCards database not found:",dbPath);
  process.exit(1);
}

const taxonomy=taxonomyStatus();
if(!taxonomy.ready||!taxonomy.dropPoolReady){
  console.error("Gameplay taxonomy is not ready. Refusing to reconcile collection.");
  console.error("Run the Eukaryota sync/repair first.");
  process.exit(2);
}

const scope=String(taxonomy.dropScope||taxonomy.scope||"").toLowerCase();
if(scope!=="eukaryota"){
  console.error(`Expected Eukaryota gameplay scope, got "${scope||"unknown"}". Refusing cleanup.`);
  process.exit(3);
}

const stamp=new Date().toISOString().replace(/[:.]/g,"-");
const backupPath=`${dbPath}.backup-before-reconcile-${stamp}`;
copyFileSync(dbPath,backupPath);

const db=new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys=ON;");

const cards=db.prepare(`
  SELECT id,definition_id,definition_json,common_name,scientific_name,rarity,kind
  FROM cards
  ORDER BY created_at
`).all();

const explicitOutOfScopeSeeds=new Set(["bacteria","archaea"]);
const stale=[];
const refresh=[];

for(const row of cards){
  const definitionId=String(row.definition_id||"");

  if(explicitOutOfScopeSeeds.has(definitionId)){
    stale.push(row);
    continue;
  }

  if(definitionId==="luca"){
    const definition=byId.get("luca");
    if(definition)refresh.push({row,definition});
    continue;
  }

  const seed=byId.get(definitionId);
  if(seed){
    refresh.push({row,definition:seed});
    continue;
  }

  const taxon=getGameplayTaxon(definitionId);
  if(!taxon){
    stale.push(row);
    continue;
  }

  const definition=definitionFromTaxon(taxon);
  if(!definition){
    stale.push(row);
    continue;
  }

  refresh.push({row,definition});
}

const staleIds=stale.map((row)=>String(row.id));
const staleDefinitionIds=[...new Set(stale.map((row)=>String(row.definition_id)))];

const update=db.prepare(`
  UPDATE cards
  SET definition_json=?,common_name=?,scientific_name=?,rarity=?,kind=?
  WHERE id=?
`);

let removedListings=0;
let removedCards=0;
let refreshedCards=0;

db.exec("BEGIN IMMEDIATE");
try{
  for(const {row,definition} of refresh){
    update.run(
      JSON.stringify(definition),
      definition.commonName||definition.canonicalName||definition.scientificName||row.common_name,
      definition.scientificName||definition.canonicalName||row.scientific_name,
      definition.rarity||row.rarity,
      definition.kind||row.kind,
      String(row.id)
    );
    refreshedCards+=1;
  }

  const deleteListings=db.prepare("DELETE FROM listings WHERE card_id=?");
  const deleteCard=db.prepare("DELETE FROM cards WHERE id=?");

  for(const id of staleIds){
    removedListings+=Number(deleteListings.run(id).changes||0);
    removedCards+=Number(deleteCard.run(id).changes||0);
  }

  db.exec("COMMIT");
}catch(error){
  try{db.exec("ROLLBACK");}catch{}
  db.close();
  throw error;
}

db.exec("PRAGMA optimize;");
db.close();

console.log("");
console.log("Collection reconciliation complete");
console.log("─".repeat(52));
console.log("Gameplay scope       :",taxonomy.dropScope||taxonomy.scope);
console.log("Cards scanned        :",cards.length.toLocaleString());
console.log("Cards refreshed      :",refreshedCards.toLocaleString());
console.log("Cards removed        :",removedCards.toLocaleString());
console.log("Listings removed     :",removedListings.toLocaleString());
console.log("Stale definitions    :",staleDefinitionIds.length.toLocaleString());

if(staleDefinitionIds.length){
  console.log("");
  console.log("Removed definitions (first 30)");
  for(const id of staleDefinitionIds.slice(0,30))console.log("  -",id);
  if(staleDefinitionIds.length>30)console.log(`  … +${staleDefinitionIds.length-30} more`);
}

console.log("");
console.log("Backup:",backupPath);
console.log("Pack audit records were left intact.");
