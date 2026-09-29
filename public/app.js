import { RadialTreeMap } from "./radial-tree.js";

const ui={
  view:"packs",
  state:null,
  media:new Map(),
  mediaLoading:new Set(),
  definitionIndex:new Map(),
  cardIndex:new Map(),
  knowledge:new Map(),
  knowledgeLoading:new Set(),
  collectionFilter:"ALL",
  collectionMode:"DISCOVERIES",
  collectionSort:"RARITY",
  collectionData:null,
  collectionLoading:false,
  collectionPage:0,
  collectionPageSize:30,
  collectionRequestToken:0,
  marketFilter:"ALL",
  marketSort:"NEWEST",
  marketQuery:"",
  marketData:null,
  marketLoading:false,
  marketPage:0,
  marketPageSize:24,
  marketRequestToken:0,
  supplyCache:new Map(),
  supplyLoading:new Set(),
  query:"",
  codexQuery:"",
  codexResults:[],
  codexSearchLoading:false,
  codexRank:"ALL",
  codexOwned:new Set(),
  taxonomyContext:new Map(),
  taxonomyContextLoading:new Set(),
  treeQuery:"",
  treeSearchResults:[],
  treePayload:null,
  treeTargetId:null,
  treeExpandedRoots:new Set(),
  taxonomyStatus:null,
  favorites:new Set(JSON.parse(localStorage.getItem("lifecards:favorites")||"[]")),
  reveal:null,
  revealIndex:0,
  opening:false,
  stateFetchedAt:Date.now()
};

const main=document.getElementById("main");
const coins=document.getElementById("coins");
const packBadge=document.getElementById("packBadge");
const revealDialog=document.getElementById("reveal");
const revealScene=document.getElementById("revealScene");
const cardModal=document.getElementById("cardModal");
const cardModalContent=document.getElementById("cardModalContent");
const toast=document.getElementById("toast");
let radialMap=null;
let treeSearchTimer=null;
let codexSearchTimer=null;
let collectionSearchTimer=null;
let mediaBatchTimer=null;
const mediaBatchQueue=new Set();

const RARITY={
  COMMON:{label:"Common",short:"C"},
  UNCOMMON:{label:"Uncommon",short:"U"},
  RARE:{label:"Rare",short:"R"},
  SUPER_RARE:{label:"Super Rare",short:"SR"},
  ULTRA_RARE:{label:"Ultra Rare",short:"UR"},
  LEGENDARY:{label:"Legendary",short:"L"},
  MYTHIC:{label:"Mythic",short:"M"},
  UNKNOWN:{label:"Unknown",short:"?"}
};

const TITLES={
  packs:["FIELD DROPS","Open a pack"],
  collection:["YOUR ARCHIVE","Collection"],
  tree:["PHYLOGENETIC ALBUM","Tree of Life"],
  market:["SECONDARY MARKET","Market"],
  codex:["LIVING ENCYCLOPEDIA","Codex"]
};

async function api(path,options={}){
  const response=await fetch(path,{
    ...options,
    headers:{"Content-Type":"application/json","x-lifecards-user":"explorer",...(options.headers||{})}
  });
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||"Request failed");
  return body;
}

function esc(value=""){
  return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

function formatNumber(value){return new Intl.NumberFormat("en-US").format(value)}

function liveNextPackMs(){
  if(!ui.state)return 0;
  if(ui.state.user.packs>=ui.state.user.maxPacks)return 0;
  return Math.max(0,ui.state.user.nextPackInMs-(Date.now()-ui.stateFetchedAt));
}

function supplyFor(definitionId,edition){
  return (ui.supplyCache.get(String(definitionId))||[])
    .find(s=>s.definitionId===definitionId&&s.edition===edition)||null;
}

async function loadSupplies(definitionId){
  const key=String(definitionId||"");
  if(!key||ui.supplyCache.has(key)||ui.supplyLoading.has(key))return;
  ui.supplyLoading.add(key);
  try{
    const result=await api("/api/supplies?definitionId="+encodeURIComponent(key));
    ui.supplyCache.set(key,result.items||[]);
  }catch{
    ui.supplyCache.set(key,[]);
  }finally{
    ui.supplyLoading.delete(key);
  }
}

function formatTimer(ms){
  const total=Math.max(0,Math.ceil(ms/1000));
  return String(Math.floor(total/60)).padStart(2,"0")+":"+String(total%60).padStart(2,"0");
}

function serial(card){
  if(card.edition==="ORIGIN")return "#1 / 1";
  const left="#"+String(card.serial).padStart(6,"0");
  return card.serialCap?left+" / "+formatNumber(card.serialCap):left;
}

function editionClass(edition=""){
  if(edition.includes("WILD"))return "wild";
  if(edition.includes("FOSSIL"))return "fossil";
  if(edition.includes("FOUNDATION"))return "foundation";
  if(edition==="ORIGIN")return "origin";
  return "research";
}

function getMedia(definition){
  return ui.media.get(definition.id)||null;
}

function mediaQuery(definition){
  return definition.mediaQuery||definition.scientificName||definition.commonName;
}

async function loadMedia(definition){
  if(!definition||ui.media.has(definition.id)||ui.mediaLoading.has(definition.id))return;
  ui.mediaLoading.add(definition.id);
  try{
    const result=await api("/api/knowledge?q="+encodeURIComponent(knowledgeQuery(definition))+"&lang=en");
    const knowledge=result.knowledge||null;
    if(knowledge)ui.knowledge.set(definition.id,knowledge);
    ui.media.set(definition.id,knowledge?.media||false);
  }catch{
    ui.media.set(definition.id,false);
  }finally{
    ui.mediaLoading.delete(definition.id);
  }
}

async function warmMedia(definitions,{rerender=true}={}){
  const unique=[...new Map(definitions.filter(Boolean).map(d=>[d.id,d])).values()];
  const pending=unique.filter(d=>!ui.media.has(d.id)&&!ui.mediaLoading.has(d.id)).slice(0,12);
  if(!pending.length)return false;

  const queue=[...pending];
  const workers=Array.from({length:Math.min(4,queue.length)},async()=>{
    while(queue.length){
      const definition=queue.shift();
      if(definition)await loadMedia(definition);
    }
  });
  await Promise.allSettled(workers);

  if(rerender){
    if(revealDialog.open&&ui.reveal)renderReveal();
    else render();
  }
  return true;
}

function updateMediaNodes(definitionId){
  const definition=ui.definitionIndex.get(String(definitionId));
  if(!definition)return;
  document.querySelectorAll('[data-media-id="'+CSS.escape(String(definitionId))+'"]').forEach(node=>{
    node.outerHTML=imageMarkup(definition);
  });
}

async function flushMediaBatch(){
  clearTimeout(mediaBatchTimer);
  mediaBatchTimer=null;

  const ids=[...mediaBatchQueue].slice(0,12);
  if(!ids.length)return;
  ids.forEach(id=>mediaBatchQueue.delete(id));

  const entries=ids.map(id=>{
    const definition=ui.definitionIndex.get(String(id));
    return definition?{id:String(id),query:knowledgeQuery(definition)}:null;
  }).filter(Boolean);

  if(!entries.length)return;

  entries.forEach(entry=>ui.mediaLoading.add(entry.id));

  try{
    const result=await api("/api/knowledge/batch",{
      method:"POST",
      body:JSON.stringify({lang:"en",entries})
    });
    const values=result.knowledge||{};

    for(const entry of entries){
      const knowledge=values[entry.id]||null;
      if(knowledge)ui.knowledge.set(entry.id,knowledge);
      ui.media.set(entry.id,knowledge?.media||false);
      updateMediaNodes(entry.id);
    }
  }catch{
    for(const entry of entries){
      ui.media.set(entry.id,false);
      updateMediaNodes(entry.id);
    }
  }finally{
    entries.forEach(entry=>ui.mediaLoading.delete(entry.id));
    if(mediaBatchQueue.size){
      mediaBatchTimer=setTimeout(flushMediaBatch,45);
    }
  }
}

function queueMediaLoad(definition){
  if(!definition)return;
  const id=String(definition.id);
  ui.definitionIndex.set(id,definition);
  if(ui.media.has(id)||ui.mediaLoading.has(id))return;
  mediaBatchQueue.add(id);
  if(!mediaBatchTimer)mediaBatchTimer=setTimeout(flushMediaBatch,35);
}

let mediaObserver=null;
function wireMediaObservers(){
  mediaObserver?.disconnect();
  const nodes=[...document.querySelectorAll("[data-media-id]")];
  if(!nodes.length)return;

  if(!("IntersectionObserver" in window)){
    nodes.slice(0,12).forEach(async node=>{
      const id=node.dataset.mediaId;
      const definition=ui.definitionIndex.get(String(id));
      if(!definition)return;
      queueMediaLoad(definition);
    });
    return;
  }

  mediaObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      const node=entry.target;
      mediaObserver.unobserve(node);
      const id=node.dataset.mediaId;
      const definition=ui.definitionIndex.get(String(id));
      if(!definition)continue;
      queueMediaLoad(definition);
    }
  },{rootMargin:"320px 0px",threshold:0.01});

  nodes.forEach(node=>mediaObserver.observe(node));
}

function knowledgeQuery(definition){
  if(definition.kind==="origin")return definition.commonName||"Last universal common ancestor";
  return definition.scientificName||definition.commonName;
}

async function loadTaxonomyContext(definition){
  if(!definition)return null;
  const key=String(definition.id);
  if(ui.taxonomyContext.has(key))return ui.taxonomyContext.get(key);
  if(ui.taxonomyContextLoading.has(key))return null;
  ui.taxonomyContextLoading.add(key);

  try{
    const query=definition.scientificName||definition.commonName;
    const result=await api("/api/taxonomy/resolve?q="+encodeURIComponent(query));
    const value={
      taxon:result.taxon||null,
      path:result.path||[],
      taxonomy:result.taxonomy||null,
    };
    ui.taxonomyContext.set(key,value);
    return value;
  }catch{
    ui.taxonomyContext.set(key,false);
    return null;
  }finally{
    ui.taxonomyContextLoading.delete(key);
  }
}

function taxonomyContextFor(definition){
  const value=ui.taxonomyContext.get(String(definition.id));
  return value&&value!==false?value:null;
}

async function loadKnowledge(definition){
  if(!definition)return null;
  if(ui.knowledge.has(definition.id))return ui.knowledge.get(definition.id);
  if(ui.knowledgeLoading.has(definition.id))return null;
  ui.knowledgeLoading.add(definition.id);
  try{
    const result=await api("/api/knowledge?q="+encodeURIComponent(knowledgeQuery(definition))+"&lang=en");
    ui.knowledge.set(definition.id,result.knowledge||false);
    if(result.knowledge?.media&&!ui.media.has(definition.id)){
      ui.media.set(definition.id,result.knowledge.media);
    }
    return result.knowledge||null;
  }catch{
    ui.knowledge.set(definition.id,false);
    return null;
  }finally{
    ui.knowledgeLoading.delete(definition.id);
  }
}

function knowledgeSourceButtons(knowledge){
  if(!knowledge)return "";
  const links=[];
  if(knowledge.wikipedia?.pageUrl)links.push('<a class="source-button wikipedia" href="'+esc(knowledge.wikipedia.pageUrl)+'" target="_blank" rel="noopener">Wikipedia ↗</a>');
  if(knowledge.taxonomy?.lifemapUrl)links.push('<a class="source-button lifemap" href="'+esc(knowledge.taxonomy.lifemapUrl)+'" target="_blank" rel="noopener">View in Lifemap ↗</a>');
  if(knowledge.taxonomy?.ncbiUrl)links.push('<a class="source-button ncbi" href="'+esc(knowledge.taxonomy.ncbiUrl)+'" target="_blank" rel="noopener">NCBI ↗</a>');
  if(knowledge.wikidata?.pageUrl)links.push('<a class="source-button wikidata" href="'+esc(knowledge.wikidata.pageUrl)+'" target="_blank" rel="noopener">Wikidata ↗</a>');
  return links.join("");
}

function imageMarkup(definition){
  ui.definitionIndex.set(String(definition.id),definition);
  const hasResolved=ui.media.has(definition.id);
  const media=getMedia(definition);
  if(media&&media.imageUrl){
    return '<img src="'+esc(media.imageUrl)+'" alt="'+esc(definition.commonName)+'" loading="lazy" draggable="false">';
  }
  if(!hasResolved){
    return '<div class="art-loading" data-media-id="'+esc(definition.id)+'" aria-label="Loading image"><span></span><i></i></div>';
  }
  const initials=(definition.commonName||definition.scientificName||"?").split(/\s+/).slice(0,2).map(x=>x[0]).join("");
  return '<div class="art-fallback"><span>'+esc(definition.icon||"◌")+'</span><b>'+esc(initials)+'</b><small>No reusable image found</small></div>';
}
function cardSummary(definition){
  const knowledge=ui.knowledge.get(definition.id);
  const live=knowledge&&knowledge!==false
    ? (knowledge.wikipedia?.description||knowledge.wikipedia?.extract||"")
    : "";
  const text=String(live||definition.summary||"").replace(/\s+/g," ").trim();
  if(text.length<=155)return text;
  return text.slice(0,152).replace(/\s+\S*$/,"")+"…";
}

function rarityForRank(rank){
  const value=String(rank||"").toLowerCase();
  if(value==="domain"||value==="kingdom")return "MYTHIC";
  if(value==="phylum")return "LEGENDARY";
  if(value==="class")return "ULTRA_RARE";
  if(value==="order")return "SUPER_RARE";
  if(value==="family")return "RARE";
  if(value==="genus")return "UNCOMMON";
  return "COMMON";
}

function taxonToDefinition(taxon){
  if(!taxon)return null;
  return {
    id:String(taxon.id),
    taxonomyId:String(taxon.id),
    parentId:taxon.parentId?String(taxon.parentId):null,
    scientificName:taxon.scientificName||taxon.canonicalName||"Unknown taxon",
    commonName:taxon.commonName||taxon.canonicalName||taxon.scientificName||"Unknown taxon",
    rank:taxon.rank||"unranked",
    kind:taxon.kind||((String(taxon.rank).toLowerCase()==="species")?"species":"taxon"),
    temporalStatus:taxon.extinct?"extinct":"extant",
    rarity:taxon.rarity||rarityForRank(taxon.rank),
    icon:taxon.icon||((String(taxon.rank).toLowerCase()==="species")?"◉":"◎"),
    summary:taxon.source==="Catalogue of Life"
      ?"Catalogue of Life taxon. Open the scientific record to resolve Wikipedia, Wikidata, NCBI and Lifemap links."
      :"",
    source:taxon.source||"Catalogue of Life",
    childCount:Number(taxon.childCount||0),
    descendantSpeciesCount:Number(taxon.descendantSpeciesCount||0),
    collectible:Boolean(ui.state?.catalog?.some(entry=>String(entry.id)===String(taxon.id))),
  };
}

function taxonomySummary(status){
  if(!status)return "Taxonomy unavailable";
  if(status.mode==="catalogue-of-life-live"){
    return "Catalogue of Life live · full remote catalogue";
  }
  if(status.ready){
    const taxa=status.taxonCount!=null?formatNumber(status.taxonCount)+" taxa":"local taxonomy";
    const species=status.speciesCount!=null?" · "+formatNumber(status.speciesCount)+" species":"";
    const scope=status.fullLifeMap?"Full Life Map":(status.mapScope||status.scope||"Animalia");
    return scope+" · "+taxa+species;
  }
  return "Seed tree · run npm run sync:col";
}

function cardHtml(card,{compact=false,interactive=true,showSell=false}={}){
  const d=card.definition||card;
  if(card.id)ui.cardIndex.set(String(card.id),card);
  const rarity=RARITY[d.rarity]||{label:d.rarity,short:"?"};
  const media=getMedia(d);
  const classes=[
    "life-card",
    "rarity-"+String(d.rarity||"common").toLowerCase().replaceAll("_","-"),
    card.finish==="HOLO"?"holo":"",
    d.rarity==="UNKNOWN"?"unknown":"",
    compact?"compact":""
  ].filter(Boolean).join(" ");

  return '<article class="'+classes+'" '+(interactive&&card.id?'data-card-id="'+esc(card.id)+'"':"")+'>'+
    '<div class="card-frame">'+
      '<div class="card-art">'+imageMarkup(d)+
        '<div class="card-art-shade"></div>'+
        '<span class="rarity-pill">'+esc(rarity.short)+'</span>'+
        (card.finish==="HOLO"?'<span class="holo-pill">✦ HOLO</span>':"")+
        (d.conservation?'<span class="status-pill">'+esc(d.conservation)+'</span>':"")+
      '</div>'+
      '<div class="card-copy">'+
        '<div class="card-title-row"><div><h3>'+esc(d.commonName)+'</h3><em>'+esc(d.scientificName)+'</em></div><button class="favorite '+(ui.favorites.has(d.id)?"active":"")+'" data-favorite="'+esc(d.id)+'" aria-label="Favorite">'+(ui.favorites.has(d.id)?"★":"☆")+'</button></div>'+
        '<p>'+esc(cardSummary(d))+'</p>'+
        '<div class="card-bottom">'+
          '<span class="edition '+editionClass(card.edition||"")+'">'+esc(card.edition||d.rank||d.kind)+'</span>'+
          '<b>'+((card.serial||card.serial===0)?serial(card):esc(d.rank||""))+'</b>'+
        '</div>'+
        (media&&media.creator?'<small class="photo-credit">'+esc(media.creator)+' · '+esc(media.license||"")+'</small>':"")+
      '</div>'+
    '</div>'+
    (showSell&&card.id?'<button class="sell-button" data-sell="'+esc(card.id)+'">List on market</button>':"")+
  '</article>';
}

function definitionPreview(definition){
  return cardHtml({...definition,definition,finish:"STANDARD"},{compact:true,interactive:false});
}

const RARITY_ORDER={UNKNOWN:0,MYTHIC:1,LEGENDARY:2,ULTRA_RARE:3,SUPER_RARE:4,RARE:5,UNCOMMON:6,COMMON:7};

function representativeCard(cards){
  return [...cards].sort((a,b)=>{
    const finish=(b.finish==="HOLO")-(a.finish==="HOLO");
    if(finish)return finish;
    const wild=(b.edition==="WILD CENSUS I")-(a.edition==="WILD CENSUS I");
    if(wild)return wild;
    const foundation=(b.edition==="FOUNDATION I")-(a.edition==="FOUNDATION I");
    if(foundation)return foundation;
    return Number(a.serial||Infinity)-Number(b.serial||Infinity);
  })[0];
}

function groupCollection(cards){
  const groups=new Map();
  for(const card of cards){
    const key=card.definitionId;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(card);
  }
  return [...groups.entries()].map(([definitionId,copies])=>({
    definitionId,
    copies,
    card:representativeCard(copies),
    holoCount:copies.filter(c=>c.finish==="HOLO").length,
    wildCount:copies.filter(c=>c.edition==="WILD CENSUS I").length,
    lowestSerial:Math.min(...copies.map(c=>Number(c.serial||Infinity))),
    newest:Math.max(...copies.map(c=>Number(c.createdAt||0))),
  }));
}

function sortCollectionGroups(groups){
  const sorted=[...groups];
  if(ui.collectionSort==="NAME"){
    return sorted.sort((a,b)=>a.card.definition.commonName.localeCompare(b.card.definition.commonName));
  }
  if(ui.collectionSort==="NEWEST"){
    return sorted.sort((a,b)=>b.newest-a.newest);
  }
  return sorted.sort((a,b)=>{
    const rarity=(RARITY_ORDER[a.card.definition.rarity]??99)-(RARITY_ORDER[b.card.definition.rarity]??99);
    if(rarity)return rarity;
    return a.card.definition.commonName.localeCompare(b.card.definition.commonName);
  });
}

function collectionStackHtml(group){
  const card=group.card;
  const copyCount=Array.isArray(group.copies)?group.copies.length:Number(group.copies||0);
  return '<article class="collection-stack" data-stack="'+esc(group.definitionId)+'">'+
    '<div class="stack-layers"><i></i><i></i>'+cardHtml(card,{compact:true,interactive:false})+'</div>'+
    '<div class="stack-badges">'+
      '<span class="copy-count">×'+copyCount+'</span>'+
      (group.holoCount?'<span class="stack-holo">✦ '+group.holoCount+' Holo</span>':"")+
      (group.wildCount?'<span class="stack-wild">'+group.wildCount+' Wild</span>':"")+
    '</div>'+
  '</article>';
}

function flash(message){
  toast.textContent=message;
  toast.classList.add("show");
  clearTimeout(flash._t);
  flash._t=setTimeout(()=>toast.classList.remove("show"),2000);
}

function updateChrome(){
  const [kicker,title]=TITLES[ui.view];
  document.getElementById("viewKicker").textContent=kicker;
  document.getElementById("viewTitle").textContent=title;
  document.querySelectorAll("[data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===ui.view));
  if(ui.state){
    coins.textContent=formatNumber(ui.state.user.coins);
    packBadge.textContent=ui.state.user.packs||"";
    packBadge.classList.toggle("visible",ui.state.user.packs>0);
    const originSmall=document.querySelector(".origin-mini small");
    if(originSmall){
      originSmall.textContent=ui.state.origin?.discovered
        ?"DISCOVERED · 1 / 1"
        :"#1 / 1 · undiscovered";
    }
  }
}

function render(){
  if(!ui.state)return;
  updateChrome();
  if(ui.view==="packs")renderPacks();
  if(ui.view==="collection")renderCollection();
  if(ui.view==="tree")renderTree();
  if(ui.view==="market")renderMarket();
  if(ui.view==="codex")renderCodex();
  wireCommon();
}

function renderPacks(){
  const {user,config,inventory}=ui.state;
  const recent=inventory.slice(0,6);
  const summary=ui.state.collectionSummary||{};
  const taxonomy=ui.taxonomyStatus;
  const indexedCards=taxonomy?.dropPoolReady
    ?Object.values(taxonomy.dropPool||{}).reduce((sum,value)=>sum+Number(value||0),0)
    :0;
  const slots=Array.from({length:user.maxPacks},(_,i)=>
    '<span class="drop-storage-slot '+(i<user.packs?"filled":"")+'"><i></i></span>'
  ).join("");

  main.innerHTML=
    '<section class="drop-page">'+
      '<div class="drop-hero">'+
        '<div class="drop-hero-copy">'+
          '<span class="eyebrow">FIELD DROPS · TREE OF LIFE</span>'+
          '<h1>Six cards.<br><em>One living tree.</em></h1>'+
          '<p>Open a field archive and discover species, fossils and phylogenetic nodes. Every pull has a real position in the Tree of Life.</p>'+
          '<div class="drop-facts">'+
            '<span><b>6</b><small>cards / pack</small></span>'+
            '<span><b>8 min</b><small>new pack</small></span>'+
            '<span><b>8</b><small>stored max</small></span>'+
            '<span><b>'+Math.round(config.holoRate*1000)/10+'%</b><small>Holo roll</small></span>'+
          '</div>'+
        '</div>'+
        '<aside class="drop-world-status">'+
          '<span class="eyebrow">LIVE ARCHIVE</span>'+
          '<div class="world-status-line"><i class="'+(taxonomy?.dropPoolReady?"live":"seed")+'"></i><div><b>'+(taxonomy?.dropPoolReady?formatNumber(indexedCards)+" indexed pulls":"Seed drop pool")+'</b><small>'+(taxonomy?.dropPoolReady?esc(taxonomy.dropScope||"Animalia")+" gameplay taxonomy":"Build Catalogue of Life with npm run sync:col")+'</small></div></div>'+
          '<div class="world-status-line"><i class="'+(taxonomy?.fullLifeMap?"live":"seed")+'"></i><div><b>'+(taxonomy?.fullLifeMap?"Full Life Map":"Animalia map")+'</b><small>'+(taxonomy?.fullLifeMap?"Bacteria · Archaea · Eukaryota":"Optional full map: npm run sync:map")+'</small></div></div>'+
        '</aside>'+
      '</div>'+

      '<div class="drop-core">'+
        '<aside class="drop-origin-panel '+(ui.state.origin?.discovered?"discovered":"")+'">'+
          '<div class="origin-signal"><span></span><i></i></div>'+
          '<span class="eyebrow">THE ORIGIN</span>'+
          '<h2>LUCA</h2>'+
          '<b>UNKNOWN · '+(ui.state.origin?.discovered?"1 / 1":"0 / 1")+'</b>'+
          '<p>'+(ui.state.origin?.discovered
            ?"The only Origin card has been discovered. Its provenance is permanent."
            :"Exactly one exists globally. Every eligible pack has the same independent chance from pack one.")+'</p>'+
          '<div class="origin-status"><i></i><span>'+(ui.state.origin?.discovered?"DISCOVERED":"DROP POOL ACTIVE")+'</span></div>'+
        '</aside>'+

        '<div class="drop-pack-console">'+
          '<div class="drop-pack-rings"><i></i><i></i><i></i></div>'+
          '<button id="packObject" class="premium-pack '+(user.packs<1?"empty":"")+'" '+(user.packs<1?"disabled":"")+'>'+
            '<div class="premium-pack-crimp top"></div>'+
            '<div class="premium-pack-body">'+
              '<div class="premium-pack-brand"><span>LC</span><small>LIFECARDS</small></div>'+
              '<div class="premium-pack-star">✦</div>'+
              '<strong>FIELD<br>ARCHIVE</strong>'+
              '<p>TREE OF LIFE COLLECTION</p>'+
              '<div class="premium-pack-footer"><span>6 DISCOVERIES</span><b>01</b></div>'+
            '</div>'+
            '<div class="premium-pack-crimp bottom"></div>'+
          '</button>'+
          '<button id="openPack" class="drop-open-button" '+(user.packs<1?"disabled":"")+'>'+
            (user.packs>0?'<span>Open field archive</span><small>'+user.packs+' ready</small>':'<span>No pack ready</span><small id="openPackTimer">'+formatTimer(liveNextPackMs())+'</small>')+
          '</button>'+
        '</div>'+

        '<aside class="drop-storage-panel">'+
          '<div class="drop-storage-head"><div><span class="eyebrow">PACK STORAGE</span><b>'+user.packs+' <i>/ '+user.maxPacks+'</i></b></div><span id="nextPackTimer">'+(user.packs>=user.maxPacks?"FULL":"Next "+formatTimer(liveNextPackMs()))+'</span></div>'+
          '<div class="drop-storage-slots">'+slots+'</div>'+
          '<div class="drop-collection-mini">'+
            '<div><b>'+formatNumber(summary.uniqueDiscoveries||0)+'</b><small>discoveries</small></div>'+
            '<div><b>'+formatNumber(summary.totalCards||0)+'</b><small>cards owned</small></div>'+
            '<div><b>'+formatNumber(summary.holoCards||0)+'</b><small>Holo</small></div>'+
          '</div>'+
          '<button data-view="collection" class="drop-secondary-action">Open collection →</button>'+
        '</aside>'+
      '</div>'+
    '</section>'+

    '<section class="drop-recent">'+
      '<div class="drop-section-head"><div><span class="eyebrow">RECENT DISCOVERIES</span><h2>Latest from your archive</h2></div><button data-view="collection">View all →</button></div>'+
      '<div class="card-grid recent-grid premium-recent">'+
        (recent.length?recent.map(c=>cardHtml(c,{compact:true})).join(""):'<div class="empty-state">Your first six discoveries will appear here.</div>')+
      '</div>'+
    '</section>';

  document.getElementById("openPack")?.addEventListener("click",openPack);
  document.getElementById("packObject")?.addEventListener("click",openPack);
  wireMediaObservers();
}

function collectionQueryString(){
  const params=new URLSearchParams({
    mode:ui.collectionMode,
    filter:ui.collectionFilter,
    q:ui.query.trim(),
    sort:ui.collectionSort,
    limit:String(ui.collectionPageSize),
    offset:String(ui.collectionPage*ui.collectionPageSize),
  });
  return params.toString();
}

async function loadCollectionData({resetPage=false}={}){
  if(resetPage)ui.collectionPage=0;
  const token=++ui.collectionRequestToken;
  ui.collectionLoading=true;
  renderCollection();

  try{
    const result=await api("/api/collection?"+collectionQueryString());
    if(token!==ui.collectionRequestToken)return;
    ui.collectionData=result;
    ui.collectionLoading=false;
    renderCollection();
    wireCommon();
  }catch(error){
    if(token!==ui.collectionRequestToken)return;
    ui.collectionLoading=false;
    flash(error.message);
    renderCollection();
    wireCommon();
  }
}

function renderCollection(){
  const data=ui.collectionData;
  const summary=data?.summary||ui.state.collectionSummary||{
    totalCards:ui.state.inventory?.length||0,
    uniqueDiscoveries:new Set((ui.state.inventory||[]).map(c=>c.definitionId)).size,
    holoCards:(ui.state.inventory||[]).filter(c=>c.finish==="HOLO").length,
    wildCards:(ui.state.inventory||[]).filter(c=>c.edition==="WILD CENSUS I").length,
  };
  const filters=["ALL","SPECIES","TAXA","WILD","HOLO"];
  const items=data?.items||[];
  const displayItems=ui.collectionMode==="DISCOVERIES"
    ? items.map(collectionStackHtml).join("")
    : items.map(c=>cardHtml(c,{compact:true,showSell:true})).join("");

  const total=data?.total??summary.uniqueDiscoveries;
  const start=total?ui.collectionPage*ui.collectionPageSize+1:0;
  const end=Math.min(total,(ui.collectionPage+1)*ui.collectionPageSize);
  const pageCount=Math.max(1,Math.ceil(total/ui.collectionPageSize));

  main.innerHTML=
    '<section class="library-page">'+
      '<div class="collection-hero">'+
        '<div><span class="eyebrow">YOUR ARCHIVE</span><h1>Collection</h1><p>Your biological archive, organized as discoveries instead of duplicate clutter.</p></div>'+
        '<div class="collection-stats">'+
          '<div><b>'+formatNumber(summary.uniqueDiscoveries)+'</b><small>Discoveries</small></div>'+
          '<div><b>'+formatNumber(summary.totalCards)+'</b><small>Total cards</small></div>'+
          '<div><b>'+formatNumber(summary.holoCards)+'</b><small>Holo</small></div>'+
          '<div><b>'+formatNumber(summary.wildCards)+'</b><small>Wild</small></div>'+
        '</div>'+
      '</div>'+
      '<div class="collection-toolbar album-toolbar">'+
        '<label class="search-box"><span>⌕</span><input id="collectionSearch" placeholder="Search species, taxa, edition..." value="'+esc(ui.query)+'"></label>'+
        '<div class="collection-mode">'+
          '<button data-collection-mode="DISCOVERIES" class="'+(ui.collectionMode==="DISCOVERIES"?"active":"")+'">Discoveries</button>'+
          '<button data-collection-mode="CARDS" class="'+(ui.collectionMode==="CARDS"?"active":"")+'">All cards</button>'+
        '</div>'+
      '</div>'+
      '<div class="collection-subbar">'+
        '<div class="filter-row">'+filters.map(f=>'<button data-filter="'+f+'" class="'+(ui.collectionFilter===f?"active":"")+'">'+f+'</button>').join("")+'</div>'+
        '<div class="collection-sort"><span>Sort</span><button data-sort="RARITY" class="'+(ui.collectionSort==="RARITY"?"active":"")+'">Rarity</button><button data-sort="NAME" class="'+(ui.collectionSort==="NAME"?"active":"")+'">Name</button><button data-sort="NEWEST" class="'+(ui.collectionSort==="NEWEST"?"active":"")+'">Newest</button></div>'+
      '</div>'+
      '<div class="collection-result-line"><span>'+(ui.collectionLoading?"Loading…":(start?start+"–"+end+" of "+formatNumber(total):"0 shown"))+'</span><small>'+formatNumber(summary.uniqueDiscoveries)+' unique taxa/species owned</small></div>'+
      '<div class="card-grid collection-grid '+(ui.collectionMode==="DISCOVERIES"?"discovery-grid":"all-cards-grid")+' '+(ui.collectionLoading?"is-loading":"")+'">'+
        (ui.collectionLoading&&!items.length
          ?Array.from({length:12},()=>'<div class="collection-card-skeleton"></div>').join("")
          :(displayItems||'<div class="empty-state">No cards match this filter.</div>'))+
      '</div>'+
      '<div class="collection-pagination">'+
        '<button id="collectionPrev" '+(ui.collectionPage<=0?"disabled":"")+'>← Previous</button>'+
        '<span>Page '+(ui.collectionPage+1)+' / '+pageCount+'</span>'+
        '<button id="collectionNext" '+(!(data?.hasMore)?"disabled":"")+'>Next →</button>'+
      '</div>'+
    '</section>';

  const search=document.getElementById("collectionSearch");
  search?.addEventListener("input",event=>{
    ui.query=event.target.value;
    clearTimeout(collectionSearchTimer);
    collectionSearchTimer=setTimeout(()=>loadCollectionData({resetPage:true}),220);
  });

  document.querySelectorAll("[data-filter]").forEach(button=>button.onclick=()=>{
    ui.collectionFilter=button.dataset.filter;
    loadCollectionData({resetPage:true});
  });

  document.querySelectorAll("[data-collection-mode]").forEach(button=>button.onclick=()=>{
    ui.collectionMode=button.dataset.collectionMode;
    loadCollectionData({resetPage:true});
  });

  document.querySelectorAll("[data-sort]").forEach(button=>button.onclick=()=>{
    ui.collectionSort=button.dataset.sort;
    loadCollectionData({resetPage:true});
  });

  document.querySelectorAll("[data-stack]").forEach(stack=>stack.onclick=()=>{
    const group=items.find(item=>String(item.definitionId)===String(stack.dataset.stack));
    if(group)openCollectionStack(group);
  });

  document.querySelectorAll("[data-sell]").forEach(button=>button.onclick=event=>{
    event.stopPropagation();
    listCard(button.dataset.sell);
  });

  document.getElementById("collectionPrev")?.addEventListener("click",()=>{
    if(ui.collectionPage<=0)return;
    ui.collectionPage-=1;
    loadCollectionData();
    window.scrollTo({top:0,behavior:"smooth"});
  });

  document.getElementById("collectionNext")?.addEventListener("click",()=>{
    if(!data?.hasMore)return;
    ui.collectionPage+=1;
    loadCollectionData();
    window.scrollTo({top:0,behavior:"smooth"});
  });

  wireMediaObservers();

  if(!data&&!ui.collectionLoading){
    queueMicrotask(()=>loadCollectionData({resetPage:true}));
  }
}

async function openCollectionStack(group){
  const d=group.card.definition;
  cardModalContent.innerHTML=
    '<div class="stack-detail loading-copies">'+
      '<div class="stack-detail-card">'+cardHtml(group.card,{interactive:false})+'</div>'+
      '<div class="stack-detail-copy"><span class="eyebrow">OWNED DISCOVERY</span><h2>'+esc(d.commonName)+'</h2><em>'+esc(d.scientificName)+'</em>'+
      '<div class="stack-copies-loading"><span></span><b>Loading your copies…</b></div></div>'+
    '</div>';
  cardModal.showModal();
  wireMediaObservers();

  try{
    const result=await api("/api/collection/copies?definitionId="+encodeURIComponent(group.definitionId)+"&limit=250");
    const copies=result.items||[];
    renderCollectionStackDetail(group,copies);
  }catch(error){
    flash(error.message);
  }
}

function renderCollectionStackDetail(group,copies){
  const d=group.card.definition;
  const copyCount=copies.length||Number(group.copies||0);
  const holoCount=copies.filter(card=>card.finish==="HOLO").length||group.holoCount||0;
  const wildCount=copies.filter(card=>card.edition==="WILD CENSUS I").length||group.wildCount||0;
  const lowestSerial=copies.length?Math.min(...copies.map(card=>Number(card.serial||Infinity))):group.lowestSerial;

  cardModalContent.innerHTML=
    '<div class="stack-detail">'+
      '<div class="stack-detail-card">'+cardHtml(group.card,{interactive:false})+'</div>'+
      '<div class="stack-detail-copy">'+
        '<span class="eyebrow">OWNED DISCOVERY</span><h2>'+esc(d.commonName)+'</h2><em>'+esc(d.scientificName)+'</em>'+
        '<div class="stack-summary">'+
          '<div><b>'+copyCount+'</b><small>copies</small></div>'+
          '<div><b>'+holoCount+'</b><small>holo</small></div>'+
          '<div><b>'+wildCount+'</b><small>wild</small></div>'+
          '<div><b>#'+(Number.isFinite(lowestSerial)?String(lowestSerial).padStart(6,"0"):"—")+'</b><small>best serial</small></div>'+
        '</div>'+
        '<h3>Your copies</h3>'+
        '<div class="stack-copy-list">'+copies.map(card=>
          '<div class="stack-copy-row" data-stack-card="'+esc(card.id)+'"><span class="finish-dot '+(card.finish==="HOLO"?"holo":"")+'"></span><div><b>'+esc(card.edition)+'</b><small>'+esc(serial(card))+'</small></div><span>'+esc(card.finish)+'</span><button data-sell="'+esc(card.id)+'">List</button></div>'
        ).join("")+'</div>'+
      '</div>'+
    '</div>';

  copies.forEach(card=>ui.cardIndex.set(String(card.id),card));
  cardModalContent.querySelectorAll("[data-stack-card]").forEach(row=>row.onclick=event=>{
    if(event.target.closest("[data-sell]"))return;
    const card=ui.cardIndex.get(String(row.dataset.stackCard));
    if(card)openCardModal(card.definition,card);
  });
  cardModalContent.querySelectorAll("[data-sell]").forEach(button=>button.onclick=event=>{
    event.stopPropagation();
    listCard(button.dataset.sell);
  });
  wireMediaObservers();
  loadKnowledge(d).catch(()=>{});
}

function marketQueryString(){
  const params=new URLSearchParams({
    filter:ui.marketFilter,
    q:ui.marketQuery.trim(),
    sort:ui.marketSort,
    limit:String(ui.marketPageSize),
    offset:String(ui.marketPage*ui.marketPageSize),
  });
  return params.toString();
}

async function loadMarketData({resetPage=false}={}){
  if(resetPage)ui.marketPage=0;
  const token=++ui.marketRequestToken;
  ui.marketLoading=true;
  renderMarket();

  try{
    const result=await api("/api/market?"+marketQueryString());
    if(token!==ui.marketRequestToken)return;
    ui.marketData=result;
    ui.marketLoading=false;
    renderMarket();
    wireCommon();
  }catch(error){
    if(token!==ui.marketRequestToken)return;
    ui.marketLoading=false;
    flash(error.message);
    renderMarket();
    wireCommon();
  }
}

function renderMarket(){
  const data=ui.marketData;
  const listings=data?.items||[];
  const marketFilters=["ALL","HOLO","WILD","FOSSIL","TAXA"];
  const total=data?.total||0;
  const globalTotal=data?.activeTotal||total;
  const start=total?ui.marketPage*ui.marketPageSize+1:0;
  const end=Math.min(total,(ui.marketPage+1)*ui.marketPageSize);
  const pages=Math.max(1,Math.ceil(total/ui.marketPageSize));

  main.innerHTML=
    '<section class="market-page scalable-market">'+
      '<div class="market-hero">'+
        '<div><span class="eyebrow">SECONDARY MARKET</span><h1>Exchange</h1><p>Collect editions, serials and finishes. Fixed-price trades use Coins; 5% leaves the economy on each completed sale.</p></div>'+
        '<div class="market-stat"><b>'+formatNumber(globalTotal)+'</b><small>active listings</small></div>'+
      '</div>'+
      '<div class="market-search-row">'+
        '<label class="search-box"><span>⌕</span><input id="marketSearch" placeholder="Search species or taxon…" value="'+esc(ui.marketQuery)+'"></label>'+
        '<div class="market-sort">'+
          '<button data-market-sort="NEWEST" class="'+(ui.marketSort==="NEWEST"?"active":"")+'">Newest</button>'+
          '<button data-market-sort="PRICE_ASC" class="'+(ui.marketSort==="PRICE_ASC"?"active":"")+'">Price ↑</button>'+
          '<button data-market-sort="PRICE_DESC" class="'+(ui.marketSort==="PRICE_DESC"?"active":"")+'">Price ↓</button>'+
        '</div>'+
      '</div>'+
      '<div class="market-toolbar">'+
        '<span>'+(ui.marketLoading?"Loading…":(start?start+"–"+end+" of "+formatNumber(total):"0 listings"))+'</span>'+
        '<div>'+marketFilters.map(filter=>'<button class="filter-chip '+(ui.marketFilter===filter?"active":"")+'" data-market-filter="'+filter+'">'+filter+'</button>').join("")+'</div>'+
      '</div>'+
      '<div class="market-grid '+(ui.marketLoading?"is-loading":"")+'">'+
        (ui.marketLoading&&!listings.length
          ?Array.from({length:8},()=>'<div class="market-card-skeleton"></div>').join("")
          :(listings.length?listings.map(listing=>
            '<article class="market-item">'+cardHtml(listing.card,{compact:true})+
            '<div class="market-meta"><div><small>ASK</small><strong>◆ '+formatNumber(listing.price)+'</strong><span>'+esc(listing.sellerId)+'</span></div><button data-buy="'+esc(listing.id)+'">Buy</button></div></article>'
          ).join(""):'<div class="empty-state">No listings match this search.</div>'))+
      '</div>'+
      '<div class="collection-pagination market-pagination">'+
        '<button id="marketPrev" '+(ui.marketPage<=0?"disabled":"")+'>← Previous</button>'+
        '<span>Page '+(ui.marketPage+1)+' / '+pages+'</span>'+
        '<button id="marketNext" '+(!(data?.hasMore)?"disabled":"")+'>Next →</button>'+
      '</div>'+
    '</section>';

  document.querySelectorAll("[data-buy]").forEach(button=>button.onclick=event=>{
    event.stopPropagation();
    buy(button.dataset.buy);
  });

  document.querySelectorAll("[data-market-filter]").forEach(button=>button.onclick=()=>{
    ui.marketFilter=button.dataset.marketFilter;
    ui.marketData=null;
    loadMarketData({resetPage:true});
  });

  document.querySelectorAll("[data-market-sort]").forEach(button=>button.onclick=()=>{
    ui.marketSort=button.dataset.marketSort;
    ui.marketData=null;
    loadMarketData({resetPage:true});
  });

  const search=document.getElementById("marketSearch");
  search?.addEventListener("input",event=>{
    ui.marketQuery=event.target.value;
    clearTimeout(search._timer);
    search._timer=setTimeout(()=>{
      ui.marketData=null;
      loadMarketData({resetPage:true});
    },220);
  });

  document.getElementById("marketPrev")?.addEventListener("click",()=>{
    if(ui.marketPage<=0)return;
    ui.marketPage-=1;
    loadMarketData();
  });

  document.getElementById("marketNext")?.addEventListener("click",()=>{
    if(!data?.hasMore)return;
    ui.marketPage+=1;
    loadMarketData();
  });

  wireMediaObservers();

  if(!data&&!ui.marketLoading){
    queueMicrotask(()=>loadMarketData({resetPage:true}));
  }
}

function collectTreeScientificNames(root){
  const names=[];
  const walk=node=>{
    if(!node)return;
    if(node.scientificName)names.push(node.scientificName);
    for(const child of node.children||[])walk(child);
  };
  walk(root);
  return [...new Set(names)].slice(0,1200);
}

function findTreeNode(root,id){
  if(!root||id==null)return null;
  if(String(root.id)===String(id))return root;
  for(const child of root.children||[]){
    const found=findTreeNode(child,id);
    if(found)return found;
  }
  return null;
}

function treeLoadProfile(node,rootId){
  const rank=String(node?.rank||node?.kind||"").toLowerCase();
  let profile;
  if(["origin","domain","kingdom"].includes(rank)){
    profile={depth:3,childLimit:30,nodeLimit:520};
  }else if(["phylum","subphylum","class","subclass"].includes(rank)){
    profile={depth:4,childLimit:42,nodeLimit:760};
  }else if(["order","suborder","family","subfamily","superfamily"].includes(rank)){
    profile={depth:5,childLimit:54,nodeLimit:980};
  }else if(["genus","subgenus"].includes(rank)){
    profile={depth:4,childLimit:72,nodeLimit:760};
  }else{
    profile={depth:4,childLimit:42,nodeLimit:760};
  }

  if(ui.treeExpandedRoots.has(String(rootId||node?.id||""))){
    profile={
      depth:profile.depth,
      childLimit:Math.min(160,Math.max(profile.childLimit*2,100)),
      nodeLimit:Math.min(1700,Math.round(profile.nodeLimit*1.55)),
    };
  }
  return profile;
}

function treeNodeHint(id){
  if(!id)return null;
  const direct=findTreeNode(ui.treePayload?.root,id);
  if(direct)return direct;
  const pathNode=(ui.treePayload?.path||[]).find(node=>String(node.id)===String(id));
  if(pathNode)return pathNode;
  return (ui.treeSearchResults||[]).find(node=>String(node.id)===String(id))||null;
}

async function loadTreePayload(rootId,hintNode=null){
  const profile=treeLoadProfile(hintNode||treeNodeHint(rootId),rootId);
  const params=new URLSearchParams({
    depth:String(profile.depth),
    childLimit:String(profile.childLimit),
    nodeLimit:String(profile.nodeLimit),
  });
  if(rootId)params.set("root",rootId);

  const payload=await api("/api/taxonomy/subtree?"+params.toString());
  ui.taxonomyStatus=payload?.status||ui.taxonomyStatus;

  try{
    const owned=await api("/api/collection/owned",{
      method:"POST",
      body:JSON.stringify({scientificNames:collectTreeScientificNames(payload?.root)})
    });
    payload.ownedScientificNames=owned.scientificNames||[];
  }catch{
    payload.ownedScientificNames=[];
  }

  ui.treePayload=payload;
  return payload;
}

async function focusTree(rootId,hintNode=null,targetId=null){
  const holder=document.getElementById("radialTreeMap");
  if(holder){
    holder.classList.add("loading","atlas-diving");
    holder.classList.remove("atlas-ready");
  }
  ui.treeTargetId=targetId||null;

  try{
    const payload=await loadTreePayload(rootId,hintNode);
    if(ui.view!=="tree")return;
    drawRadialTree(payload);
    renderTreeBreadcrumb(payload);
  }catch(error){
    const target=document.getElementById("radialTreeMap");
    if(target){
      target.classList.remove("loading","atlas-diving");
      target.innerHTML='<div class="radial-empty">'+esc(error.message)+'</div>';
    }
  }
}

function renderTreeBreadcrumb(payload){
  const target=document.getElementById("treeBreadcrumb");
  if(!target||!payload)return;
  const path=payload.path||[];
  target.innerHTML=path.map((node,index)=>
    '<button data-tree-crumb="'+esc(node.id)+'" class="'+(index===path.length-1?"active":"")+'">'+esc(node.commonName||node.scientificName)+'</button>'
  ).join('<span>›</span>');
  target.querySelectorAll("[data-tree-crumb]").forEach(button=>{
    button.onclick=()=>focusTree(button.dataset.treeCrumb);
  });
}

function drawRadialTree(payload){
  const holder=document.getElementById("radialTreeMap");
  if(!holder||!payload)return;
  holder.classList.remove("loading");
  const ownedNames=new Set((payload.ownedScientificNames||[]).map(name=>String(name).toLowerCase()));
  radialMap=new RadialTreeMap(holder,{
    isOwned:(node)=>ownedNames.has(String(node.scientificName||"").toLowerCase()),
    onFocus:(node)=>focusTree(node.id,node),
    onSelect:(node)=>openTaxonomyNode(node),
    onHome:()=>focusTree(payload.status?.mapRootId||ui.taxonomyStatus?.mapRootId||"luca",{rank:"origin"}),
    onMore:(node)=>{
      ui.treeExpandedRoots.add(String(node.id));
      focusTree(node.id,node);
    },
    onUp:(current)=>{
      const path=current?.path||[];
      const parent=path.length>1?path[path.length-2]:null;
      if(parent)focusTree(parent.id,parent);
    }
  });
  radialMap.render(payload);
  if(ui.treeTargetId){
    radialMap.revealTarget?.(ui.treeTargetId);
    ui.treeTargetId=null;
  }
}

async function openTaxonomyNode(node){
  const definition=taxonToDefinition(node);
  if(!definition)return;
  if(Number(node.childCount||0)>0||String(node.rank||"").toLowerCase()!=="species"){
    return focusTree(node.id,node);
  }
  openCardModal(definition,null);
}

function scheduleTreeSearch(query){
  clearTimeout(treeSearchTimer);
  const q=String(query||"").trim();
  if(q.length<2){
    ui.treeSearchResults=[];
    renderTreeSearchResults();
    return;
  }
  treeSearchTimer=setTimeout(async()=>{
    try{
      const result=await api("/api/taxonomy/search?q="+encodeURIComponent(q)+"&limit=12");
      if(ui.treeQuery.trim()!==q)return;
      ui.treeSearchResults=result.results||[];
      ui.taxonomyStatus=result.taxonomy||ui.taxonomyStatus;
      renderTreeSearchResults();
    }catch{
      ui.treeSearchResults=[];
      renderTreeSearchResults();
    }
  },220);
}

function renderTreeSearchResults(){
  const target=document.getElementById("treeSearchResults");
  if(!target)return;
  const q=ui.treeQuery.trim();
  if(q.length<2){
    target.innerHTML="";
    target.classList.remove("visible");
    return;
  }
  const results=ui.treeSearchResults||[];
  target.classList.add("visible");
  target.innerHTML=results.length?results.map(node=>
    '<button data-tree-result="'+esc(node.id)+'"><span class="tree-result-dot"></span><div><b>'+esc(node.commonName||node.scientificName)+'</b><small>'+esc(node.scientificName)+' · '+esc(node.rank||"")+(node.descendantSpeciesCount?' · '+formatNumber(node.descendantSpeciesCount)+' species':node.childCount?' · '+formatNumber(node.childCount)+' branches':'')+'</small></div></button>'
  ).join(""):'<div class="tree-search-empty">No taxon found</div>';
  target.querySelectorAll("[data-tree-result]").forEach(button=>{
    button.onclick=()=>{
      const node=results.find(item=>String(item.id)===String(button.dataset.treeResult));
      ui.treeQuery="";
      ui.treeSearchResults=[];
      if(node&&String(node.rank||"").toLowerCase()==="species"){
        if(node.parentId)focusTree(node.parentId,{rank:"genus"},node.id);
        else openTaxonomyNode(node);
      }else if(node){
        focusTree(node.id,node);
      }
      const input=document.getElementById("treeSearch");
      if(input)input.value="";
      renderTreeSearchResults();
    };
  });
}

function renderTree(){
  const status=ui.taxonomyStatus||ui.treePayload?.status;
  main.innerHTML=
    '<section class="tree-map-page">'+
      '<div class="tree-map-head">'+
        '<div><span class="eyebrow">PHYLOGENETIC CARTOGRAPHY</span><h1>Tree of Life</h1><p>Navigate the classification as a living radial map. Zoom into a branch until individual species emerge.</p></div>'+
        '<div class="tree-head-actions"><button id="originBeacon" class="origin-beacon"><span>✺</span><div><small>ORIGIN</small><b>LUCA · UNKNOWN #1/1</b></div></button><div class="taxonomy-status '+(status?.ready?"ready":"seed")+'"><i></i><div><b>'+esc(taxonomySummary(status))+'</b><small>'+(status?.ready?esc(status.release||status.datasetKey||"Catalogue of Life"):'The game remains usable while the full database is absent.')+'</small></div></div></div>'+
      '</div>'+
      '<div class="tree-map-controls">'+
        '<div class="tree-search-wrap radial-search"><label class="search-box"><span>⌕</span><input id="treeSearch" autocomplete="off" placeholder="Lion, Felidae, Mollusca, Arthropoda…" value="'+esc(ui.treeQuery)+'"></label><div id="treeSearchResults" class="tree-search-results"></div></div>'+
        '<div id="treeBreadcrumb" class="tree-breadcrumb"></div>'+
      '</div>'+
      '<div id="radialTreeMap" class="radial-tree-map loading"><div class="radial-loading"><span></span><b>Building phylogenetic map…</b></div></div>'+
      '<div class="tree-map-foot"><span>Map: '+esc(status?.fullLifeMap?"Catalogue of Life · full life":status?.ready?"Catalogue of Life · "+(status.mapScope||status.scope||"Animalia"):"LifeCards seed taxonomy")+'</span><span>Drops: '+esc(status?.dropPoolReady?(status.dropScope||"Animalia")+" indexed pool":"seed pool")+' · External links: Wikipedia · Wikidata · NCBI · Lifemap</span></div>'+
    '</section>';

  document.getElementById("originBeacon")?.addEventListener("click",()=>openDefinition("luca"));
  const search=document.getElementById("treeSearch");
  search?.addEventListener("input",event=>{
    ui.treeQuery=event.target.value;
    scheduleTreeSearch(ui.treeQuery);
  });
  renderTreeSearchResults();

  if(ui.treePayload){
    drawRadialTree(ui.treePayload);
    renderTreeBreadcrumb(ui.treePayload);
  }else{
    focusTree(status?.mapRootId||status?.rootId||"luca");
  }
}

async function refreshCodexOwnership(definitions){
  const names=[...new Set(definitions.map(d=>d?.scientificName).filter(Boolean))].slice(0,200);
  if(!names.length){
    ui.codexOwned=new Set();
    return;
  }
  try{
    const result=await api("/api/collection/owned",{
      method:"POST",
      body:JSON.stringify({scientificNames:names})
    });
    ui.codexOwned=new Set((result.scientificNames||[]).map(name=>String(name).toLowerCase()));
  }catch{
    ui.codexOwned=new Set();
  }
}

function codexRankMatches(definition){
  if(ui.codexRank==="ALL")return true;
  const rank=String(definition.rank||definition.kind||"").toLowerCase();
  if(ui.codexRank==="SPECIES")return rank==="species";
  if(ui.codexRank==="GENUS")return rank==="genus"||rank==="subgenus";
  if(ui.codexRank==="FAMILY")return rank.includes("family")||rank==="tribe"||rank==="subtribe";
  if(ui.codexRank==="HIGHER")return !["species","genus","subgenus","family","subfamily","superfamily","tribe","subtribe"].includes(rank);
  return true;
}

function scheduleCodexSearch(query){
  clearTimeout(codexSearchTimer);
  const q=String(query||"").trim();

  if(q.length<2){
    ui.codexResults=[];
    ui.codexSearchLoading=false;
    refreshCodexOwnership(ui.state.catalog||[]).finally(()=>{
      if(ui.view==="codex")renderCodex();
    });
    renderCodex();
    return;
  }

  ui.codexSearchLoading=true;
  renderCodex();

  codexSearchTimer=setTimeout(async()=>{
    try{
      const result=await api("/api/taxonomy/search?q="+encodeURIComponent(q)+"&limit=80");
      if(ui.codexQuery.trim()!==q)return;
      ui.codexResults=(result.results||[]).map(taxonToDefinition);
      ui.taxonomyStatus=result.taxonomy||ui.taxonomyStatus;
      await refreshCodexOwnership(ui.codexResults);
    }catch{
      ui.codexResults=[];
      ui.codexOwned=new Set();
    }finally{
      ui.codexSearchLoading=false;
      if(ui.view==="codex")renderCodex();
    }
  },210);
}

function codexRowHtml(definition){
  const owned=ui.codexOwned.has(String(definition.scientificName||"").toLowerCase());
  const speciesCount=Number(definition.childCount||0);
  const rank=definition.rank||definition.kind||"unranked";
  return '<article class="codex-row '+(owned?"owned":"")+'" data-definition="'+esc(definition.id)+'">'+
    '<div class="codex-thumb">'+imageMarkup(definition)+(owned?'<span class="codex-owned">OWNED</span>':"")+'</div>'+
    '<div class="codex-copy">'+
      '<div class="codex-row-meta"><span class="codex-type">'+esc(definition.kind)+' · '+esc(rank)+'</span><span>'+esc((RARITY[definition.rarity]||{label:definition.rarity}).label||definition.rarity)+'</span></div>'+
      '<h3>'+esc(definition.commonName)+'</h3>'+
      '<em>'+esc(definition.scientificName)+'</em>'+
      '<p>'+esc(cardSummary(definition))+'</p>'+
    '</div>'+
    '<div class="codex-row-side">'+
      (definition.childCount?'<b>'+formatNumber(definition.childCount)+'</b><small>direct branches</small>':'<b>→</b><small>open record</small>')+
    '</div>'+
  '</article>';
}

function renderCodex(){
  const q=ui.codexQuery.trim();
  const base=q.length>=2?ui.codexResults:(ui.state.catalog||[]);
  const catalog=base.filter(codexRankMatches);
  const status=ui.taxonomyStatus;
  const rankFilters=["ALL","SPECIES","GENUS","FAMILY","HIGHER"];

  main.innerHTML=
    '<section class="codex-page scientific-codex">'+
      '<div class="codex-hero">'+
        '<div><span class="eyebrow">LIVING ENCYCLOPEDIA</span><h1>Codex</h1><p>Search the scientific backbone behind LifeCards. Taxonomy is local; descriptions and reusable media are resolved only when needed.</p></div>'+
        '<div class="codex-hero-stat"><b>'+formatNumber(status?.taxonCount||base.length)+'</b><small>taxa indexed</small><em>'+esc(status?.fullLifeMap?"Full Life Map":status?.mapScope||status?.scope||"Seed")+'</em></div>'+
      '</div>'+
      '<div class="codex-command">'+
        '<label class="search-box codex-search"><span>⌕</span><input id="codexSearch" autocomplete="off" placeholder="Scientific or common name…" value="'+esc(ui.codexQuery)+'"></label>'+
        '<div class="codex-rank-filters">'+rankFilters.map(rank=>'<button data-codex-rank="'+rank+'" class="'+(ui.codexRank===rank?"active":"")+'">'+rank+'</button>').join("")+'</div>'+
      '</div>'+
      '<div class="codex-dataset-banner '+(status?.ready?"ready":"seed")+'">'+
        '<div><i></i><b>'+esc(taxonomySummary(status))+'</b></div>'+
        '<small>'+(status?.fullLifeMap?"Tree search uses the optional full-life local snapshot; pack drops remain on the separate gameplay taxonomy.":status?.ready?"Search is querying the local Catalogue of Life snapshot.":"Seed data is active until a local Catalogue of Life database is built.")+'</small>'+
      '</div>'+
      '<div class="codex-result-bar"><span>'+(ui.codexSearchLoading?"Searching taxonomy…":formatNumber(catalog.length)+" results shown")+'</span><small>Images load only near the viewport</small></div>'+
      '<div class="codex-grid">'+
        (ui.codexSearchLoading&&!catalog.length
          ?Array.from({length:8},()=>'<div class="codex-skeleton"></div>').join("")
          :(catalog.length?catalog.map(codexRowHtml).join(""):'<div class="empty-state">No taxon found for this filter.</div>'))+
      '</div>'+
    '</section>';

  const input=document.getElementById("codexSearch");
  input?.addEventListener("input",event=>{
    ui.codexQuery=event.target.value;
    scheduleCodexSearch(ui.codexQuery);
  });

  document.querySelectorAll("[data-codex-rank]").forEach(button=>button.onclick=()=>{
    ui.codexRank=button.dataset.codexRank;
    renderCodex();
    wireCommon();
  });

  document.querySelectorAll("[data-definition]").forEach(row=>row.onclick=()=>openDefinition(row.dataset.definition));
  wireMediaObservers();

  if(!q&&ui.codexOwned.size===0&&base.length){
    queueMicrotask(()=>refreshCodexOwnership(base).then(()=>{
      if(ui.view==="codex")renderCodex();
    }));
  }
}

function wireCommon(){
  document.querySelectorAll("[data-view]").forEach(button=>{
    button.onclick=()=>{ui.view=button.dataset.view;render()};
  });
  document.querySelectorAll("[data-card-id]").forEach(card=>{
    card.onclick=()=>openOwnedCard(card.dataset.cardId);
  });
  document.querySelectorAll("[data-definition]").forEach(node=>{
    node.onclick=()=>openDefinition(node.dataset.definition);
  });
  document.querySelectorAll("[data-favorite]").forEach(button=>{
    button.onclick=(event)=>{
      event.stopPropagation();
      const id=button.dataset.favorite;
      if(ui.favorites.has(id))ui.favorites.delete(id);else ui.favorites.add(id);
      localStorage.setItem("lifecards:favorites",JSON.stringify([...ui.favorites]));
      button.classList.toggle("active",ui.favorites.has(id));
      button.textContent=ui.favorites.has(id)?"★":"☆";
    };
  });
  wireMediaObservers();
}

function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function revealRarityClass(card){
  return "reveal-rarity-"+String(card?.definition?.rarity||card?.rarity||"COMMON").toLowerCase().replaceAll("_","-");
}

function revealSummaryCard(card){
  const d=card.definition;
  const rarity=RARITY[d.rarity]||{short:"?"};
  return '<article class="reveal-summary-card '+revealRarityClass(card)+' '+(card.finish==="HOLO"?"holo":"")+'">'+
    '<div class="reveal-summary-art">'+imageMarkup(d)+'<span>'+esc(rarity.short)+'</span>'+(card.finish==="HOLO"?'<i>✦</i>':"")+'</div>'+
    '<div><b>'+esc(d.commonName)+'</b><em>'+esc(d.scientificName)+'</em><small>'+esc(card.edition)+' · '+esc(serial(card))+'</small></div>'+
  '</article>';
}

async function openPack(){
  if(ui.opening||ui.state.user.packs<1)return;
  ui.opening=true;

  try{
    revealDialog.showModal();
    revealScene.innerHTML=
      '<div class="opening-stage opening-sequence">'+
        '<button class="reveal-close" data-close-reveal>×</button>'+
        '<div class="opening-title"><span>FIELD ARCHIVE</span><b>Opening biological archive</b><small>Six discoveries are being authenticated…</small></div>'+
        '<div class="opening-pack-rig">'+
          '<div class="opening-pack-shadow"></div>'+
          '<div class="opening-pack-shell">'+
            '<div class="opening-pack-top"></div>'+
            '<span class="pack-seal">LC</span>'+
            '<div class="pack-lines"></div>'+
            '<strong>FIELD<br>ARCHIVE</strong>'+
            '<small>6 DISCOVERIES</small>'+
            '<i class="opening-pack-mark">✦</i>'+
          '</div>'+
        '</div>'+
        '<div class="opening-scan"><i></i></div>'+
        '<div class="opening-pulse"></div>'+
      '</div>';

    document.querySelector("[data-close-reveal]")?.addEventListener("click",()=>revealDialog.close());

    const [result]=await Promise.all([
      api("/api/packs/open",{method:"POST",body:"{}"}),
      wait(850)
    ]);

    ui.reveal={cards:result.cards,originCard:result.originCard};
    ui.revealIndex=0;

    const stage=revealScene.querySelector(".opening-stage");
    stage?.classList.add("pack-ripped");
    await wait(560);

    renderReveal();

    warmMedia(
      [...result.cards,result.originCard].filter(Boolean).map(card=>card.definition),
      {rerender:false}
    ).then(()=>{
      if(revealDialog.open&&ui.reveal)renderReveal();
    }).catch(()=>{});

    await refresh(false);
  }catch(error){
    revealDialog.close();
    flash(error.message);
  }finally{
    ui.opening=false;
  }
}

function renderRevealSummary(){
  if(!ui.reveal)return;
  const cards=[...ui.reveal.cards,...(ui.reveal.originCard?[ui.reveal.originCard]:[])];

  revealScene.innerHTML=
    '<div class="reveal-summary">'+
      '<button class="reveal-close" data-close-reveal>×</button>'+
      '<div class="reveal-summary-head"><span class="eyebrow">ARCHIVE COMPLETE</span><h2>Your discoveries</h2><p>'+ui.reveal.cards.length+' cards catalogued'+(ui.reveal.originCard?' · Origin event detected':'')+'.</p></div>'+
      '<div class="reveal-summary-grid">'+cards.map(revealSummaryCard).join("")+'</div>'+
      '<div class="reveal-summary-actions"><button class="reveal-next summary-continue" id="revealFinish">Add to collection</button></div>'+
    '</div>';

  document.querySelector("[data-close-reveal]")?.addEventListener("click",finishReveal);
  document.getElementById("revealFinish")?.addEventListener("click",finishReveal);
  wireMediaObservers();
}

function renderReveal(){
  if(!ui.reveal)return;

  const total=ui.reveal.cards.length+(ui.reveal.originCard?1:0);
  if(ui.revealIndex>=total){
    renderRevealSummary();
    return;
  }

  const isOrigin=Boolean(ui.reveal.originCard&&ui.revealIndex===ui.reveal.cards.length);
  const card=isOrigin?ui.reveal.originCard:ui.reveal.cards[ui.revealIndex];
  const rarity=RARITY[card.definition.rarity]||{label:card.definition.rarity,short:"?"};
  const isHolo=card.finish==="HOLO";
  const normalIndex=Math.min(ui.revealIndex+1,ui.reveal.cards.length);
  const remaining=Math.max(0,total-ui.revealIndex-1);

  revealScene.innerHTML=
    '<div class="reveal-layout '+revealRarityClass(card)+' '+(isOrigin?"origin-mode ":"")+(isHolo?"holo-impact":"")+'">'+
      '<div class="rarity-flare"></div>'+
      '<div class="reveal-noise"></div>'+
      '<button class="reveal-close" data-close-reveal>×</button>'+
      '<div class="reveal-counter">'+
        (isOrigin
          ?'<span>ORIGIN DETECTED</span><b>UNKNOWN · #1/1</b>'
          :'<span>DISCOVERY '+normalIndex+' / '+ui.reveal.cards.length+'</span><b>'+esc(rarity.label)+(isHolo?' · HOLO':'')+'</b>')+
      '</div>'+
      '<div class="reveal-card-stage">'+
        '<div class="reveal-card-aura"></div>'+
        '<div class="single-card-wrap enter">'+cardHtml(card,{interactive:false})+'</div>'+
      '</div>'+
      '<div class="reveal-card-caption">'+
        '<span>'+esc(card.edition)+'</span>'+
        '<b>'+esc(serial(card))+'</b>'+
        '<small>'+esc(card.definition.rank||card.definition.kind||"")+'</small>'+
      '</div>'+
      '<div class="reveal-dots">'+
        ui.reveal.cards.map((_,i)=>'<i class="'+(i<ui.revealIndex||(!isOrigin&&i===ui.revealIndex)?"active":"")+'"></i>').join("")+
        (ui.reveal.originCard?'<i class="origin-dot '+(isOrigin?"active":"")+'"></i>':"")+
      '</div>'+
      '<button class="reveal-next" id="revealNext">'+(remaining?'Next discovery · '+remaining+' left':'View pack recap')+'</button>'+
      '<small class="reveal-shortcut">Click the card or press Space / →</small>'+
    '</div>';

  const advance=()=>{
    ui.revealIndex+=1;
    renderReveal();
  };

  document.querySelector("[data-close-reveal]")?.addEventListener("click",finishReveal);
  document.getElementById("revealNext")?.addEventListener("click",advance);
  document.querySelector(".single-card-wrap")?.addEventListener("click",advance);

  revealDialog.onkeydown=(event)=>{
    if([" ","ArrowRight","Enter"].includes(event.key)){
      event.preventDefault();
      advance();
    }
    if(event.key==="Escape"){
      event.preventDefault();
      finishReveal();
    }
  };

  wireMediaObservers();
}

function finishReveal(){
  revealDialog.onkeydown=null;
  revealDialog.close();
  ui.reveal=null;
  ui.revealIndex=0;
  render();
}

function openOwnedCard(id){
  const card=ui.cardIndex.get(String(id))||ui.state.inventory.find(c=>c.id===id);
  if(!card)return;
  openCardModal(card.definition,card);
}

async function openDefinition(id){
  const local=ui.state.catalog.find(x=>String(x.id)===String(id));
  if(local)return openCardModal(local,null);
  const cached=ui.codexResults.find(x=>String(x.id)===String(id));
  if(cached)return openCardModal(cached,null);
  try{
    const result=await api("/api/taxonomy/taxon?id="+encodeURIComponent(id));
    if(result.taxon)openCardModal(taxonToDefinition(result.taxon),null);
  }catch(error){
    flash(error.message);
  }
}

function detailPathHtml(context){
  const path=context?.path||[];
  if(!path.length)return '<div class="phylo-path-empty">Phylogenetic path resolving…</div>';

  return '<div class="phylo-path">'+path.map((node,index)=>
    '<button data-detail-tree="'+esc(node.id)+'" data-detail-tree-rank="'+esc(node.rank||node.kind||"")+'">'+
      '<span>'+esc(node.commonName||node.scientificName)+'</span>'+
      '<small>'+esc(node.rank||node.kind||"")+'</small>'+
    '</button>'+
    (index<path.length-1?'<i>›</i>':"")
  ).join("")+'</div>';
}

function detailMetric(label,value,extra=""){
  return '<div class="record-metric"><small>'+esc(label)+'</small><b>'+esc(value||"—")+'</b>'+(extra?'<em>'+esc(extra)+'</em>':"")+'</div>';
}

function wireCardRecord(definition,card,context){
  cardModalContent.querySelectorAll("[data-detail-tree]").forEach(button=>{
    button.onclick=()=>{
      const id=button.dataset.detailTree;
      const node=(context?.path||[]).find(item=>String(item.id)===String(id))||context?.taxon||null;
      cardModal.close();
      ui.view="tree";
      render();
      queueMicrotask(()=>focusTree(id,node));
    };
  });

  cardModalContent.querySelector("[data-explore-record]")?.addEventListener("click",()=>{
    const target=context?.taxon;
    if(!target)return;
    cardModal.close();
    ui.view="tree";
    render();
    queueMicrotask(()=>focusTree(target.id,target));
  });
}

function renderCardModal(definition,card){
  const media=getMedia(definition);
  const knowledge=ui.knowledge.get(definition.id);
  const live=knowledge&&knowledge!==false?knowledge:null;
  const context=taxonomyContextFor(definition);
  const taxon=context?.taxon||null;
  const summary=live?.wikipedia?.extract||definition.summary||"Scientific description not yet resolved.";
  const sourceLine=live?.sources?.length
    ? live.sources.join(" · ")
    : (knowledge===false
      ?"External enrichment unavailable — local scientific snapshot shown."
      :"Resolving Wikipedia, Wikidata and reusable media…");
  const taxId=live?.taxonomy?.ncbiTaxId||null;
  const displayName=(definition.commonName&&definition.commonName!==definition.scientificName)
    ? definition.commonName
    : (live?.wikipedia?.title||definition.commonName||definition.scientificName);

  const colTaxonId=taxon?.sourceId||definition.taxonomyId||(
    definition.source&&String(definition.source).includes("Catalogue of Life")?definition.id:null
  );
  const colUrl=colTaxonId
    ?"https://www.catalogueoflife.org/data/taxon/"+encodeURIComponent(colTaxonId)
    :null;

  const currentEdition=card?.edition||(
    definition.kind==="taxon"?"FOUNDATION I":
    definition.temporalStatus==="extinct"?"FOSSIL RECORD I":
    definition.kind==="origin"?"ORIGIN":"RESEARCH"
  );
  const supply=supplyFor(definition.id,currentEdition);
  const rank=taxon?.rank||definition.rank||definition.kind||"unranked";
  const speciesCount=Number(taxon?.descendantSpeciesCount||definition.descendantSpeciesCount||0);
  const directChildren=Number(taxon?.childCount||definition.childCount||0);
  const taxonomyReady=ui.taxonomyContext.has(String(definition.id));
  const rarity=RARITY[definition.rarity]||{label:definition.rarity};

  cardModalContent.innerHTML=
    '<div class="scientific-record">'+
      '<aside class="record-object">'+
        '<div class="record-card-shell">'+(card?cardHtml(card,{interactive:false}):definitionPreview(definition))+'</div>'+
        '<div class="record-provenance">'+
          '<span class="eyebrow">COLLECTIBLE OBJECT</span>'+
          (card
            ?'<div class="provenance-grid">'+
              detailMetric("Edition",card.edition)+
              detailMetric("Serial",serial(card))+
              detailMetric("Finish",card.finish)+
              detailMetric("Rarity",rarity.label)+
            '</div>'
            :'<p>Reference view — no physical card instance selected.</p>')+
        '</div>'+
      '</aside>'+
      '<article class="record-sheet">'+
        '<header class="record-header">'+
          '<div><span class="eyebrow">'+esc(definition.kind)+' · '+esc(rank)+'</span><h2>'+esc(displayName)+'</h2><em>'+esc(definition.scientificName)+'</em></div>'+
          '<div class="record-badges">'+
            '<span class="rarity-record">'+esc(rarity.label)+'</span>'+
            (definition.conservation?'<span>'+esc(definition.conservation)+'</span>':"")+
            (definition.temporalStatus==="extinct"?'<span>Extinct</span>':"")+
          '</div>'+
        '</header>'+
        '<section class="record-section phylogeny-section">'+
          '<div class="record-section-title"><div><span class="eyebrow">PHYLOGENETIC LINEAGE</span><h3>Position in the Tree of Life</h3></div>'+
            (taxon?'<button class="record-tree-action" data-explore-record>Explore branch →</button>':"")+
          '</div>'+
          detailPathHtml(context)+
        '</section>'+
        '<section class="record-metrics">'+
          detailMetric("Rank",rank)+
          detailMetric("Species in clade",speciesCount?formatNumber(speciesCount):(rank==="species"?"1":"—"))+
          detailMetric("Direct branches",directChildren?formatNumber(directChildren):"—")+
          detailMetric("Issued supply",supply?formatNumber(supply.issued):"—",card?.serialCap?"cap "+formatNumber(card.serialCap):"")+
          (taxId?detailMetric("NCBI Taxonomy ID",taxId):"")+
          (live?.wikidata?.id?detailMetric("Wikidata",live.wikidata.id):"")+
        '</section>'+
        '<section class="record-section record-description">'+
          '<span class="eyebrow">SCIENTIFIC NOTE</span>'+
          '<p class="knowledge-extract">'+esc(summary)+'</p>'+
        '</section>'+
        '<section class="record-section record-sources">'+
          '<div class="record-section-title"><div><span class="eyebrow">TRACEABILITY</span><h3>Sources & provenance</h3></div></div>'+
          '<div class="source-actions">'+
            (colUrl?'<a class="source-button col" href="'+esc(colUrl)+'" target="_blank" rel="noopener">Catalogue of Life ↗</a>':"")+
            knowledgeSourceButtons(live)+
          '</div>'+
          '<div class="source-meta">'+
            '<span>'+esc(sourceLine)+'</span>'+
            (definition.taxonomyRelease?'<small>Card taxonomy snapshot: '+esc(definition.taxonomyRelease)+'</small>':"")+
            (context?.taxonomy?.release?'<small>Current map taxonomy: '+esc(context.taxonomy.release)+'</small>':"")+
            (media&&media.creator?'<small>Image: '+esc(media.creator)+' · '+esc(media.license||"")+' · '+esc(media.source||"")+'</small>':"")+
            (!taxonomyReady?'<small>Taxonomic lineage loading…</small>':"")+
          '</div>'+
        '</section>'+
      '</article>'+
    '</div>';

  wireCardRecord(definition,card,context);
  wireMediaObservers();
}

function openCardModal(definition,card){
  renderCardModal(definition,card);
  cardModal.showModal();

  Promise.allSettled([
    loadKnowledge(definition),
    loadSupplies(definition.id),
    loadTaxonomyContext(definition),
  ]).then(()=>{
    if(cardModal.open)renderCardModal(definition,card);
  });
}

async function listCard(cardId){
  const price=window.prompt("Listing price in Coins:");
  if(price==null)return;
  const amount=Number(price);
  if(!Number.isSafeInteger(amount)||amount<=0)return flash("Enter a whole positive Coin amount");
  try{
    await api("/api/market/list",{method:"POST",body:JSON.stringify({cardId,price:amount})});
    ui.marketData=null;
    ui.collectionData=null;
    flash("Listed on market");
    await refresh();
    if(ui.view==="market")loadMarketData({resetPage:true});
  }catch(error){flash(error.message)}
}

async function buy(listingId){
  try{
    await api("/api/market/buy",{method:"POST",body:JSON.stringify({listingId})});
    ui.marketData=null;
    ui.collectionData=null;
    flash("Card acquired");
    await refresh();
    if(ui.view==="market")loadMarketData();
  }catch(error){flash(error.message)}
}

async function refresh(shouldRender=true){
  const previousCollectionTotal=ui.state?.collectionSummary?.totalCards;
  ui.state=await api("/api/state");
  if(
    ui.collectionData &&
    previousCollectionTotal!=null &&
    ui.state.collectionSummary?.totalCards!==previousCollectionTotal
  ){
    ui.collectionData=null;
  }
  if(ui.view==="collection"&&!ui.collectionData&&!ui.collectionLoading){
    queueMicrotask(()=>loadCollectionData({resetPage:true}));
  }
  ui.stateFetchedAt=Date.now();
  if(!ui.taxonomyStatus){
    api("/api/taxonomy/status").then(result=>{
      ui.taxonomyStatus=result.taxonomy||null;
      if(["tree","codex","packs"].includes(ui.view))render();
    }).catch(()=>{});
  }
  updateChrome();
  if(shouldRender)render();
}

document.getElementById("closeCard").onclick=()=>cardModal.close();
revealDialog.addEventListener("click",event=>{if(event.target===revealDialog)finishReveal()});
cardModal.addEventListener("click",event=>{if(event.target===cardModal)cardModal.close()});

setInterval(()=>{
  if(!ui.state)return;
  const timerEl=document.getElementById("nextPackTimer");
  if(timerEl&&ui.state.user.packs<ui.state.user.maxPacks){
    const remaining=liveNextPackMs();
    timerEl.textContent="Next in "+formatTimer(remaining);
    if(remaining<=0&&!revealDialog.open)refresh().catch(()=>{});
  }
},1000);

refresh().catch(error=>{main.innerHTML='<div class="fatal">'+esc(error.message)+'</div>'});
