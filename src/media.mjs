import crypto from "node:crypto";
const ACCEPTED_LICENSE_MARKERS = ["cc by", "cc-by", "cc0", "public domain", "pd-"];
const memoryCache = new Map();

export function normalizeMediaFileKey(value = "") {
  return String(value || "")
    .replace(/^File:/i, "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanHtml(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function acceptedLicense(metadata = {}) {
  const raw = [metadata.LicenseShortName?.value, metadata.License?.value, metadata.UsageTerms?.value]
    .filter(Boolean).join(" ").toLowerCase();

  const disallowed = [
    "cc by-nc", "cc-by-nc", "noncommercial", "non-commercial",
    "cc by-nd", "cc-by-nd", "no derivatives", "noderivatives",
  ];
  if (disallowed.some((marker) => raw.includes(marker))) return false;

  return ACCEPTED_LICENSE_MARKERS.some((marker) => raw.includes(marker));
}

function mediaFromPage(page, sourceLabel = "Wikimedia Commons") {
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata ?? {};
  if (!info?.thumburl || !acceptedLicense(meta)) return null;
  return {
    imageUrl: info.thumburl,
    originalUrl: info.descriptionurl ?? info.url,
    title: page.title,
    creator: cleanHtml(meta.Artist?.value || meta.Credit?.value || "Unknown creator"),
    license: cleanHtml(meta.LicenseShortName?.value || meta.UsageTerms?.value || "See source"),
    licenseUrl: meta.LicenseUrl?.value || info.descriptionurl || null,
    attribution: cleanHtml(meta.Attribution?.value || meta.Credit?.value || meta.Artist?.value || "Wikimedia Commons"),
    source: sourceLabel,
  };
}

async function fetchJsonWithRetry(url, label, timeoutMs = 8000) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "LifeCards/0.1 (licensed media resolver)" },
      });
      if (response.ok) return response.json();
      lastError = new Error(`${label} returned ${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error(`${label} request failed`);
}

async function commonsQuery(params) {
  return fetchJsonWithRetry(
    `https://commons.wikimedia.org/w/api.php?${params}`,
    "Wikimedia Commons"
  );
}

async function wikipediaFileQuery(lang, params) {
  const safeLang=String(lang||"en").replace(/[^a-z-]/gi,"").slice(0,12)||"en";
  return fetchJsonWithRetry(
    `https://${safeLang}.wikipedia.org/w/api.php?${params}`,
    `Wikipedia (${safeLang})`
  );
}

export function wikipediaThumbnailFallback(page, lang = "en") {
  const imageUrl = page?.original?.source || page?.thumbnail?.source || null;
  if (!imageUrl) return null;

  return {
    imageUrl,
    originalUrl: page?.fullurl || imageUrl,
    title: page?.pageimage ? `File:${page.pageimage}` : page?.title || "Wikipedia image",
    creator: null,
    license: "Free image selected by Wikipedia PageImages",
    licenseUrl: page?.fullurl || null,
    attribution: "Attribution pending file metadata resolution",
    source: `Wikipedia (${lang})`,
    metadataPending: true,
  };
}

export async function getWikipediaFileMetadata(fileName, lang = "en") {
  const normalized=String(fileName||"").replace(/^File:/i,"").trim();
  if(!normalized)return null;
  const key=`wiki-file:${lang}:${normalized.toLowerCase()}`;
  if(memoryCache.has(key))return memoryCache.get(key);

  const params=new URLSearchParams({
    action:"query",
    format:"json",
    origin:"*",
    titles:`File:${normalized}`,
    prop:"imageinfo",
    iiprop:"url|extmetadata",
    iiextmetadatafilter:"Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth:"1200",
  });

  const json=await wikipediaFileQuery(lang,params);
  const page=Object.values(json?.query?.pages??{})[0]??null;
  const result=mediaFromPage(page,`Wikipedia (${lang})`);
  memoryCache.set(key,result);
  return result;
}

export async function getCommonsFileMetadata(fileName) {
  const normalized = String(fileName || "").replace(/^File:/i, "").trim();
  if (!normalized) return null;
  const key = `file:${normalized.toLowerCase()}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    titles: `File:${normalized}`,
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiextmetadatafilter: "Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth: "1200",
  });

  const json = await commonsQuery(params);
  const page = Object.values(json?.query?.pages ?? {})[0] ?? null;
  const result = mediaFromPage(page);
  memoryCache.set(key, result);
  return result;
}

export async function searchCommonsImage(query, { exact = false } = {}) {
  const normalized=String(query || "").trim();
  const key = `search:${exact?"exact:":"broad:"}${normalized.toLowerCase()}`;
  if (!normalized) return null;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const searchExpression = exact ? `intitle:"${normalized.replaceAll('"', '')}"` : normalized;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: searchExpression,
    gsrnamespace: "6",
    gsrlimit: exact ? "12" : "6",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiextmetadatafilter: "Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
    iiurlwidth: "1200",
  });

  const json = await commonsQuery(params);
  const pages = Object.values(json?.query?.pages ?? {});
  const needle=normalized.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  for (const page of pages) {
    if(exact){
      const title=String(page.title||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
      if(!needle.split(/\s+/).every(token=>title.includes(token)))continue;
    }
    const result = mediaFromPage(page);
    if (!result) continue;
    memoryCache.set(key, result);
    return result;
  }

  memoryCache.set(key, null);
  return null;
}


function normalizeScientificName(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function acceptedOpenLicense(value = "") {
  const license=String(value||"").trim().toLowerCase();
  if(!license)return false;
  if(license==="cc0"||license==="cc-by"||license==="cc-by-sa")return true;
  if(license.includes("creativecommons.org/publicdomain")||license.includes("creativecommons.org/zero"))return true;
  if(license.includes("creativecommons.org/licenses/by/")||license.includes("creativecommons.org/licenses/by-sa/"))return true;
  return false;
}

function largeINaturalistPhotoUrl(url = "") {
  const value=String(url||"");
  if(!value)return null;
  return value
    .replace("/square.", "/large.")
    .replace("/small.", "/large.")
    .replace("/medium.", "/large.");
}

let lastINaturalistRequestAt=0;
async function throttleINaturalist() {
  const elapsed=Date.now()-lastINaturalistRequestAt;
  if(elapsed<1050){
    await new Promise((resolve)=>setTimeout(resolve,1050-elapsed));
  }
  lastINaturalistRequestAt=Date.now();
}

function acceptedGbifMediaLicense(value = "") {
  const license = String(value).trim().toLowerCase();
  if (!license) return false;
  if (license.includes("creativecommons.org/publicdomain") || license.includes("creativecommons.org/zero") || license === "cc0") return true;
  if (license.includes("creativecommons.org/licenses/by/") || license.includes("creativecommons.org/licenses/by-sa/")) return true;
  if (/^cc\s*by(?:-sa)?(?:\s|$)/i.test(String(value))) return true;
  return false;
}

function gbifImageUrl(recordKey, identifier) {
  if (!recordKey || !identifier) return identifier || null;
  const hash = crypto.createHash("md5").update(String(identifier)).digest("hex");
  return `https://api.gbif.org/v1/image/cache/800x/occurrence/${recordKey}/media/${hash}`;
}

export async function searchGbifImage(scientificName) {
  const query=String(scientificName||"").trim();
  if(!query)return null;

  const key=`gbif:${query.toLowerCase()}`;
  if(memoryCache.has(key))return memoryCache.get(key);

  async function occurrenceSearch(paramsObject){
    const params=new URLSearchParams({
      mediaType:"StillImage",
      occurrenceStatus:"present",
      limit:"50",
      ...paramsObject,
    });
    return fetchJsonWithRetry(
      `https://api.gbif.org/v1/occurrence/search?${params}`,
      "GBIF",
      9000
    );
  }

  function choose(json){
    const canonical=normalizeScientificName(query);
    for(const occurrence of json?.results??[]){
      const occurrenceName=normalizeScientificName(
        occurrence.acceptedScientificName||
        occurrence.species||
        occurrence.scientificName||
        ""
      );
      if(!occurrenceName.startsWith(canonical))continue;

      for(const item of occurrence.media??[]){
        const identifier=item.identifier||item.references;
        const license=item.license||"";
        if(!identifier||!acceptedGbifMediaLicense(license))continue;

        return {
          imageUrl:gbifImageUrl(occurrence.key,identifier),
          originalUrl:item.references||identifier,
          title:occurrence.scientificName||query,
          creator:cleanHtml(
            item.creator||
            item.rightsHolder||
            occurrence.recordedBy||
            occurrence.institutionCode||
            occurrence.datasetTitle||
            "GBIF contributor"
          ),
          license:cleanHtml(license),
          licenseUrl:/^https?:/i.test(license)?license:null,
          attribution:cleanHtml(
            item.rightsHolder||
            item.creator||
            occurrence.institutionCode||
            occurrence.datasetTitle||
            "GBIF occurrence media"
          ),
          source:"GBIF occurrence media",
          occurrenceKey:occurrence.key||null,
          mediaMatch:"EXACT_OR_ACCEPTED",
        };
      }
    }
    return null;
  }

  try{
    const direct=choose(await occurrenceSearch({scientificName:query}));
    if(direct){
      memoryCache.set(key,direct);
      return direct;
    }
  }catch{}

  // Resolve the GBIF accepted taxon key so media published under synonyms or
  // alternate combinations can still be discovered.
  try{
    const matchParams=new URLSearchParams({name:query,verbose:"true"});
    const match=await fetchJsonWithRetry(
      `https://api.gbif.org/v1/species/match?${matchParams}`,
      "GBIF species match",
      8000
    );
    const acceptedKey=match?.acceptedUsageKey||match?.usageKey||null;
    if(acceptedKey){
      const accepted=choose(await occurrenceSearch({acceptedTaxonKey:String(acceptedKey)}));
      if(accepted){
        accepted.resolverHint="gbif-accepted-taxon";
        memoryCache.set(key,accepted);
        return accepted;
      }
    }
  }catch{}

  memoryCache.set(key,null);
  return null;
}

export async function searchIDigBioImage(scientificName,{rank=""}={}) {
  const query=String(scientificName||"").trim();
  if(!query)return null;

  const rankKey=String(rank||"").toLowerCase();
  const field=["genus","family","order","class","phylum"].includes(rankKey)
    ?rankKey
    :"scientificname";
  const key=`idigbio:${field}:${query.toLowerCase()}`;
  if(memoryCache.has(key))return memoryCache.get(key);

  const rq=JSON.stringify({[field]:query});
  const params=new URLSearchParams({rq,limit:"20"});

  let json=null;
  try{
    json=await fetchJsonWithRetry(
      `https://search.idigbio.org/v2/search/media/?${params}`,
      "iDigBio",
      12000
    );
  }catch{
    memoryCache.set(key,null);
    return null;
  }

  for(const item of json?.items??[]){
    const data=item?.data||{};
    const idx=item?.indexTerms||{};
    const format=String(data["dcterms:format"]||idx.format||"").toLowerCase();
    if(format&&!format.startsWith("image/"))continue;
    if(format.includes("svg"))continue;

    const imageUrl=
      data["ac:goodQualityAccessURI"]||
      data["ac:accessURI"]||
      idx.accessuri||
      null;
    if(!imageUrl)continue;

    const rights=[
      data["xmpRights:UsageTerms"],
      data["dc:rights"],
      data["dcterms:rights"],
      idx.rights,
      idx.webstatement,
      idx.licenselogourl,
    ].filter(Boolean).join(" ");

    if(!acceptedOpenLicense(rights))continue;

    const creator=cleanHtml(
      data["dc:creator"]||
      data["xmpRights:Owner"]||
      data["dcterms:rightsHolder"]||
      idx.rightsowner||
      "Museum collection"
    );

    const originalUrl=
      data["ac:providerManagedID"]||
      data["ac:providerManagedIDURL"]||
      idx.webstatement||
      imageUrl;

    const result={
      imageUrl,
      originalUrl,
      title:query,
      creator,
      license:cleanHtml(
        data["xmpRights:UsageTerms"]||
        data["dc:rights"]||
        idx.rights||
        "Open specimen media"
      ),
      licenseUrl:
        /^https?:/i.test(String(idx.webstatement||""))
          ?idx.webstatement
          :(/^https?:/i.test(String(data["xmpRights:UsageTerms"]||""))
            ?data["xmpRights:UsageTerms"]
            :null),
      attribution:creator,
      source:"iDigBio museum specimen media",
      specimenMediaId:item.uuid||null,
      mediaMatch:field==="scientificname"?"EXACT_SPECIMEN":"REPRESENTATIVE_SPECIMEN",
    };

    memoryCache.set(key,result);
    return result;
  }

  memoryCache.set(key,null);
  return null;
}

export async function searchINaturalistImage(scientificName,{allowDescendant=false}={}) {
  const query=String(scientificName||"").trim();
  if(!query)return null;

  const key=`inat:${allowDescendant?"desc:":"exact:"}${query.toLowerCase()}`;
  if(memoryCache.has(key))return memoryCache.get(key);

  await throttleINaturalist();

  const params=new URLSearchParams({
    taxon_name:query,
    photos:"true",
    quality_grade:"research",
    photo_license:"cc0,cc-by,cc-by-sa",
    per_page:"30",
    order:"desc",
    order_by:"votes",
  });

  let json=null;
  try{
    json=await fetchJsonWithRetry(
      `https://api.inaturalist.org/v1/observations?${params}`,
      "iNaturalist",
      10000
    );
  }catch{
    memoryCache.set(key,null);
    return null;
  }

  const canonical=normalizeScientificName(query);
  for(const observation of json?.results??[]){
    const observedName=normalizeScientificName(observation?.taxon?.name||"");
    const exact=observedName===canonical;
    if(!exact&&!allowDescendant)continue;

    for(const photo of observation.photos??[]){
      const license=String(photo.license_code||"").toLowerCase();
      if(!acceptedOpenLicense(license))continue;
      const imageUrl=largeINaturalistPhotoUrl(photo.url);
      if(!imageUrl)continue;

      const creator=cleanHtml(
        photo.attribution||
        observation?.user?.name||
        observation?.user?.login||
        "iNaturalist contributor"
      );

      const result={
        imageUrl,
        originalUrl:observation.uri||`https://www.inaturalist.org/observations/${observation.id}`,
        title:observation?.taxon?.name||query,
        creator,
        license:license.toUpperCase(),
        licenseUrl:
          license==="cc0"
            ?"https://creativecommons.org/publicdomain/zero/1.0/"
            :`https://creativecommons.org/licenses/${license.replace("cc-","")}/4.0/`,
        attribution:creator,
        source:"iNaturalist research-grade observation",
        observationId:observation.id||null,
        mediaMatch:exact?"EXACT":"REPRESENTATIVE_DESCENDANT",
      };
      memoryCache.set(key,result);
      return result;
    }
  }

  memoryCache.set(key,null);
  return null;
}

function acceptedEolLicense(value=""){
  return acceptedOpenLicense(value);
}

export async function searchEolImage(scientificName) {
  const query=String(scientificName||"").trim();
  if(!query)return null;
  const key=`eol:${query.toLowerCase()}`;
  if(memoryCache.has(key))return memoryCache.get(key);

  try{
    const searchParams=new URLSearchParams({q:query,page:"1",exact:"true"});
    const found=await fetchJsonWithRetry(
      `https://eol.org/api/search/1.0.json?${searchParams}`,
      "EOL search",
      9000
    );
    const candidate=(found?.results??[]).find((item)=>
      normalizeScientificName(item?.title||"")===normalizeScientificName(query)
    )||(found?.results??[])[0];

    if(!candidate?.id){
      memoryCache.set(key,null);
      return null;
    }

    const pageParams=new URLSearchParams({
      details:"true",
      images_per_page:"12",
      videos_per_page:"0",
      sounds_per_page:"0",
      maps_per_page:"0",
      texts_per_page:"0",
      vetted:"1",
      language:"en",
    });
    const page=await fetchJsonWithRetry(
      `https://eol.org/api/pages/1.0/${candidate.id}.json?${pageParams}`,
      "EOL page",
      10000
    );

    for(const object of page?.dataObjects??[]){
      const imageUrl=object.eolMediaURL||object.mediaURL||object.thumbnailURL||null;
      const license=object.license||"";
      if(!imageUrl||!acceptedEolLicense(license))continue;

      const creator=cleanHtml(
        object.rightsHolder||
        object.agents?.map((agent)=>agent?.full_name||agent?.homepage).filter(Boolean).join(", ")||
        object.source||
        "EOL content partner"
      );

      const result={
        imageUrl,
        originalUrl:object.source||object.eolMediaURL||imageUrl,
        title:object.title||candidate.title||query,
        creator,
        license:cleanHtml(license),
        licenseUrl:/^https?:/i.test(license)?license:null,
        attribution:creator,
        source:"Encyclopedia of Life",
        eolPageId:candidate.id,
        mediaMatch:"EXACT_AGGREGATED",
      };
      memoryCache.set(key,result);
      return result;
    }
  }catch{}

  memoryCache.set(key,null);
  return null;
}

export async function searchSupplementalRealMedia(scientificName,{rank=""}={}) {
  const query=String(scientificName||"").trim();
  if(!query)return null;

  try{
    const gbif=await searchGbifImage(query);
    if(gbif)return {...gbif,resolver:gbif.resolverHint||"gbif-exact-or-accepted",confidence:"HIGH"};
  }catch{}

  const rankKey=String(rank||"").toLowerCase();
  const allowDescendant=![
    "species","subspecies","variety","subvariety","form","subform","strain"
  ].includes(rankKey);

  try{
    const specimen=await searchIDigBioImage(query,{rank});
    if(specimen)return {
      ...specimen,
      resolver:specimen.mediaMatch==="EXACT_SPECIMEN"
        ?"idigbio-exact-specimen"
        :"idigbio-representative-specimen",
      confidence:specimen.mediaMatch==="EXACT_SPECIMEN"?"HIGH":"MEDIUM",
    };
  }catch{}

  try{
    const inat=await searchINaturalistImage(query,{allowDescendant});
    if(inat)return {
      ...inat,
      resolver:inat.mediaMatch==="EXACT"?"inaturalist-exact":"inaturalist-representative",
      confidence:inat.mediaMatch==="EXACT"?"HIGH":"MEDIUM",
    };
  }catch{}

  // EOL is intentionally not auto-promoted here yet: its aggregate media can
  // include illustrations as well as photographs. Keep it available for a
  // later typed-media pass rather than violating strict real-photo mode.

  try{
    const commons=await searchCommonsImage(query,{exact:true});
    if(commons)return {...commons,resolver:"commons-exact",confidence:"MEDIUM"};
  }catch{}

  return null;
}


export async function getWikipediaFilesMetadataBatch(fileNames, lang = "en") {
  const safeLang=String(lang||"en").replace(/[^a-z-]/gi,"").slice(0,12)||"en";
  const unique=[...new Set((fileNames||[])
    .map((name)=>String(name||"").replace(/^File:/i,"").trim())
    .filter(Boolean))];
  const output={};

  for(let offset=0;offset<unique.length;offset+=40){
    const chunk=unique.slice(offset,offset+40);
    const params=new URLSearchParams({
      action:"query",
      format:"json",
      origin:"*",
      titles:chunk.map((name)=>`File:${name}`).join("|"),
      prop:"imageinfo",
      iiprop:"url|extmetadata",
      iiextmetadatafilter:"Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
      iiurlwidth:"1200",
    });

    let json=null;
    try{
      json=await wikipediaFileQuery(safeLang,params);
    }catch{
      json=null;
    }

    for(const page of Object.values(json?.query?.pages??{})){
      const name=String(page?.title||"").replace(/^File:/i,"").trim();
      if(!name)continue;
      output[normalizeMediaFileKey(name)]=mediaFromPage(page,`Wikipedia (${safeLang})`);
    }
  }

  return output;
}


export async function getCommonsFilesMetadataBatch(fileNames) {
  const unique=[...new Set((fileNames||[])
    .map((name)=>String(name||"").replace(/^File:/i,"").trim())
    .filter(Boolean))];
  const output={};

  for(let offset=0;offset<unique.length;offset+=40){
    const chunk=unique.slice(offset,offset+40);
    const params=new URLSearchParams({
      action:"query",
      format:"json",
      origin:"*",
      titles:chunk.map((name)=>`File:${name}`).join("|"),
      prop:"imageinfo",
      iiprop:"url|extmetadata",
      iiextmetadatafilter:"Artist|Credit|LicenseShortName|UsageTerms|LicenseUrl|Attribution",
      iiurlwidth:"1200",
    });

    let json=null;
    try{
      json=await commonsQuery(params);
    }catch{
      json=null;
    }

    for(const page of Object.values(json?.query?.pages??{})){
      const name=String(page?.title||"").replace(/^File:/i,"").trim();
      if(!name)continue;
      const value=mediaFromPage(page,"Wikimedia Commons");
      if(value)output[normalizeMediaFileKey(name)]=value;
    }
  }

  return output;
}

export function hasCompleteAttribution(media) {
  const creator=String(media?.creator||"").trim();
  const license=String(media?.license||"").trim();
  const creatorPlaceholder=/^(unknown creator|unknown|—)$/i.test(creator);
  const licensePlaceholder=/^(see source|unknown|—)$/i.test(license);

  return Boolean(
    media?.imageUrl &&
    media?.originalUrl &&
    creator &&
    license &&
    !creatorPlaceholder &&
    !licensePlaceholder
  );
}
