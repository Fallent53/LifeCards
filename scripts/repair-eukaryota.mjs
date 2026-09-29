import { copyFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sourcePath=resolve(process.env.LIFECARDS_TAXONOMY_DB||"./data/eukaryota.sqlite");
const repairPath=`${sourcePath}.repairing`;

if(!existsSync(sourcePath)){
  console.error("Eukaryota database not found:",sourcePath);
  console.error("Run npm run sync:col first.");
  process.exit(1);
}

console.log("Preparing atomic Eukaryota repair…");
console.log("Source:",sourcePath);
await rm(repairPath,{force:true});
await rm(`${repairPath}-wal`,{force:true}).catch(()=>{});
await rm(`${repairPath}-shm`,{force:true}).catch(()=>{});
await copyFile(sourcePath,repairPath);

const db=new DatabaseSync(repairPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;");

function tableExists(name){
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(String(name)));
}

if(!tableExists("taxa")||!tableExists("meta")){
  db.close();
  await rm(repairPath,{force:true});
  throw new Error("Not a compatible LifeCards taxonomy database");
}

console.log("Resolving strict eukaryotic kingdom descendants…");
db.exec(`
  DROP TABLE IF EXISTS temp.keep_eukaryota;
  CREATE TEMP TABLE keep_eukaryota(id TEXT PRIMARY KEY) WITHOUT ROWID;

  INSERT OR IGNORE INTO keep_eukaryota(id)
  WITH RECURSIVE euk(id) AS (
    SELECT id
    FROM taxa
    WHERE lower(trim(scientific_name)) IN (
      'animalia','plantae','fungi','chromista','protozoa','protista'
    )
       OR lower(trim(canonical_name)) IN (
      'animalia','plantae','fungi','chromista','protozoa','protista'
    )

    UNION

    SELECT child.id
    FROM taxa child
    JOIN euk parent ON child.parent_id=parent.id
  )
  SELECT id FROM euk;
`);

const keepCount=Number(
  db.prepare("SELECT COUNT(*) AS c FROM keep_eukaryota").get()?.c||0
);
if(keepCount<1000){
  db.close();
  await rm(repairPath,{force:true});
  throw new Error(`Eukaryota repair refused: only ${keepCount} descendant taxa were resolved`);
}
console.log(`Keeping ${keepCount.toLocaleString()} CoL eukaryotic taxa.`);

db.exec("BEGIN IMMEDIATE");
try{
  const before=Number(db.prepare("SELECT COUNT(*) AS c FROM taxa").get()?.c||0);
  db.exec("DELETE FROM taxa WHERE id NOT IN (SELECT id FROM keep_eukaryota)");

  console.log("Cleaning canonical scientific names…");
  db.exec(`
    UPDATE taxa
    SET canonical_name=trim(
      substr(canonical_name,1,length(canonical_name)-length(authorship))
    )
    WHERE authorship IS NOT NULL
      AND trim(authorship)<>''
      AND canonical_name IS NOT NULL
      AND length(canonical_name)>length(authorship)
      AND lower(substr(canonical_name,-length(authorship)))=lower(authorship);
  `);

  const rootId="lifecards:eukaryota";
  db.prepare(`
    INSERT OR REPLACE INTO taxa(
      id,parent_id,scientific_name,canonical_name,common_name,common_name_priority,
      authorship,rank,status,extinct,kingdom,source_dataset,game_rarity,drop_eligible,
      child_count,descendant_species_count
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)
  `).run(
    rootId,null,"Eukaryota","Eukaryota","Eukaryotes",10,"","domain",
    "synthetic-backbone",0,"","LifeCards universal backbone","MYTHIC",1
  );

  db.prepare(`
    UPDATE taxa
    SET parent_id=?
    WHERE id<>?
      AND (
        parent_id IS NULL
        OR parent_id=''
        OR NOT EXISTS (SELECT 1 FROM taxa parent WHERE parent.id=taxa.parent_id)
      )
  `).run(rootId,rootId);

  console.log("Rebuilding child counts, search index and drop pools…");
  db.exec(`
    UPDATE taxa SET child_count=0;
    DROP TABLE IF EXISTS temp.child_counts;
    CREATE TEMP TABLE child_counts AS
      SELECT parent_id AS id,COUNT(*) AS c
      FROM taxa
      WHERE parent_id IS NOT NULL
      GROUP BY parent_id;
    CREATE INDEX child_counts_id_idx ON child_counts(id);
    UPDATE taxa
    SET child_count=COALESCE(
      (SELECT c FROM child_counts WHERE child_counts.id=taxa.id),0
    );
    DROP TABLE child_counts;

    DROP TABLE IF EXISTS taxa_fts;
    CREATE VIRTUAL TABLE taxa_fts USING fts5(
      id UNINDEXED,
      scientific_name,
      canonical_name,
      common_name,
      tokenize='unicode61 remove_diacritics 2'
    );
    INSERT INTO taxa_fts(id,scientific_name,canonical_name,common_name)
      SELECT id,scientific_name,COALESCE(canonical_name,''),COALESCE(common_name,'')
      FROM taxa;

    DROP TABLE IF EXISTS drop_pool;
    DROP TABLE IF EXISTS drop_pool_stats;
    CREATE TABLE drop_pool(
      rarity TEXT NOT NULL,
      slot INTEGER NOT NULL,
      taxon_id TEXT NOT NULL,
      PRIMARY KEY(rarity,slot),
      UNIQUE(taxon_id)
    );
    INSERT INTO drop_pool(rarity,slot,taxon_id)
    SELECT
      game_rarity,
      ROW_NUMBER() OVER (PARTITION BY game_rarity ORDER BY id),
      id
    FROM taxa
    WHERE drop_eligible=1 AND game_rarity IS NOT NULL;

    CREATE TABLE drop_pool_stats(
      rarity TEXT PRIMARY KEY,
      card_count INTEGER NOT NULL
    );
    INSERT INTO drop_pool_stats(rarity,card_count)
      SELECT rarity,COUNT(*) FROM drop_pool GROUP BY rarity;

    CREATE INDEX IF NOT EXISTS drop_pool_taxon_idx ON drop_pool(taxon_id);
  `);

  const after=Number(db.prepare("SELECT COUNT(*) AS c FROM taxa").get()?.c||0);
  const species=Number(
    db.prepare("SELECT COUNT(*) AS c FROM taxa WHERE rank='species'").get()?.c||0
  );
  const drops=Number(db.prepare("SELECT COUNT(*) AS c FROM drop_pool").get()?.c||0);

  const setMeta=db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
  setMeta.run("scope","Eukaryota");
  setMeta.run("root_id",rootId);
  setMeta.run("schema_version","5");
  setMeta.run("taxon_count",String(after));
  setMeta.run("species_count",String(species));
  setMeta.run("repaired_at",new Date().toISOString());

  db.exec("COMMIT");
  console.log(`Removed ${(before-after+1).toLocaleString()} non-eukaryotic records.`);
  console.log(`Taxa: ${after.toLocaleString()} · species: ${species.toLocaleString()} · droppable: ${drops.toLocaleString()}`);
}catch(error){
  try{db.exec("ROLLBACK")}catch{}
  db.close();
  await rm(repairPath,{force:true}).catch(()=>{});
  throw error;
}

db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
db.close();

await rm(`${sourcePath}-wal`,{force:true}).catch(()=>{});
await rm(`${sourcePath}-shm`,{force:true}).catch(()=>{});
await rm(sourcePath,{force:true});
await rename(repairPath,sourcePath);

console.log("");
console.log("Eukaryota repair complete.");
console.log("Database:",sourcePath);
console.log("Next: npm run audit:cards:status");
console.log("Then: npm run audit:cards");
