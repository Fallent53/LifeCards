import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getCommonsFileMetadata, getCommonsFilesMetadataBatch, getWikipediaFileMetadata, getWikipediaFilesMetadataBatch, hasCompleteAttribution, normalizeMediaFileKey, wikipediaThumbnailFallback, searchCommonsImage, searchGbifImage } from "./media.mjs";

const CACHE_TTL_MS = Number(process.env.LIFECARDS_KNOWLEDGE_CACHE_TTL_MS || 90 * 24 * 60 * 60 * 1000);
const CACHE_SCHEMA_VERSION = "v8";
const cache = new Map();
const knowledgeDbPath = resolve(process.env.LIFECARDS_KNOWLEDGE_DB || "./data/knowledge.sqlite");
mkdirSync(dirname(knowledgeDbPath), { recursive: true });
const knowledgeDb = new DatabaseSync(knowledgeDbPath);
knowledgeDb.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS knowledge_cache (
    query TEXT NOT NULL,
    lang TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY(query, lang)
  );
`);

function readPersistentCache(query, lang) {
  try {
    const row = knowledgeDb.prepare(
      "SELECT payload_json, fetched_at FROM knowledge_cache WHERE query = ? AND lang = ?"
    ).get(query, lang);
    if (!row) return null;

    const payload = JSON.parse(row.payload_json);
    const hasMedia = Boolean(payload?.media?.imageUrl);
    const ttl = hasMedia ? CACHE_TTL_MS : Math.min(CACHE_TTL_MS, 15 * 60 * 1000);
    if (Date.now() - Number(row.fetched_at) >= ttl) return null;

    return payload;
  } catch {
    return null;
  }
}

function writePersistentCache(query, lang, value) {
  try {
    knowledgeDb.prepare(`
      INSERT INTO knowledge_cache(query, lang, payload_json, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(query, lang) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at
    `).run(query, lang, JSON.stringify(value), Date.now());
  } catch {
    // Cache failures must never break gameplay.
  }
}

async function fetchJson(url, timeoutMs = 5000, { retries = 2 } = {}) {
  let lastError=null;

  for(let attempt=0;attempt<=retries;attempt+=1){
    try{
      const response=await fetch(url,{
        signal:AbortSignal.timeout(timeoutMs),
        headers:{
          "Accept":"application/json",
          "User-Agent":"LifeCards/0.1 (scientific card knowledge resolver)",
        },
      });

      if(response.ok)return response.json();

      const error=new Error(`Knowledge source returned ${response.status}`);
      error.status=response.status;
      lastError=error;

      if(![429,500,502,503,504].includes(response.status))throw error;

      const retryAfter=Number(response.headers.get("retry-after"));
      const delay=Number.isFinite(retryAfter)&&retryAfter>0
        ?Math.min(10000,retryAfter*1000)
        :700*(attempt+1);
      if(attempt<retries)await new Promise((resolve)=>setTimeout(resolve,delay));
    }catch(error){
      lastError=error;
      if(attempt<retries){
        await new Promise((resolve)=>setTimeout(resolve,700*(attempt+1)));
      }
    }
  }

  throw lastError||new Error("Knowledge request failed");
}

function firstPage(query = {}) {
  return Object.values(query.pages ?? {})[0] ?? null;
}

async function wikipediaPage(query, lang = "en") {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    redirects: "1",
    prop: "extracts|pageimages|pageprops|pageterms|info",
    titles: query,
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail|name|original",
    pilicense: "free",
    pithumbsize: "1200",
    wbptterms: "description",
    inprop: "url",
  });
  let json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  let page = firstPage(json.query);
  if (page && !page.missing) return page;

  const search = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    list: "search",
    srsearch: query,
    srlimit: "1",
  });
  json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${search}`);
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;

  params.set("titles", title);
  json = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  page = firstPage(json.query);
  return page && !page.missing ? page : null;
}

function claimValue(entity, property) {
  const claim = entity?.claims?.[property]?.[0];
  const value = claim?.mainsnak?.datavalue?.value;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "id" in value) return value.id;
  return null;
}

async function wikidataEntity(qid, lang = "en") {
  if (!qid) return null;
  const params = new URLSearchParams({
    action: "wbgetentities",
    format: "json",
    origin: "*",
    ids: qid,
    props: "claims|labels|descriptions|sitelinks",
    languages: `${lang}|en`,
  });
  const json = await fetchJson(`https://www.wikidata.org/w/api.php?${params}`);
  return json?.entities?.[qid] ?? null;
}

export function lifemapUrlForTaxId(taxId) {
  const safe = String(taxId ?? "").replace(/\D/g, "");
  return safe ? `https://lifemap-ncbi.univ-lyon1.fr/?tid=${safe}` : null;
}

export function ncbiUrlForTaxId(taxId) {
  const safe = String(taxId ?? "").replace(/\D/g, "");
  return safe ? `https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${safe}` : null;
}

function mediaCandidateScore(media, confidence = "LOW", resolver = "") {
  if(!media?.imageUrl)return -1;
  let score=0;
  if(hasCompleteAttribution(media))score+=100;
  const level=String(confidence||"LOW").toUpperCase();
  if(level==="HIGH")score+=40;
  else if(level==="MEDIUM")score+=20;
  if(String(resolver).startsWith("wikipedia-pageimage"))score+=6;
  else if(String(resolver).startsWith("wikidata-p18"))score+=5;
  else if(String(resolver).startsWith("gbif"))score+=4;
  return score;
}

function chooseBestMediaCandidate(candidates) {
  return (candidates||[])
    .filter((candidate)=>candidate?.media?.imageUrl)
    .sort((a,b)=>mediaCandidateScore(b.media,b.confidence,b.resolver)-mediaCandidateScore(a.media,a.confidence,a.resolver))[0]||null;
}

export async function getKnowledge(query, { lang = "en" } = {}) {
  const normalized = String(query || "").trim();
  if (!normalized) return null;
  const persistedQuery = `${CACHE_SCHEMA_VERSION}:${normalized.toLowerCase()}`;
  const cacheKey = `${lang}:${persistedQuery}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) return cached.value;

  const persisted = readPersistentCache(persistedQuery, lang);
  if (persisted) {
    cache.set(cacheKey, { storedAt: Date.now(), value: persisted });
    return persisted;
  }

  let page = null;
  try {
    page = await wikipediaPage(normalized, lang);
  } catch {
    page = null;
  }

  const qid = page?.pageprops?.wikibase_item ?? null;
  let entity = null;
  try {
    entity = await wikidataEntity(qid, lang);
  } catch {
    entity = null;
  }

  const taxId = claimValue(entity, "P685");
  const taxonName = claimValue(entity, "P225") || normalized;
  const wikidataImage = claimValue(entity, "P18");
  const description =
    entity?.descriptions?.[lang]?.value ||
    entity?.descriptions?.en?.value ||
    page?.terms?.description?.[0] ||
    null;

  let media = null;
  const normalizedTaxon=String(taxonName||"").toLowerCase().replace(/\s+/g," ").trim();
  const normalizedQuery=normalized.toLowerCase().replace(/\s+/g," ").trim();
  const looksLikeSpecies=/^[A-Z][a-z-]+\s+[a-z][a-z-]+/.test(taxonName);
  const exactTaxonIdentity=Boolean(
    entity &&
    claimValue(entity,"P225") &&
    String(claimValue(entity,"P225")).toLowerCase().replace(/\s+/g," ").trim()===normalizedQuery
  );
  const mediaAttempts = [
    {
      resolver:"wikipedia-pageimage",
      confidence:exactTaxonIdentity?"HIGH":"MEDIUM",
      run:async () => {
        if(!page?.pageimage)return null;

        try {
          const local = await getWikipediaFileMetadata(page.pageimage,lang);
          if(local)return local;
        } catch {}

        try {
          const commons = await getCommonsFileMetadata(page.pageimage);
          if(commons)return commons;
        } catch {}

        return wikipediaThumbnailFallback(page,lang);
      },
    },
    {
      resolver:"wikidata-p18",
      confidence:exactTaxonIdentity?"HIGH":"MEDIUM",
      run:async () => {
        if(!wikidataImage)return null;
        try {
          const commons=await getCommonsFileMetadata(wikidataImage);
          if(commons)return commons;
        } catch {}
        try {
          return await getWikipediaFileMetadata(wikidataImage,lang);
        } catch {
          return null;
        }
      },
    },
    {
      resolver:"gbif-exact",
      confidence:"HIGH",
      run:async () => looksLikeSpecies ? searchGbifImage(taxonName) : null,
    },
    {
      resolver:"commons-exact",
      confidence:"MEDIUM",
      run:async () => searchCommonsImage(taxonName,{exact:true}),
    },
    {
      resolver:"commons-query-exact",
      confidence:"LOW",
      run:async () => normalizedQuery!==normalizedTaxon ? searchCommonsImage(normalized,{exact:true}) : null,
    },
  ];
  let bestCandidate=null;
  for (const attempt of mediaAttempts) {
    try {
      const result=await attempt.run();
      if(!result)continue;

      const candidate={
        media:result,
        resolver:attempt.resolver,
        confidence:attempt.confidence,
      };

      bestCandidate=chooseBestMediaCandidate([bestCandidate,candidate]);

      // A fully attributed, high-confidence candidate cannot be improved for
      // card readiness, so stop before spending more provider requests.
      if(
        bestCandidate &&
        String(bestCandidate.confidence).toUpperCase()==="HIGH" &&
        hasCompleteAttribution(bestCandidate.media)
      ) break;
    } catch {
      // A failed provider must not prevent the next fallback.
    }
  }

  if(bestCandidate){
    media={
      ...bestCandidate.media,
      resolver:bestCandidate.resolver,
      confidence:bestCandidate.confidence,
      exactTaxonIdentity,
    };
  }

  const value = {
    query: normalized,
    wikipedia: page
      ? {
          title: page.title,
          extract: page.extract || "",
          description,
          pageUrl: page.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
          thumbnailUrl: page.thumbnail?.source || null,
          pageImage: page.pageimage || null,
          language: lang,
        }
      : null,
    wikidata: qid
      ? {
          id: qid,
          pageUrl: `https://www.wikidata.org/wiki/${qid}`,
          taxonName,
          ncbiTaxId: taxId,
          imageFile: wikidataImage,
        }
      : null,
    taxonomy: {
      ncbiTaxId: taxId,
      ncbiUrl: ncbiUrlForTaxId(taxId),
      lifemapUrl: lifemapUrlForTaxId(taxId),
    },
    media,
    sources: [
      page ? "Wikipedia" : null,
      entity ? "Wikidata" : null,
      media ? media.source : null,
      taxId ? "NCBI Taxonomy / Lifemap NCBI" : null,
    ].filter(Boolean),
    sourceStatus: {
      wikipedia: page ? "ok" : "unavailable",
      wikidata: entity ? "ok" : "unavailable",
      media: media ? "ok" : "unavailable",
      lifemap: taxId ? "linked" : "unresolved",
    },
    resolvedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, { storedAt: Date.now(), value });
  writePersistentCache(persistedQuery, lang, value);
  return value;
}


export async function getKnowledgeBatch(entries, { lang = "en", concurrency = 4 } = {}) {
  const normalized = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry?.id ?? "").trim();
    const query = String(entry?.query ?? "").trim();
    if (!id || !query || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, query });
    if (normalized.length >= 24) break;
  }

  const output = {};
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(6, Number(concurrency) || 4));

  async function worker() {
    while (cursor < normalized.length) {
      const item = normalized[cursor++];
      try {
        output[item.id] = await getKnowledge(item.query, { lang });
      } catch {
        output[item.id] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workerCount, normalized.length || 1) }, () => worker())
  );

  return output;
}


function lowerKey(value=""){
  return String(value||"").trim().toLowerCase();
}

async function wikipediaPagesBatch(entries,{lang="en"}={}){
  const safeLang=String(lang||"en").replace(/[^a-z-]/gi,"").slice(0,12)||"en";
  const queries=[...new Set(entries.map((entry)=>String(entry.query||"").trim()).filter(Boolean))];
  const output=new Map();
  const transientFailures=new Set();

  for(let offset=0;offset<queries.length;offset+=40){
    const chunk=queries.slice(offset,offset+40);
    const params=new URLSearchParams({
      action:"query",
      format:"json",
      origin:"*",
      redirects:"1",
      prop:"pageimages|pageprops|info",
      titles:chunk.join("|"),
      piprop:"thumbnail|name|original",
      pilicense:"free",
      pithumbsize:"1200",
      inprop:"url",
      maxlag:"5",
    });

    let json=null;
    try{
      json=await fetchJson(
        `https://${safeLang}.wikipedia.org/w/api.php?${params}`,
        12000,
        {retries:3}
      );
    }catch{
      for(const query of chunk)transientFailures.add(lowerKey(query));
      continue;
    }

    const aliases=new Map();
    for(const item of json?.query?.normalized??[]){
      aliases.set(lowerKey(item.from),item.to);
    }
    for(const item of json?.query?.redirects??[]){
      aliases.set(lowerKey(item.from),item.to);
    }

    const pages=Object.values(json?.query?.pages??{}).filter((page)=>page&&!page.missing);
    const pageByTitle=new Map(pages.map((page)=>[lowerKey(page.title),page]));

    for(const original of chunk){
      let title=original;
      const seen=new Set();
      while(aliases.has(lowerKey(title))&&!seen.has(lowerKey(title))){
        seen.add(lowerKey(title));
        title=aliases.get(lowerKey(title));
      }
      const page=pageByTitle.get(lowerKey(title))||pageByTitle.get(lowerKey(original))||null;
      if(page){
        output.set(lowerKey(original),{
          ...page,
          _lifecardsMatch:
            lowerKey(page.title)===lowerKey(original)
              ?"exact-title"
              :(lowerKey(title)!==lowerKey(original)?"redirect":"resolved"),
          _lifecardsRequestedTitle:original,
        });
      }
    }
  }

  return {pages:output,transientFailures};
}

async function wikidataEntitiesBatch(qids,{lang="en"}={}){
  const unique=[...new Set(qids.filter(Boolean))];
  const output={};

  for(let offset=0;offset<unique.length;offset+=40){
    const chunk=unique.slice(offset,offset+40);
    const params=new URLSearchParams({
      action:"wbgetentities",
      format:"json",
      origin:"*",
      ids:chunk.join("|"),
      props:"claims|labels|descriptions|sitelinks",
      languages:`${lang}|en`,
    });

    try{
      const json=await fetchJson(`https://www.wikidata.org/w/api.php?${params}`,12000,{retries:3});
      Object.assign(output,json?.entities??{});
    }catch{}
  }

  return output;
}

export async function getAuditKnowledgeBatch(entries,{lang="en"}={}){
  const normalized=[];
  const seen=new Set();

  for(const entry of Array.isArray(entries)?entries:[]){
    const id=String(entry?.id??"").trim();
    const query=String(entry?.query??"").trim();
    if(!id||!query||seen.has(id))continue;
    seen.add(id);
    normalized.push({id,query});
  }
  if(!normalized.length)return {};

  const pageBatch=await wikipediaPagesBatch(normalized,{lang});
  const pages=pageBatch.pages;
  const transientFailures=pageBatch.transientFailures;
  const qids=[...new Set(
    [...pages.values()].map((page)=>page?.pageprops?.wikibase_item).filter(Boolean)
  )];
  const entities=await wikidataEntitiesBatch(qids,{lang});

  const pageImages=[...new Set(
    [...pages.values()].map((page)=>page?.pageimage).filter(Boolean)
  )];
  const wikidataImages=[...new Set(
    Object.values(entities).map((entity)=>claimValue(entity,"P18")).filter(Boolean)
  )];
  const candidateFiles=[...new Set([...pageImages,...wikidataImages])];

  const wikipediaFileMetadata=await getWikipediaFilesMetadataBatch(candidateFiles,lang);

  const unresolvedAttribution=candidateFiles.filter((name)=>{
    const media=wikipediaFileMetadata[normalizeMediaFileKey(name)]||null;
    return !hasCompleteAttribution(media);
  });

  const commonsFileMetadata=unresolvedAttribution.length
    ?await getCommonsFilesMetadataBatch(unresolvedAttribution)
    :{};

  const output={};
  const fallback=[];

  for(const entry of normalized){
    if(transientFailures.has(lowerKey(entry.query))){
      output[entry.id]={
        query:entry.query,
        media:null,
        auditTransientError:"wikipedia batch temporarily unavailable",
        sourceStatus:{wikipedia:"transient-error",media:"unavailable"},
      };
      continue;
    }
    const page=pages.get(lowerKey(entry.query))||null;
    const qid=page?.pageprops?.wikibase_item||null;
    const entity=qid?entities[qid]||null:null;
    const taxonName=claimValue(entity,"P225")||entry.query;
    const taxId=claimValue(entity,"P685");
    const exactTaxonIdentity=Boolean(
      claimValue(entity,"P225") &&
      lowerKey(claimValue(entity,"P225"))===lowerKey(entry.query)
    );
    const exactWikipediaTitle=page?._lifecardsMatch==="exact-title";
    const trustedIdentity=exactTaxonIdentity||exactWikipediaTitle;

    let media=null;
    const mediaCandidates=[];

    if(page?.pageimage){
      const key=normalizeMediaFileKey(page.pageimage);
      const local=wikipediaFileMetadata[key]||null;
      const commons=commonsFileMetadata[key]||null;
      const pageMedia=
        (hasCompleteAttribution(local)?local:null) ||
        (hasCompleteAttribution(commons)?commons:null) ||
        local ||
        commons ||
        wikipediaThumbnailFallback(page,lang);

      if(pageMedia){
        mediaCandidates.push({
          media:pageMedia,
          resolver:
            hasCompleteAttribution(commons)&&!hasCompleteAttribution(local)
              ?"wikipedia-pageimage+commons-batch"
              :"wikipedia-pageimage-batch",
          confidence:trustedIdentity?"HIGH":"MEDIUM",
        });
      }
    }

    const p18=claimValue(entity,"P18");
    if(p18){
      const key=normalizeMediaFileKey(p18);
      const local=wikipediaFileMetadata[key]||null;
      const commons=commonsFileMetadata[key]||null;
      const p18Media=
        (hasCompleteAttribution(commons)?commons:null) ||
        (hasCompleteAttribution(local)?local:null) ||
        commons ||
        local;

      if(p18Media){
        mediaCandidates.push({
          media:p18Media,
          resolver:
            hasCompleteAttribution(commons)
              ?"wikidata-p18+commons-batch"
              :"wikidata-p18-batch",
          confidence:trustedIdentity?"HIGH":"MEDIUM",
        });
      }
    }

    const best=chooseBestMediaCandidate(mediaCandidates);
    if(best){
      media={
        ...best.media,
        resolver:best.resolver,
        confidence:best.confidence,
        exactTaxonIdentity,
        exactWikipediaTitle,
        wikipediaMatch:page?._lifecardsMatch||null,
      };
    }

    if(page&&media&&hasCompleteAttribution(media)){
      const value={
        query:entry.query,
        wikipedia:{
          title:page.title,
          extract:"",
          description:entity?.descriptions?.[lang]?.value||entity?.descriptions?.en?.value||null,
          pageUrl:page.fullurl||`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ","_"))}`,
          thumbnailUrl:page.thumbnail?.source||null,
          pageImage:page.pageimage||null,
          language:lang,
        },
        wikidata:qid?{
          id:qid,
          pageUrl:`https://www.wikidata.org/wiki/${qid}`,
          taxonName,
          ncbiTaxId:taxId,
          imageFile:claimValue(entity,"P18"),
        }:null,
        taxonomy:{
          ncbiTaxId:taxId,
          ncbiUrl:ncbiUrlForTaxId(taxId),
          lifemapUrl:lifemapUrlForTaxId(taxId),
        },
        media,
        sources:["Wikipedia",entity?"Wikidata":null,media.source,taxId?"NCBI Taxonomy / Lifemap NCBI":null].filter(Boolean),
        sourceStatus:{
          wikipedia:"ok",
          wikidata:entity?"ok":"unavailable",
          media:"ok",
          lifemap:taxId?"linked":"unresolved",
        },
        resolvedAt:new Date().toISOString(),
      };
      output[entry.id]=value;

      const persistedQuery=`${CACHE_SCHEMA_VERSION}:${entry.query.toLowerCase()}`;
      cache.set(`${lang}:${persistedQuery}`,{storedAt:Date.now(),value});
      writePersistentCache(persistedQuery,lang,value);
    }else{
      fallback.push(entry);
    }
  }

  // Bulk audits deliberately cap expensive per-item fallbacks. Wikimedia
  // batches are the scalable first pass; unresolved taxa can be retried later.
  const fallbackBudget=Math.min(4,fallback.length);
  for(let index=0;index<fallbackBudget;index+=1){
    const entry=fallback[index];
    try{
      output[entry.id]=await getKnowledge(entry.query,{lang});
    }catch{
      output[entry.id]=null;
    }
    await new Promise((resolve)=>setTimeout(resolve,350));
  }

  return output;
}
