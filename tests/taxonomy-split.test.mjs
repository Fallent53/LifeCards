import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

const gamePath="/tmp/lifecards-taxonomy-game.sqlite";
const mapPath="/tmp/lifecards-taxonomy-map.sqlite";
const qualityPath="/tmp/lifecards-card-quality.sqlite";
for(const path of [gamePath,mapPath,qualityPath]){
  try{rmSync(path,{force:true});}catch{}
}

function makeDb(path,{scope,rootId,rows,withDropPool=false}){
  const db=new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE taxa(
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      scientific_name TEXT NOT NULL,
      canonical_name TEXT,
      common_name TEXT,
      rank TEXT,
      status TEXT,
      extinct INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      descendant_species_count INTEGER NOT NULL DEFAULT 0,
      game_rarity TEXT
    );
  `);
  const meta=db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  for(const [key,value] of Object.entries({
    schema_version:"4",
    scope,
    root_id:rootId,
    taxon_count:String(rows.length),
    species_count:String(rows.filter(row=>row.rank==="species").length),
    dataset_key:"test",
    release:"test release",
    imported_at:"2026-09-29T00:00:00.000Z",
  })) meta.run(key,value);

  const insert=db.prepare(`
    INSERT INTO taxa(
      id,parent_id,scientific_name,canonical_name,common_name,rank,status,
      extinct,child_count,descendant_species_count,game_rarity
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  for(const row of rows){
    insert.run(
      row.id,row.parentId||null,row.scientificName,row.scientificName,
      row.commonName||row.scientificName,row.rank,"accepted",0,
      row.childCount||0,row.descendantSpeciesCount||0,row.gameRarity||null
    );
  }

  if(withDropPool){
    db.exec(`
      CREATE TABLE drop_pool(
        rarity TEXT NOT NULL,
        slot INTEGER NOT NULL,
        taxon_id TEXT NOT NULL,
        PRIMARY KEY(rarity,slot)
      );
      CREATE TABLE drop_pool_stats(
        rarity TEXT PRIMARY KEY,
        card_count INTEGER NOT NULL
      );
      INSERT INTO drop_pool(rarity,slot,taxon_id) VALUES ('COMMON',1,'game-species');
      INSERT INTO drop_pool(rarity,slot,taxon_id) VALUES ('COMMON',2,'game-unready');
      INSERT INTO drop_pool_stats(rarity,card_count) VALUES ('COMMON',2);
    `);
  }
  db.close();
}

makeDb(gamePath,{
  scope:"Eukaryota",
  rootId:"game-eukaryota",
  withDropPool:true,
  rows:[
    {id:"game-eukaryota",scientificName:"Eukaryota",rank:"domain",childCount:3,descendantSpeciesCount:3,gameRarity:"MYTHIC"},
    {id:"game-animalia",parentId:"game-eukaryota",scientificName:"Animalia",rank:"kingdom",childCount:2,descendantSpeciesCount:2,gameRarity:"MYTHIC"},
    {id:"game-plantae",parentId:"game-eukaryota",scientificName:"Plantae",rank:"kingdom",childCount:0,descendantSpeciesCount:0,gameRarity:"MYTHIC"},
    {id:"game-fungi",parentId:"game-eukaryota",scientificName:"Fungi",rank:"kingdom",childCount:0,descendantSpeciesCount:0,gameRarity:"MYTHIC"},
    {id:"game-species",parentId:"game-animalia",scientificName:"Testus animalis",rank:"species",descendantSpeciesCount:1,gameRarity:"COMMON"},
    {id:"game-unready",parentId:"game-animalia",scientificName:"Wrongus imagus",rank:"species",descendantSpeciesCount:1,gameRarity:"COMMON"},
  ],
});

makeDb(mapPath,{
  scope:"all",
  rootId:"biota",
  rows:[
    {id:"biota",scientificName:"Biota",rank:"unranked",childCount:3,descendantSpeciesCount:3},
    {id:"map-bacteria",parentId:"biota",scientificName:"Bacteria",rank:"domain",childCount:1,descendantSpeciesCount:1},
    {id:"map-bacteria-species",parentId:"map-bacteria",scientificName:"Bacterium testum",rank:"species",descendantSpeciesCount:1},
    {id:"map-archaea",parentId:"biota",scientificName:"Archaea",rank:"domain",childCount:1,descendantSpeciesCount:1},
    {id:"map-archaea-species",parentId:"map-archaea",scientificName:"Archaeum testum",rank:"species",descendantSpeciesCount:1},
    {id:"map-eukaryota",parentId:"biota",scientificName:"Eukaryota",rank:"domain",childCount:1,descendantSpeciesCount:1},
    {id:"map-animalia",parentId:"map-eukaryota",scientificName:"Animalia",rank:"kingdom",childCount:1,descendantSpeciesCount:1},
    {id:"map-animal-species",parentId:"map-animalia",scientificName:"Animalis testum",rank:"species",descendantSpeciesCount:1},
  ],
});

const qualityDb=new DatabaseSync(qualityPath);
qualityDb.exec(`
  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT INTO meta(key,value) VALUES ('complete','1');
  INSERT INTO meta(key,value) VALUES ('taxonomy_scope','Eukaryota');
  INSERT INTO meta(key,value) VALUES ('resolver_version','v13-all-real-media-fallbacks');
  CREATE TABLE card_quality(
    taxon_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    resolver_version TEXT
  );
  INSERT INTO card_quality(taxon_id,status,resolver_version)
    VALUES ('game-species','READY','v13-all-real-media-fallbacks');
  INSERT INTO card_quality(taxon_id,status,resolver_version)
    VALUES ('game-unready','REVIEW','v13-all-real-media-fallbacks');
  CREATE TABLE ready_drop_pool(
    rarity TEXT NOT NULL,
    slot INTEGER NOT NULL,
    taxon_id TEXT NOT NULL,
    PRIMARY KEY(rarity,slot)
  );
  INSERT INTO ready_drop_pool(rarity,slot,taxon_id) VALUES ('COMMON',1,'game-species');
  CREATE TABLE ready_drop_pool_stats(
    rarity TEXT PRIMARY KEY,
    card_count INTEGER NOT NULL
  );
  INSERT INTO ready_drop_pool_stats(rarity,card_count) VALUES ('COMMON',1);
`);
qualityDb.close();

process.env.LIFECARDS_TAXONOMY_DB=gamePath;
process.env.LIFECARDS_MAP_TAXONOMY_DB=mapPath;
process.env.LIFECARDS_CARD_QUALITY_DB=qualityPath;

const taxonomy=await import("../src/taxonomy-store.mjs");

test("full-life map and gameplay drop taxonomy remain separate",()=>{
  const status=taxonomy.taxonomyStatus();
  assert.equal(status.ready,true);
  assert.equal(status.fullLifeMap,true);
  assert.equal(status.mapScope,"all");
  assert.equal(status.dropScope,"Eukaryota");
  assert.equal(status.dropPoolReady,true);
  assert.equal(status.dropPool.COMMON,2);
  assert.equal(status.cardQuality.complete,true);
  assert.equal(status.cardQuality.ready,1);
  assert.equal(status.cardQuality.review,1);
  assert.equal(status.cardQuality.readyPoolActive,true);
});

test("map lookups use full-life database while gameplay resolution uses Eukaryota",()=>{
  assert.equal(taxonomy.getTaxon("map-bacteria")?.scientificName,"Bacteria");
  assert.equal(taxonomy.getTaxon("game-animalia"),null);
  assert.equal(taxonomy.getGameplayTaxon("game-animalia")?.scientificName,"Animalia");
  assert.equal(taxonomy.getGameplayTaxon("game-plantae")?.scientificName,"Plantae");
  assert.equal(taxonomy.getGameplayTaxon("game-fungi")?.scientificName,"Fungi");
});

test("drop selection uses only READY cards after a complete audit",()=>{
  const picked=taxonomy.pickDropTaxon("COMMON",{int:()=>0});
  assert.equal(picked?.id,"game-species");
  assert.equal(picked?.scientificName,"Testus animalis");
  assert.notEqual(picked?.id,"game-unready");
});

test("LUCA map exposes the three domains from full-life taxonomy",()=>{
  const payload=taxonomy.getSubtree("luca",{depth:3,childLimit:20,nodeLimit:100});
  assert.equal(payload.root.id,"luca");
  assert.deepEqual(payload.root.children.map(node=>node.id),["bacteria","archaea","eukaryota"]);
  assert.ok(payload.root.children.find(node=>node.id==="bacteria").children.length>=1);
  assert.ok(payload.root.children.find(node=>node.id==="archaea").children.length>=1);
  assert.ok(payload.root.children.find(node=>node.id==="eukaryota").children.length>=1);
});
