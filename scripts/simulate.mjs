import { generatePackBlueprint, cryptoRng, DEFAULT_CONFIG } from "../src/game-engine.mjs";
import { byId } from "../src/catalog.mjs";
const packs=Number(process.argv[2]||20000),rng=cryptoRng();let holo=0,origin=0,total=0;const counts=new Map();
for(let i=0;i<packs;i++){const p=generatePackBlueprint({rng,config:DEFAULT_CONFIG});if(p.originTriggered)origin++;for(const c of p.cards){total++;if(c.finish==="HOLO")holo++;counts.set(c.definitionId,(counts.get(c.definitionId)||0)+1)}}
console.log("packs:",packs);console.log("cards:",total);console.log("holo:",holo,("("+(holo/total*100).toFixed(3)+"%)"));console.log("origin hits:",origin);
console.log("\nTop definitions:");[...counts].sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([id,count])=>console.log(String(count).padStart(8),byId.get(id)?.commonName||id));
