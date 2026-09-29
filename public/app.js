const ui={
  view:"packs",
  state:null,
  media:new Map(),
  mediaLoading:new Set(),
  science:new Map(),
  scienceLoading:new Set(),
  collectionFilter:"ALL",
  query:"",
  reveal:null,
  revealIndex:0,
  opening:false,
  knowledgeQuestion:null,
  knowledgeResult:null,
  knowledgeLoading:false,
  marketMode:"fixed",
  codexQuery:"",
  externalTaxa:[],
  taxonomySearchLoading:false,
  taxonomySearchTimer:null
};

const main=document.getElementById("main");
const coins=document.getElementById("coins");
const packBadge=document.getElementById("packBadge");
const revealDialog=document.getElementById("reveal");
const revealScene=document.getElementById("revealScene");
const cardModal=document.getElementById("cardModal");
const cardModalContent=document.getElementById("cardModalContent");
const toast=document.getElementById("toast");

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
  knowledge:["KNOWLEDGE LAB","Knowledge"],
  profile:["COLLECTOR PROFILE","Profile"],
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
  if(!definition||definition.kind==="origin"||ui.media.has(definition.id)||ui.mediaLoading.has(definition.id))return;
  ui.mediaLoading.add(definition.id);
  try{
    const result=await api("/api/media?definitionId="+encodeURIComponent(definition.id));
    ui.media.set(definition.id,result.media||false);
  }catch{
    ui.media.set(definition.id,false);
  }finally{
    ui.mediaLoading.delete(definition.id);
  }
}

async function warmMedia(definitions,{rerender=true}={}){
  const unique=[...new Map(definitions.filter(Boolean).map(d=>[d.id,d])).values()];
  const pending=unique.filter(d=>!ui.media.has(d.id)&&!ui.mediaLoading.has(d.id)).slice(0,18);
  if(!pending.length)return false;

  await Promise.allSettled(pending.map(loadMedia));

  if(rerender){
    if(revealDialog.open&&ui.reveal)renderReveal();
    else render();
  }
  return true;
}

function preferredWikiLang(){
  const lang=String(navigator.language||"en").toLowerCase().split("-")[0];
  return /^[a-z]{2,3}$/.test(lang)?lang:"en";
}

async function loadScience(definition){
  if(!definition||ui.science.has(definition.id)||ui.scienceLoading.has(definition.id))return ui.science.get(definition.id)||null;
  ui.scienceLoading.add(definition.id);
  try{
    const result=await api("/api/science?definitionId="+encodeURIComponent(definition.id)+"&lang="+encodeURIComponent(preferredWikiLang()));
    ui.science.set(definition.id,result.science||false);
    return result.science||null;
  }catch{
    ui.science.set(definition.id,false);
    return null;
  }finally{
    ui.scienceLoading.delete(definition.id);
  }
}

function sourceButton(url,label,kind){
  if(!url)return "";
  return '<a class="source-button '+esc(kind||"")+'" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>';
}

function imageMarkup(definition){
  const media=getMedia(definition);
  if(media&&media.imageUrl){
    return '<img src="'+esc(media.imageUrl)+'" alt="'+esc(definition.commonName)+'" loading="lazy" draggable="false">';
  }
  const initials=(definition.commonName||definition.scientificName||"?").split(/\s+/).slice(0,2).map(x=>x[0]).join("");
  return '<div class="art-fallback"><span>'+esc(definition.icon||"◌")+'</span><b>'+esc(initials)+'</b></div>';
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
        '<div class="card-title-row"><div><h3>'+esc(d.commonName)+'</h3><em>'+esc(d.scientificName)+'</em></div><span class="favorite">☆</span></div>'+
        '<p>'+esc(d.summary||"")+'</p>'+
        '<div class="card-bottom">'+
          '<span class="edition '+editionClass(card.edition||"")+'">'+esc(card.edition||d.rank||d.kind)+'</span>'+
          '<b>'+((card.serial||card.serial===0)?serial(card):esc(d.rank||""))+'</b>'+
        '</div>'+
        (media&&media.creator?'<small class="photo-credit">'+esc(media.creator)+' · '+esc(media.license||"")+'</small>':"")+
      '</div>'+
    '</div>'+
    (showSell&&card.id?'<div class="card-market-actions"><button class="sell-button" data-sell="'+esc(card.id)+'">Sell</button><button class="auction-button" data-auction-card="'+esc(card.id)+'">Auction</button></div>':"")+
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
  }
}

function render(){
  if(!ui.state)return;
  updateChrome();
  if(ui.view==="packs")renderPacks();
  if(ui.view==="collection")renderCollection();
  if(ui.view==="tree")renderTree();
  if(ui.view==="market")renderMarket();
  if(ui.view==="knowledge")renderKnowledge();
  if(ui.view==="profile")renderProfile();
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
        '<div class="pack-rules"><span>6 cards</span><span>1 pack / 8 min</span><span>8 stored max</span><span>'+Math.round(config.holoRate*1000)/10+'% Holo</span><span>Audit #'+formatNumber(ui.state.audit?.count||0)+'</span></div>'+
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
          '<span>'+(user.packs>=user.maxPacks?"Storage full":"Next in "+formatTimer(user.nextPackInMs))+'</span>'+
        '</div>'+
      '</div>'+
      '<aside class="origin-tease"><div class="origin-orbit"></div><span class="eyebrow">THE ORIGIN</span><h2>LUCA</h2><b>UNKNOWN · #1 / 1</b><p>One card. One owner. Eligible from the very first pack.</p></aside>'+
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
  document.querySelectorAll("[data-auction-card]").forEach(button=>button.onclick=event=>{event.stopPropagation();auctionCard(button.dataset.auctionCard)});
  warmMedia(filtered.slice(0,24).map(c=>c.definition));
}

function remainingTime(timestamp){
  const ms=Math.max(0,Number(timestamp)-Date.now());
  if(ms<60*1000)return "<1m";
  if(ms<60*60*1000)return Math.ceil(ms/(60*1000))+"m";
  if(ms<24*60*60*1000)return Math.ceil(ms/(60*60*1000))+"h";
  return Math.ceil(ms/(24*60*60*1000))+"d";
}

function renderMarket(){
  const listings=ui.state.market||[];
  const auctions=ui.state.auctions||[];
  const fixed=ui.marketMode==="fixed";
  const visible=fixed?listings:auctions;

  main.innerHTML=
    '<section class="market-page">'+
      '<div class="page-hero compact-hero"><span class="eyebrow">SECONDARY MARKET</span><h1>Market</h1><p>Collect editions, serials and finishes. Fixed sales and auctions settle in Coins with a 5% economy sink.</p></div>'+
      '<div class="market-toolbar"><span>'+(fixed?listings.length:auctions.length)+' active '+(fixed?"listings":"auctions")+'</span><div class="market-mode">'+
        '<button data-market-mode="fixed" class="filter-chip '+(fixed?"active":"")+'">Buy now</button>'+
        '<button data-market-mode="auction" class="filter-chip '+(!fixed?"active":"")+'">Auctions</button>'+
      '</div></div>'+
      '<div class="market-grid">'+(
        visible.length
          ? (fixed
              ? listings.map(listing=>
                  '<article class="market-item">'+cardHtml(listing.card,{compact:true})+
                  '<div class="market-meta"><div><small>ASK</small><strong>◆ '+formatNumber(listing.price)+'</strong><span>'+esc(listing.sellerId)+'</span></div>'+(listing.sellerId===ui.state.user.id?'<button class="secondary-market-button" data-cancel-listing="'+esc(listing.id)+'">Cancel</button>':'<button data-buy="'+esc(listing.id)+'">Buy</button>')+'</div></article>'
                ).join("")
              : auctions.map(auction=>{
                  const current=auction.highestBid==null?auction.startingPrice:auction.highestBid;
                  return '<article class="market-item auction-item">'+cardHtml(auction.card,{compact:true})+
                    '<div class="auction-timer">'+remainingTime(auction.endsAt)+' left</div>'+
                    '<div class="market-meta"><div><small>'+(auction.highestBid==null?"STARTING BID":"CURRENT BID")+'</small><strong>◆ '+formatNumber(current)+'</strong><span>'+esc(auction.sellerId)+'</span></div>'+(auction.sellerId===ui.state.user.id?(auction.highestBid==null?'<button class="secondary-market-button" data-cancel-auction="'+esc(auction.id)+'">Cancel</button>':'<button disabled>Your auction</button>'):'<button data-bid="'+esc(auction.id)+'" data-min-bid="'+(current+(auction.highestBid==null?0:1))+'">Bid</button>')+'</div></article>';
                }).join(""))
          : '<div class="empty-state">No active '+(fixed?"listings":"auctions")+'.</div>'
      )+'</div>'+
    '</section>';

  document.querySelectorAll("[data-market-mode]").forEach(button=>button.onclick=()=>{ui.marketMode=button.dataset.marketMode;renderMarket();wireCommon()});
  document.querySelectorAll("[data-buy]").forEach(button=>button.onclick=event=>{event.stopPropagation();buy(button.dataset.buy)});
  document.querySelectorAll("[data-bid]").forEach(button=>button.onclick=event=>{event.stopPropagation();bidAuction(button.dataset.bid,Number(button.dataset.minBid))});
  document.querySelectorAll("[data-cancel-listing]").forEach(button=>button.onclick=event=>{event.stopPropagation();cancelFixedListing(button.dataset.cancelListing)});
  document.querySelectorAll("[data-cancel-auction]").forEach(button=>button.onclick=event=>{event.stopPropagation();cancelUserAuction(button.dataset.cancelAuction)});
  warmMedia(visible.slice(0,18).map(x=>x.card.definition));
}

function treeBranch(id,nodes,owned){
  const node=nodes.find(x=>x.id===id);
  if(!node)return "";
  const children=nodes.filter(x=>x.parentId===id);
  return '<div class="tree-branch"><button class="tree-node '+(owned.has(id)?"owned":"")+' '+(node.rarity==="MYTHIC"?"major":"")+'" data-definition="'+esc(node.id)+'">'+
    '<span class="tree-icon">'+esc(node.icon||"◌")+'</span><div><b>'+esc(node.commonName)+'</b><small>'+esc(node.rank||node.kind)+' · '+esc((RARITY[node.rarity]||{}).label||node.rarity)+'</small></div>'+
    (owned.has(id)?'<i>✓</i>':'')+'</button>'+
    (children.length?'<div class="tree-children">'+children.map(c=>treeBranch(c.id,nodes,owned)).join("")+'</div>':"")+
  '</div>';
}

function renderTree(){
  const nodes=ui.state.catalog.filter(d=>d.kind!=="origin");
  const owned=new Set(ui.state.inventory.map(c=>c.definitionId));
  main.innerHTML=
    '<section class="tree-page">'+
      '<div class="page-hero compact-hero"><span class="eyebrow">PHYLOGENETIC ALBUM</span><h1>Tree of Life</h1><p>Collect the organisms and the branches connecting them. The deeper the node, the more foundational — and generally rarer — its card.</p></div>'+
      '<div class="tree-legend"><span><i class="legend-dot owned"></i>Owned taxon</span><span><i class="legend-dot"></i>Known node</span><span class="legend-origin">UNKNOWN = unique origin</span></div>'+
      '<div class="tree-canvas">'+
        '<div class="luca-node"><span>✺</span><div><small>UNKNOWN</small><b>LUCA</b><em>#1 / 1</em></div></div>'+
        '<div class="root-line"></div>'+
        '<div class="tree-roots">'+["bacteria","archaea","eukaryota"].map(id=>treeBranch(id,nodes,owned)).join("")+'</div>'+
      '</div>'+
    '</section>';
  document.querySelectorAll("[data-definition]").forEach(node=>node.onclick=()=>openDefinition(node.dataset.definition));

}

function achievementIcon(id){
  const map={
    "first-discovery":"✦",
    "field-naturalist":"☘",
    "branch-collector":"⌘",
    "holographic":"◇",
    "wild-archive":"◈",
    "deep-time":"◌",
    "the-origin":"✺"
  };
  return map[id]||"•";
}

function renderProfile(){
  const p=ui.state.profile;
  const rarest=[...ui.state.inventory]
    .sort((a,b)=>{
      const order=["COMMON","UNCOMMON","RARE","SUPER_RARE","ULTRA_RARE","LEGENDARY","MYTHIC","UNKNOWN"];
      return order.indexOf(b.rarity)-order.indexOf(a.rarity);
    })
    .slice(0,4);

  main.innerHTML=
    '<section class="profile-page">'+
      '<div class="profile-hero">'+
        '<div class="profile-avatar">E</div>'+
        '<div><span class="eyebrow">FIELD RESEARCHER</span><h1>Explorer</h1><p>Collector, taxonomist and keeper of a growing Tree of Life archive.</p></div>'+
        '<div class="profile-level"><small>KNOWLEDGE</small><b>'+formatNumber(p.knowledge.points)+'</b><span>'+p.knowledge.correctAnswers+' correct · '+Math.round(p.knowledge.accuracy*100)+'% accuracy · '+formatNumber(ui.state.audit?.count||0)+' audited packs</span></div>'+
      '</div>'+
      '<div class="profile-stats">'+
        '<article><span>Total cards</span><b>'+formatNumber(p.totalCards)+'</b></article>'+
        '<article><span>Species</span><b>'+formatNumber(p.uniqueSpecies)+'</b></article>'+
        '<article><span>Taxa</span><b>'+formatNumber(p.uniqueTaxa)+'</b></article>'+
        '<article><span>Wild</span><b>'+formatNumber(p.wild)+'</b></article>'+
        '<article><span>Holo</span><b>'+formatNumber(p.holo)+'</b></article>'+
        '<article><span>Fossils</span><b>'+formatNumber(p.fossil)+'</b></article>'+
      '</div>'+
      '<div class="section-head"><div><span class="eyebrow">ACHIEVEMENTS</span><h2>Milestones</h2></div></div>'+
      '<div class="achievement-grid">'+p.achievements.map(a=>
        '<article class="achievement '+(a.unlocked?"unlocked":"locked")+'"><span>'+achievementIcon(a.id)+'</span><div><b>'+esc(a.name)+'</b><p>'+esc(a.description)+'</p></div><i>'+(a.unlocked?"UNLOCKED":"LOCKED")+'</i></article>'
      ).join("")+'</div>'+
      '<div class="section-head"><div><span class="eyebrow">SHOWCASE</span><h2>Rarest cards</h2></div></div>'+
      '<div class="card-grid profile-showcase">'+(rarest.length?rarest.map(card=>cardHtml(card,{compact:true})).join(""):'<div class="empty-state">Open packs to build a showcase.</div>')+'</div>'+
    '</section>';
  warmMedia(rarest.map(c=>c.definition));
}

function renderKnowledge(){
  const stats=ui.state.profile.knowledge;
  const q=ui.knowledgeQuestion;
  const result=ui.knowledgeResult;

  main.innerHTML=
    '<section class="knowledge-page">'+
      '<div class="knowledge-hero">'+
        '<div><span class="eyebrow">KNOWLEDGE LAB</span><h1>Learn the tree by playing.</h1><p>Questions are generated from LifeCards’ current taxonomy snapshot. Knowledge progression never changes card power or drop odds.</p></div>'+
        '<div class="knowledge-score"><small>KNOWLEDGE POINTS</small><b>'+formatNumber(stats.points)+'</b><span>Streak '+stats.streak+' · Best '+stats.bestStreak+'</span></div>'+
      '</div>'+
      '<div class="knowledge-board">'+
        (!q
          ? '<div class="quiz-empty"><span class="quiz-symbol">⌘</span><h2>Ready for a field question?</h2><p>Taxonomy, ranks and relationships from the current Tree of Life snapshot.</p><button id="newQuestion" class="primary-cta">Start question</button></div>'
          : '<div class="quiz-card">'+
              '<div class="quiz-top"><span>QUESTION</span><b>'+esc(q.prompt)+'</b></div>'+
              '<div class="quiz-options">'+q.options.map(option=>
                '<button data-option="'+esc(option)+'" '+(result?"disabled":"")+' class="'+(result&&option===result.correctOption?"correct":"")+'">'+esc(option)+'</button>'
              ).join("")+'</div>'+
              (result
                ? '<div class="quiz-result '+(result.correct?"right":"wrong")+'"><b>'+(result.correct?"Correct":"Not this time")+'</b><p>'+esc(result.explanation||"")+'</p><span>+'+result.pointsEarned+' knowledge · +'+result.coinReward+' coins</span><button id="nextQuestion">Next question →</button></div>'
                : '<div class="quiz-foot">Choose one answer. The explanation appears after validation.</div>')+
            '</div>')+
      '</div>'+
      '<div class="knowledge-stats">'+
        '<div><span>Correct</span><b>'+stats.correctAnswers+'</b></div>'+
        '<div><span>Answered</span><b>'+stats.totalAnswers+'</b></div>'+
        '<div><span>Accuracy</span><b>'+Math.round(stats.accuracy*100)+'%</b></div>'+
        '<div><span>Current streak</span><b>'+stats.streak+'</b></div>'+
      '</div>'+
    '</section>';

  document.getElementById("newQuestion")?.addEventListener("click",requestKnowledgeQuestion);
  document.getElementById("nextQuestion")?.addEventListener("click",requestKnowledgeQuestion);
  document.querySelectorAll("[data-option]").forEach(button=>{
    button.onclick=()=>answerKnowledge(button.dataset.option);
  });
}

async function requestKnowledgeQuestion(){
  if(ui.knowledgeLoading)return;
  ui.knowledgeLoading=true;
  try{
    const response=await api("/api/knowledge/question",{method:"POST",body:"{}"});
    ui.knowledgeQuestion=response.question;
    ui.knowledgeResult=null;
    renderKnowledge();
  }catch(error){flash(error.message)}
  finally{ui.knowledgeLoading=false}
}

async function answerKnowledge(option){
  if(!ui.knowledgeQuestion||ui.knowledgeResult||ui.knowledgeLoading)return;
  ui.knowledgeLoading=true;
  try{
    const response=await api("/api/knowledge/answer",{
      method:"POST",
      body:JSON.stringify({questionId:ui.knowledgeQuestion.id,option})
    });
    ui.knowledgeResult=response.result;
    await refresh(false);
    renderKnowledge();
  }catch(error){flash(error.message)}
  finally{ui.knowledgeLoading=false}
}

function renderCodexResults(){
  const localGrid=document.getElementById("codexLocalGrid");
  const externalGrid=document.getElementById("externalTaxaResults");
  if(!localGrid||!externalGrid)return;

  const q=ui.codexQuery.trim().toLowerCase();
  const local=ui.state.catalog.filter(d=>{
    if(!q)return true;
    return [d.commonName,d.scientificName,d.rarity,d.rank,d.kind]
      .some(value=>String(value||"").toLowerCase().includes(q));
  });

  localGrid.innerHTML=local.length
    ? local.map(d=>
        '<article class="codex-row" data-definition="'+esc(d.id)+'"><div class="codex-thumb">'+imageMarkup(d)+'</div><div class="codex-copy"><span class="codex-type">COLLECTIBLE · '+esc(d.kind)+' · '+esc(d.rarity)+'</span><h3>'+esc(d.commonName)+'</h3><em>'+esc(d.scientificName)+'</em><p>'+esc(d.summary||"")+'</p></div><span class="codex-arrow">→</span></article>'
      ).join("")
    : '<div class="empty-state">No collectible card matches this search yet.</div>';

  document.querySelectorAll("#codexLocalGrid [data-definition]").forEach(row=>row.onclick=()=>openDefinition(row.dataset.definition));
  warmMedia(local.slice(0,24),{rerender:false}).then(changed=>{
    if(changed&&ui.view==="codex")renderCodexResults();
  }).catch(()=>{});

  if(q.length<2){
    externalGrid.innerHTML='<div class="taxonomy-hint">Type at least 2 characters to search the full NCBI taxonomy.</div>';
    return;
  }

  if(ui.taxonomySearchLoading){
    externalGrid.innerHTML='<div class="taxonomy-hint loading">Searching NCBI Taxonomy…</div>';
    return;
  }

  externalGrid.innerHTML=ui.externalTaxa.length
    ? ui.externalTaxa.map(item=>
        '<article class="external-taxon"><div><span>NCBI TAXONOMY · '+esc(item.rank||"unranked")+'</span><h3>'+esc(item.scientificName||item.commonName||("Taxon "+item.taxId))+'</h3><p>Taxid '+esc(item.taxId)+(item.commonName?' · '+esc(item.commonName):"")+'</p></div><div class="external-actions">'+sourceButton(item.ncbiUrl,"NCBI","ncbi")+sourceButton(item.lifemapUrl,"Lifemap","lifemap")+'</div></article>'
      ).join("")
    : '<div class="taxonomy-hint">No NCBI taxonomy result for this query.</div>';
}

async function runTaxonomySearch(query){
  const expected=query.trim();
  if(expected.length<2){
    ui.externalTaxa=[];
    ui.taxonomySearchLoading=false;
    renderCodexResults();
    return;
  }

  ui.taxonomySearchLoading=true;
  renderCodexResults();
  try{
    const response=await api("/api/taxonomy/search?q="+encodeURIComponent(expected));
    if(ui.codexQuery.trim()!==expected)return;
    ui.externalTaxa=response.results||[];
  }catch(error){
    if(ui.codexQuery.trim()===expected){
      ui.externalTaxa=[];
      flash("NCBI search unavailable: "+error.message);
    }
  }finally{
    if(ui.codexQuery.trim()===expected){
      ui.taxonomySearchLoading=false;
      renderCodexResults();
    }
  }
}

function renderCodex(){
  main.innerHTML=
    '<section class="codex-page">'+
      '<div class="page-hero compact-hero"><span class="eyebrow">LIVING ENCYCLOPEDIA</span><h1>Codex</h1><p>Collectible cards are editorially curated. Search beyond the card pool to explore the full NCBI taxonomy and jump directly into Lifemap.</p></div>'+
      '<label class="search-box codex-search"><span>⌕</span><input id="codexSearch" placeholder="Search lion, Panthera, Mollusca..." value="'+esc(ui.codexQuery)+'"></label>'+
      '<div class="codex-section-head"><span class="eyebrow">COLLECTIBLE CATALOG</span><small>'+ui.state.catalog.length+' curated definitions</small></div>'+
      '<div id="codexLocalGrid" class="codex-grid"></div>'+
      '<div class="codex-section-head external"><span class="eyebrow">GLOBAL TAXONOMY</span><small>NCBI → Lifemap</small></div>'+
      '<div id="externalTaxaResults" class="external-taxa-grid"></div>'+
    '</section>';

  renderCodexResults();

  const search=document.getElementById("codexSearch");
  search?.addEventListener("input",event=>{
    ui.codexQuery=event.target.value;
    ui.externalTaxa=[];
    renderCodexResults();
    clearTimeout(ui.taxonomySearchTimer);
    ui.taxonomySearchTimer=setTimeout(()=>runTaxonomySearch(ui.codexQuery),450);
  });
}


function wireCommon(){
  document.querySelectorAll("[data-view]").forEach(button=>{
    button.onclick=()=>{ui.view=button.dataset.view;render()};
  });
  document.querySelectorAll("[data-card-id]").forEach(card=>{
    card.onclick=()=>openOwnedCard(card.dataset.cardId);
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
    ui.reveal={cards:result.cards,originCard:result.originCard,audit:result.audit||null};
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
      (ui.reveal.audit?'<div class="audit-stamp"><span>PACK PROVENANCE</span><code>'+esc(ui.reveal.audit.auditHash.slice(0,16))+'…</code></div>':"")+
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

function openDefinition(id){
  const d=ui.state.catalog.find(x=>x.id===id);
  if(d)openCardModal(d,null);
}

function renderCardModal(definition,card,science){
  const media=getMedia(definition);
  const wiki=science&&science.wikipedia&&science.wikipedia.available?science.wikipedia:null;
  const ncbi=science&&science.ncbi&&science.ncbi.available?science.ncbi:null;
  const overview=wiki&&wiki.extract?wiki.extract:(definition.summary||"Scientific enrichment is loading.");
  const taxRank=ncbi&&ncbi.rank?ncbi.rank:(definition.rank||definition.temporalStatus||"—");
  const taxId=ncbi&&ncbi.taxId?ncbi.taxId:"—";

  cardModalContent.innerHTML=
    '<div class="detail-layout">'+
      '<div class="detail-card">'+(card?cardHtml(card,{interactive:false}):definitionPreview(definition))+'</div>'+
      '<div class="detail-copy">'+
        '<span class="eyebrow">'+esc(definition.kind)+' · '+esc(definition.rarity)+'</span>'+
        '<h2>'+esc(definition.commonName)+'</h2>'+
        '<em>'+esc(definition.scientificName)+'</em>'+
        '<p class="detail-overview">'+esc(overview)+'</p>'+
        '<dl>'+
          '<div><dt>Type</dt><dd>'+esc(definition.kind)+'</dd></div>'+
          '<div><dt>Taxonomic rank</dt><dd>'+esc(taxRank)+'</dd></div>'+
          '<div><dt>NCBI Taxonomy ID</dt><dd>'+esc(taxId)+'</dd></div>'+
          '<div><dt>Card parent</dt><dd>'+esc(definition.parentId||"Origin")+'</dd></div>'+
          (definition.conservation?'<div><dt>Conservation</dt><dd>'+esc(definition.conservation)+'</dd></div>':"")+
          (card?'<div><dt>Edition</dt><dd>'+esc(card.edition)+'</dd></div>':"")+
        '</dl>'+
        '<div class="source-actions">'+
          sourceButton(wiki&&wiki.pageUrl,"Wikipedia","wikipedia")+
          sourceButton(ncbi&&ncbi.ncbiUrl,"NCBI Taxonomy","ncbi")+
          sourceButton(ncbi&&ncbi.lifemapUrl,"Open in Lifemap","lifemap")+
          (media&&media.originalUrl?sourceButton(media.originalUrl,"Image source","commons"):"")+
        '</div>'+
        '<div class="source-note">'+
          '<b>Scientific provenance</b>'+
          '<span>'+(science?'Wikipedia overview + NCBI taxonomy. Lifemap opens externally using the NCBI taxid.':'Loading live sources…')+'</span>'+
        '</div>'+
      '</div>'+
    '</div>';
}

function openCardModal(definition,card){
  renderCardModal(definition,card,ui.science.get(definition.id)||null);
  cardModal.showModal();
  Promise.allSettled([loadMedia(definition),loadScience(definition)]).then(()=>{
    if(cardModal.open)renderCardModal(definition,card,ui.science.get(definition.id)||null);
  });
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

async function cancelFixedListing(listingId){
  if(!window.confirm("Cancel this fixed-price listing?"))return;
  try{
    await api("/api/market/cancel-listing",{method:"POST",body:JSON.stringify({listingId})});
    flash("Listing cancelled");
    await refresh();
  }catch(error){flash(error.message)}
}

async function cancelUserAuction(auctionId){
  if(!window.confirm("Cancel this auction? Auctions with bids cannot be cancelled."))return;
  try{
    await api("/api/market/cancel-auction",{method:"POST",body:JSON.stringify({auctionId})});
    flash("Auction cancelled");
    await refresh();
  }catch(error){flash(error.message)}
}

async function auctionCard(cardId){
  const startRaw=window.prompt("Starting bid in Coins:", "100");
  if(startRaw==null)return;
  const startingPrice=Number(startRaw);
  if(!Number.isSafeInteger(startingPrice)||startingPrice<=0)return flash("Enter a whole positive Coin amount");

  const durationRaw=window.prompt("Auction duration in minutes (5 to 10080):", "60");
  if(durationRaw==null)return;
  const durationMinutes=Number(durationRaw);
  if(!Number.isFinite(durationMinutes)||durationMinutes<5)return flash("Auction duration must be at least 5 minutes");

  try{
    await api("/api/market/auction",{
      method:"POST",
      body:JSON.stringify({cardId,startingPrice,durationMinutes})
    });
    flash("Auction created");
    await refresh();
  }catch(error){flash(error.message)}
}

async function bidAuction(auctionId,minimum){
  const raw=window.prompt("Your bid in Coins:",String(minimum));
  if(raw==null)return;
  const amount=Number(raw);
  if(!Number.isSafeInteger(amount)||amount<minimum)return flash("Bid is below the minimum");
  try{
    await api("/api/market/bid",{
      method:"POST",
      body:JSON.stringify({auctionId,amount})
    });
    flash("Bid placed");
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
  updateChrome();
  if(shouldRender)render();
}

document.getElementById("closeCard").onclick=()=>cardModal.close();
revealDialog.addEventListener("click",event=>{if(event.target===revealDialog)finishReveal()});
cardModal.addEventListener("click",event=>{if(event.target===cardModal)cardModal.close()});

setInterval(()=>{
  if(!ui.state)return;
  if(ui.view==="packs"&&!revealDialog.open)refresh().catch(()=>{});
},10000);

refresh().catch(error=>{main.innerHTML='<div class="fatal">'+esc(error.message)+'</div>'});
