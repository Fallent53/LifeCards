import { RadialTreeMap } from "./radial-tree.js";

const ui={
  view:"packs",
  state:null,
  media:new Map(),
  mediaLoading:new Set(),
  knowledge:new Map(),
  knowledgeLoading:new Set(),
  collectionFilter:"ALL",
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
  const media=getMedia(definition);
  if(media&&media.imageUrl){
    return '<img src="'+esc(media.imageUrl)+'" alt="'+esc(definition.commonName)+'" loading="lazy" draggable="false">';
  }
  const initials=(definition.commonName||definition.scientificName||"?").split(/\s+/).slice(0,2).map(x=>x[0]).join("");
  return '<div class="art-fallback"><span>'+esc(definition.icon||"◌")+'</span><b>'+esc(initials)+'</b></div>';
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
        '<div class="pack-rules"><span>6 cards</span><span>1 pack / 8 min</span><span>8 stored max</span><span>'+Math.round(config.holoRate*1000)/10+'% Holo</span></div>'+
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

function renderCollection(){
  const inventory=ui.state.inventory;
  const q=ui.query.trim().toLowerCase();
  let filtered=inventory.filter(card=>{
    const d=card.definition;
    const queryOk=!q||[d.commonName,d.scientificName,d.rarity,card.edition].some(v=>String(v||"").toLowerCase().includes(q));
    if(!queryOk)return false;
    if(ui.collectionFilter==="ALL")return true;
    if(ui.collectionFilter==="HOLO")return card.finish==="HOLO";
    if(ui.collectionFilter==="WILD")return card.edition==="WILD CENSUS I";
    if(ui.collectionFilter==="TAXA")return card.kind==="taxon";
    if(ui.collectionFilter==="SPECIES")return card.kind==="species";
    return true;
  });
  const filters=["ALL","SPECIES","TAXA","WILD","HOLO"];
  main.innerHTML=
    '<section class="library-page">'+
      '<div class="page-hero compact-hero"><span class="eyebrow">YOUR ARCHIVE</span><h1>Collection</h1><p>'+inventory.length+' cards · '+new Set(inventory.map(c=>c.definitionId)).size+' unique discoveries</p></div>'+
      '<div class="collection-toolbar">'+
        '<label class="search-box"><span>⌕</span><input id="collectionSearch" placeholder="Search species, taxa, edition..." value="'+esc(ui.query)+'"></label>'+
        '<div class="filter-row">'+filters.map(f=>'<button data-filter="'+f+'" class="'+(ui.collectionFilter===f?"active":"")+'">'+f+'</button>').join("")+'</div>'+
      '</div>'+
      '<div class="card-grid collection-grid">'+(filtered.length?filtered.map(c=>cardHtml(c,{compact:true,showSell:true})).join(""):'<div class="empty-state">No cards match this filter.</div>')+'</div>'+
    '</section>';
  const search=document.getElementById("collectionSearch");
  search?.addEventListener("input",event=>{ui.query=event.target.value;renderCollection();wireCommon()});
  document.querySelectorAll("[data-filter]").forEach(button=>button.onclick=()=>{ui.collectionFilter=button.dataset.filter;renderCollection();wireCommon()});
  document.querySelectorAll("[data-sell]").forEach(button=>button.onclick=event=>{event.stopPropagation();listCard(button.dataset.sell)});
  warmMedia(filtered.slice(0,24).map(c=>c.definition));
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
  warmMedia(listings.slice(0,18).map(x=>x.card.definition));
}

async function loadTreePayload(rootId){
  const query=rootId?"&root="+encodeURIComponent(rootId):"";
  const payload=await api("/api/taxonomy/subtree?depth=4&childLimit=44&nodeLimit=900"+query);
  ui.treePayload=payload;
  ui.taxonomyStatus=payload?.status||ui.taxonomyStatus;
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
  radialMap=new RadialTreeMap(holder,{
    onFocus:(node)=>focusTree(node.id),
    onSelect:(node)=>openTaxonomyNode(node),
    onHome:()=>focusTree(payload.status?.rootId||ui.taxonomyStatus?.rootId||"animalia"),
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
        '<div class="taxonomy-status '+(status?.ready?"ready":"seed")+'"><i></i><div><b>'+esc(taxonomySummary(status))+'</b><small>'+(status?.ready?esc(status.release||status.datasetKey||"Catalogue of Life"):'The game remains usable while the full database is absent.')+'</small></div></div>'+
      '</div>'+
      '<div class="tree-map-controls">'+
        '<div class="tree-search-wrap radial-search"><label class="search-box"><span>⌕</span><input id="treeSearch" autocomplete="off" placeholder="Lion, Felidae, Mollusca, Arthropoda…" value="'+esc(ui.treeQuery)+'"></label><div id="treeSearchResults" class="tree-search-results"></div></div>'+
        '<div id="treeBreadcrumb" class="tree-breadcrumb"></div>'+
      '</div>'+
      '<div id="radialTreeMap" class="radial-tree-map loading"><div class="radial-loading"><span></span><b>Building phylogenetic map…</b></div></div>'+
      '<div class="tree-map-foot"><span>Data backbone: '+esc(status?.ready?"Catalogue of Life":"LifeCards seed taxonomy")+'</span><span>External scientific links: Wikipedia · Wikidata · NCBI · Lifemap</span></div>'+
    '</section>';

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
    focusTree(status?.rootId||"");
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
      '<div class="codex-dataset-banner '+(status?.ready?"ready":"seed")+'"><b>'+esc(taxonomySummary(status))+'</b><small>'+(status?.ready?"Search is querying the local Catalogue of Life database.":"Run npm install then npm run sync:col for the complete Animalia catalogue.")+'</small></div>'+
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
  warmMedia(catalog.slice(0,18));
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
  const card=ui.state.inventory.find(c=>c.id===id)||ui.state.market.map(x=>x.card).find(c=>c.id===id);
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
        '<h2>'+esc(definition.commonName)+'</h2>'+
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
        '<div class="source-actions">'+knowledgeSourceButtons(live)+'</div>'+
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
  ui.state=await api("/api/state");
  ui.stateFetchedAt=Date.now();
  if(!ui.taxonomyStatus){
    api("/api/taxonomy/status").then(result=>{
      ui.taxonomyStatus=result.taxonomy||null;
      if(ui.view==="tree"||ui.view==="codex")render();
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
