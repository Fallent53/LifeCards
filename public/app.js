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
  query:"",
  codexQuery:"",
  codexResults:[],
  codexSearchLoading:false,
  treeQuery:"",
  treeSearchResults:[],
  treePayload:null,
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
  return ui.state?.supplies?.find(s=>s.definitionId===definitionId&&s.edition===edition)||null;
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
      await loadMedia(definition);
      updateMediaNodes(id);
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
      loadMedia(definition).then(()=>updateMediaNodes(id)).catch(()=>updateMediaNodes(id));
    }
  },{rootMargin:"320px 0px",threshold:0.01});

  nodes.forEach(node=>mediaObserver.observe(node));
}

function knowledgeQuery(definition){
  if(definition.kind==="origin")return definition.commonName||"Last universal common ancestor";
  return definition.scientificName||definition.commonName;
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
    return "Catalogue of Life · "+taxa+species;
  }
  return "Seed tree · import full Animalia with npm run sync:col";
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
  const slots=Array.from({length:user.maxPacks},(_,i)=>'<span class="storage-slot '+(i<user.packs?"filled":"")+'"></span>').join("");
  const recent=inventory.slice(0,6);
  main.innerHTML=
    '<section class="pack-page">'+
      '<div class="pack-copy">'+
        '<span class="eyebrow">EXPEDITION SUPPLY</span>'+
        '<h1>Open the living world.</h1>'+
        '<p>Six discoveries per pack. Species, extinct life and phylogenetic nodes all share the same Tree of Life.</p>'+
        '<div class="pack-rules"><span>6 cards</span><span>1 pack / 8 min</span><span>8 stored max</span><span>'+Math.round(config.holoRate*1000)/10+'% Holo</span>'+
          (ui.taxonomyStatus?.dropPoolReady?'<span class="data-live">'+formatNumber(Object.values(ui.taxonomyStatus.dropPool||{}).reduce((a,b)=>a+b,0))+' indexed cards</span>':'<span class="data-seed">Seed drop pool</span>')+
        '</div>'+
      '</div>'+
      '<div class="pack-stage">'+
        '<div class="ambient-ring ring-one"></div><div class="ambient-ring ring-two"></div>'+
        '<button id="packObject" class="pack-object '+(user.packs<1?"empty":"")+'" '+(user.packs<1?"disabled":"")+'>'+
          '<span class="pack-seal">LC</span>'+
          '<div class="pack-lines"></div>'+
          '<strong>FIELD<br>ARCHIVE</strong>'+
          '<small>6 DISCOVERIES</small>'+
          '<span class="pack-specimen">✦</span>'+
        '</button>'+
        '<button id="openPack" class="primary-cta" '+(user.packs<1?"disabled":"")+'>'+ (user.packs>0?"Open pack":"No pack ready") +'</button>'+
        '<div class="storage-card">'+
          '<div><b>'+user.packs+' / '+user.maxPacks+'</b><small>packs available</small></div>'+
          '<div class="storage-slots">'+slots+'</div>'+
          '<span id="nextPackTimer">'+(user.packs>=user.maxPacks?"Storage full":"Next in "+formatTimer(liveNextPackMs()))+'</span>'+
        '</div>'+
      '</div>'+
      '<aside class="origin-tease '+(ui.state.origin?.discovered?"discovered":"")+'"><div class="origin-orbit"></div><span class="eyebrow">THE ORIGIN</span><h2>LUCA</h2><b>UNKNOWN · '+(ui.state.origin?.discovered?"1 / 1 DISCOVERED":"0 / 1 UNDISCOVERED")+'</b><p>'+(ui.state.origin?.discovered?"The unique Origin card has entered circulation. No second copy can ever be issued.":"One card. One owner. Eligible from the very first pack.")+'</p></aside>'+
    '</section>'+
    '<section class="recent-section"><div class="section-head"><div><span class="eyebrow">RECENT DISCOVERIES</span><h2>Your latest cards</h2></div><button data-view="collection" class="ghost-button">View collection →</button></div>'+
      '<div class="card-grid recent-grid">'+(recent.length?recent.map(c=>cardHtml(c,{compact:true})).join(""):'<div class="empty-state">Your first six discoveries will appear here.</div>')+'</div>'+
    '</section>';
  document.getElementById("openPack")?.addEventListener("click",openPack);
  document.getElementById("packObject")?.addEventListener("click",openPack);
  warmMedia(recent.map(c=>c.definition));
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

function renderMarket(){
  const allListings=ui.state.market;
  const listings=allListings.filter(listing=>{
    if(ui.marketFilter==="HOLO")return listing.card.finish==="HOLO";
    if(ui.marketFilter==="WILD")return listing.card.edition==="WILD CENSUS I";
    if(ui.marketFilter==="FOSSIL")return listing.card.edition==="FOSSIL RECORD I";
    return true;
  });
  const marketFilters=["ALL","HOLO","WILD","FOSSIL"];
  main.innerHTML=
    '<section class="market-page">'+
      '<div class="page-hero compact-hero"><span class="eyebrow">SECONDARY MARKET</span><h1>Market</h1><p>Collect editions, serials and finishes. Transactions use Coins; a 5% fee leaves the economy on each sale.</p></div>'+
      '<div class="market-toolbar"><span>'+listings.length+' / '+allListings.length+' active listings</span><div>'+marketFilters.map(filter=>'<button class="filter-chip '+(ui.marketFilter===filter?"active":"")+'" data-market-filter="'+filter+'">'+filter+'</button>').join("")+'</div></div>'+
      '<div class="market-grid">'+(listings.length?listings.map(listing=>
        '<article class="market-item">'+cardHtml(listing.card,{compact:true})+
        '<div class="market-meta"><div><small>ASK</small><strong>◆ '+formatNumber(listing.price)+'</strong><span>'+esc(listing.sellerId)+'</span></div><button data-buy="'+esc(listing.id)+'">Buy</button></div></article>'
      ).join(""):'<div class="empty-state">No listings match this filter.</div>')+'</div>'+
    '</section>';
  document.querySelectorAll("[data-buy]").forEach(button=>button.onclick=event=>{event.stopPropagation();buy(button.dataset.buy)});
  document.querySelectorAll("[data-market-filter]").forEach(button=>button.onclick=()=>{ui.marketFilter=button.dataset.marketFilter;renderMarket();wireCommon()});
  wireMediaObservers();
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

async function loadTreePayload(rootId){
  const query=rootId?"&root="+encodeURIComponent(rootId):"";
  const payload=await api("/api/taxonomy/subtree?depth=4&childLimit=44&nodeLimit=900"+query);
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

async function focusTree(rootId){
  const holder=document.getElementById("radialTreeMap");
  if(holder)holder.classList.add("loading");
  try{
    const payload=await loadTreePayload(rootId);
    if(ui.view!=="tree")return;
    drawRadialTree(payload);
    renderTreeBreadcrumb(payload);
  }catch(error){
    const target=document.getElementById("radialTreeMap");
    if(target)target.innerHTML='<div class="radial-empty">'+esc(error.message)+'</div>';
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
    onFocus:(node)=>focusTree(node.id),
    onSelect:(node)=>openTaxonomyNode(node),
    onHome:()=>focusTree(payload.status?.mapRootId||ui.taxonomyStatus?.mapRootId||"luca"),
    onUp:(current)=>{
      const path=current?.path||[];
      const parent=path.length>1?path[path.length-2]:null;
      if(parent)focusTree(parent.id);
    }
  });
  radialMap.render(payload);
}

async function openTaxonomyNode(node){
  const definition=taxonToDefinition(node);
  if(!definition)return;
  if(Number(node.childCount||0)>0||String(node.rank||"").toLowerCase()!=="species"){
    return focusTree(node.id);
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
    '<button data-tree-result="'+esc(node.id)+'"><span class="tree-result-dot"></span><div><b>'+esc(node.commonName||node.scientificName)+'</b><small>'+esc(node.scientificName)+' · '+esc(node.rank||"")+' · '+formatNumber(node.childCount||0)+' children</small></div></button>'
  ).join(""):'<div class="tree-search-empty">No taxon found</div>';
  target.querySelectorAll("[data-tree-result]").forEach(button=>{
    button.onclick=()=>{
      const node=results.find(item=>String(item.id)===String(button.dataset.treeResult));
      ui.treeQuery="";
      ui.treeSearchResults=[];
      if(node&&String(node.rank||"").toLowerCase()!=="species")focusTree(node.id);
      else if(node)openTaxonomyNode(node);
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
      '<div class="tree-map-foot"><span>Data backbone: '+esc(status?.ready?"Catalogue of Life":"LifeCards seed taxonomy")+'</span><span>External scientific links: Wikipedia · Wikidata · NCBI · Lifemap</span></div>'+
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

function scheduleCodexSearch(query){
  clearTimeout(codexSearchTimer);
  const q=String(query||"").trim();
  if(q.length<2){
    ui.codexResults=[];
    ui.codexSearchLoading=false;
    renderCodex();
    return;
  }
  ui.codexSearchLoading=true;
  codexSearchTimer=setTimeout(async()=>{
    try{
      const result=await api("/api/taxonomy/search?q="+encodeURIComponent(q)+"&limit=60");
      if(ui.codexQuery.trim()!==q)return;
      ui.codexResults=(result.results||[]).map(taxonToDefinition);
      ui.taxonomyStatus=result.taxonomy||ui.taxonomyStatus;
    }catch{
      ui.codexResults=[];
    }finally{
      ui.codexSearchLoading=false;
      if(ui.view==="codex")renderCodex();
    }
  },240);
}

function renderCodex(){
  const q=ui.codexQuery.trim();
  const local=ui.state.catalog;
  const catalog=q.length>=2?ui.codexResults:local;
  const status=ui.taxonomyStatus;
  main.innerHTML=
    '<section class="codex-page">'+
      '<div class="page-hero compact-hero"><span class="eyebrow">LIVING ENCYCLOPEDIA</span><h1>Codex</h1><p>Search the complete taxonomy locally after a Catalogue of Life import. Images and descriptions resolve lazily through Wikipedia/Wikimedia.</p></div>'+
      '<div class="collection-toolbar codex-toolbar"><label class="search-box"><span>⌕</span><input id="codexSearch" autocomplete="off" placeholder="Search any animal scientific name…" value="'+esc(ui.codexQuery)+'"></label><span class="result-count">'+(ui.codexSearchLoading?"Searching…":catalog.length+" shown")+'</span></div>'+
      '<div class="codex-dataset-banner '+(status?.ready?"ready":"seed")+'"><b>'+esc(taxonomySummary(status))+'</b><small>'+(status?.mode==="catalogue-of-life-live"?"Searching the public ChecklistBank API; local import is optional for speed and offline use.":status?.ready?"Search is querying the local Catalogue of Life database.":"Using the small seed catalogue until Catalogue of Life is reachable.")+'</small></div>'+
      '<div class="codex-grid">'+(catalog.length?catalog.map(d=>
        '<article class="codex-row" data-definition="'+esc(d.id)+'"><div class="codex-thumb">'+imageMarkup(d)+'</div><div class="codex-copy"><span class="codex-type">'+esc(d.kind)+' · '+esc(d.rank||d.rarity||"")+'</span><h3>'+esc(d.commonName)+'</h3><em>'+esc(d.scientificName)+'</em><p>'+esc(cardSummary(d))+'</p></div><span class="codex-arrow">→</span></article>'
      ).join(""):'<div class="empty-state">'+(ui.codexSearchLoading?"Searching the taxonomy…":"No taxon found.")+'</div>')+'</div>'+
    '</section>';

  const codexSearch=document.getElementById("codexSearch");
  codexSearch?.addEventListener("input",event=>{
    ui.codexQuery=event.target.value;
    scheduleCodexSearch(ui.codexQuery);
  });
  document.querySelectorAll("[data-definition]").forEach(row=>row.onclick=()=>openDefinition(row.dataset.definition));
  wireMediaObservers();
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

async function openPack(){
  if(ui.opening||ui.state.user.packs<1)return;
  ui.opening=true;
  try{
    revealDialog.showModal();
    revealScene.innerHTML=
      '<div class="opening-stage">'+
        '<button class="reveal-close" data-close-reveal>×</button>'+
        '<div class="opening-title"><span>FIELD ARCHIVE</span><b>Preparing 6 discoveries…</b></div>'+
        '<div class="opening-pack animate"><span class="pack-seal">LC</span><strong>FIELD<br>ARCHIVE</strong><small>6 DISCOVERIES</small></div>'+
        '<div class="opening-pulse"></div>'+
      '</div>';
    document.querySelector("[data-close-reveal]")?.addEventListener("click",()=>revealDialog.close());
    const result=await api("/api/packs/open",{method:"POST",body:"{}"});
    ui.reveal={cards:result.cards,originCard:result.originCard};
    ui.revealIndex=0;
    setTimeout(()=>renderReveal(),420);
    warmMedia(result.cards.map(c=>c.definition),{rerender:false}).then(()=>{
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

function renderReveal(){
  if(!ui.reveal)return;
  const isOrigin=ui.revealIndex>=ui.reveal.cards.length&&ui.reveal.originCard;
  const card=isOrigin?ui.reveal.originCard:ui.reveal.cards[Math.min(ui.revealIndex,ui.reveal.cards.length-1)];
  const normalIndex=Math.min(ui.revealIndex+1,ui.reveal.cards.length);
  const lastNormal=ui.revealIndex===ui.reveal.cards.length-1;
  const hasOrigin=Boolean(ui.reveal.originCard);
  const final=isOrigin||(!hasOrigin&&lastNormal);
  revealScene.innerHTML=
    '<div class="reveal-layout '+(isOrigin?"origin-mode":"")+'">'+
      '<button class="reveal-close" data-close-reveal>×</button>'+
      '<div class="reveal-counter">'+(isOrigin?'ORIGIN DETECTED':'CARD <b>'+normalIndex+'</b> / '+ui.reveal.cards.length)+'</div>'+
      '<div class="single-card-wrap enter">'+cardHtml(card,{interactive:false})+'</div>'+
      '<div class="reveal-dots">'+ui.reveal.cards.map((_,i)=>'<i class="'+(i<=ui.revealIndex&&!isOrigin?"active":"")+'"></i>').join("")+(hasOrigin?'<i class="origin-dot '+(isOrigin?"active":"")+'"></i>':"")+'</div>'+
      '<button class="reveal-next" id="revealNext">'+(final?"Continue":(isOrigin?"Continue":lastNormal&&hasOrigin?"Reveal anomaly":"Next card · "+(ui.reveal.cards.length-normalIndex)+" left"))+'</button>'+
    '</div>';
  document.querySelector("[data-close-reveal]")?.addEventListener("click",finishReveal);
  document.getElementById("revealNext").onclick=()=>{
    if(final)return finishReveal();
    ui.revealIndex+=1;
    renderReveal();
  };
  document.querySelector(".single-card-wrap")?.addEventListener("click",()=>{
    if(!final){ui.revealIndex+=1;renderReveal()}
  });
}

function finishReveal(){
  revealDialog.close();
  ui.reveal=null;
  ui.revealIndex=0;
  render();
}

function openOwnedCard(id){
  const card=ui.cardIndex.get(String(id))||ui.state.inventory.find(c=>c.id===id)||ui.state.market.map(x=>x.card).find(c=>c.id===id);
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

function renderCardModal(definition,card){
  const media=getMedia(definition);
  const knowledge=ui.knowledge.get(definition.id);
  const live=knowledge&&knowledge!==false?knowledge:null;
  const summary=live?.wikipedia?.extract||definition.summary||"";
  const sourceLine=live?.sources?.length
    ? live.sources.join(" · ")
    : (knowledge===false?"External scientific sources unavailable — local card data shown.":"Wikipedia / Wikidata / Lifemap resolving…");
  const taxId=live?.taxonomy?.ncbiTaxId||null;
  const displayName=(definition.commonName&&definition.commonName!==definition.scientificName)
    ? definition.commonName
    : (live?.wikipedia?.title||definition.commonName||definition.scientificName);
  const colUrl=definition.source&&String(definition.source).includes("Catalogue of Life")
    ? "https://www.catalogueoflife.org/data/taxon/"+encodeURIComponent(definition.taxonomyId||definition.id)
    : null;
  const currentEdition=card?.edition||(
    definition.kind==="taxon"?"FOUNDATION I":
    definition.temporalStatus==="extinct"?"FOSSIL RECORD I":
    definition.kind==="origin"?"ORIGIN":"WILD CENSUS I"
  );
  const supply=supplyFor(definition.id,currentEdition);

  cardModalContent.innerHTML=
    '<div class="detail-layout">'+
      '<div class="detail-card">'+(card?cardHtml(card,{interactive:false}):definitionPreview(definition))+'</div>'+
      '<div class="detail-copy">'+
        '<span class="eyebrow">'+esc(definition.kind)+' · '+esc(definition.rarity)+'</span>'+
        '<h2>'+esc(displayName)+'</h2>'+
        '<em>'+esc(definition.scientificName)+'</em>'+
        '<p class="knowledge-extract">'+esc(summary)+'</p>'+
        '<dl>'+
          '<div><dt>Type</dt><dd>'+esc(definition.kind)+'</dd></div>'+
          '<div><dt>Rank</dt><dd>'+esc(definition.rank||definition.temporalStatus||"—")+'</dd></div>'+
          '<div><dt>Parent</dt><dd>'+esc(definition.parentId||"Origin")+'</dd></div>'+
          (definition.conservation?'<div><dt>Conservation</dt><dd>'+esc(definition.conservation)+'</dd></div>':"")+
          (taxId?'<div><dt>NCBI Taxonomy ID</dt><dd>'+esc(taxId)+'</dd></div>':"")+
          (live?.wikidata?.id?'<div><dt>Wikidata</dt><dd>'+esc(live.wikidata.id)+'</dd></div>':"")+
          (supply?'<div><dt>Issued supply</dt><dd>'+formatNumber(supply.issued)+(card?.serialCap?" / "+formatNumber(card.serialCap):"")+'</dd></div>':"")+
        '</dl>'+
        '<div class="source-actions">'+
          (colUrl?'<a class="source-button col" href="'+esc(colUrl)+'" target="_blank" rel="noopener">Catalogue of Life ↗</a>':"")+
          knowledgeSourceButtons(live)+
        '</div>'+
        '<div class="source-meta"><span>'+esc(sourceLine)+'</span>'+
          (media&&media.creator?'<small>Image: '+esc(media.creator)+' · '+esc(media.license||"")+'</small>':"")+
        '</div>'+
      '</div>'+
    '</div>';
}

function openCardModal(definition,card){
  renderCardModal(definition,card);
  cardModal.showModal();
  loadKnowledge(definition).then(()=>{
    if(cardModal.open)renderCardModal(definition,card);
  }).catch(()=>{});
}

async function listCard(cardId){
  const price=window.prompt("Listing price in Coins:");
  if(price==null)return;
  const amount=Number(price);
  if(!Number.isSafeInteger(amount)||amount<=0)return flash("Enter a whole positive Coin amount");
  try{
    await api("/api/market/list",{method:"POST",body:JSON.stringify({cardId,price:amount})});
    flash("Listed on market");
    await refresh();
  }catch(error){flash(error.message)}
}

async function buy(listingId){
  try{
    await api("/api/market/buy",{method:"POST",body:JSON.stringify({listingId})});
    flash("Card acquired");
    await refresh();
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
