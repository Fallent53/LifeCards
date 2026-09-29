import { getKnowledge } from "../src/knowledge.mjs";

const query=process.argv.slice(2).join(" ").trim()||"Mammalia";
console.log("LifeCards media diagnostic");
console.log("Query:",query);
console.log("");

const result=await getKnowledge(query,{lang:"en"});

if(!result){
  console.error("No knowledge result.");
  process.exit(2);
}

console.log("Wikipedia");
console.log("  title      :",result.wikipedia?.title||"—");
console.log("  page       :",result.wikipedia?.pageUrl||"—");
console.log("  page image :",result.wikipedia?.pageImage||"—");
console.log("  thumbnail  :",result.wikipedia?.thumbnailUrl||"—");
console.log("");

console.log("Wikidata");
console.log("  id         :",result.wikidata?.id||"—");
console.log("  taxon name :",result.wikidata?.taxonName||"—");
console.log("  image file :",result.wikidata?.imageFile||"—");
console.log("  NCBI id    :",result.wikidata?.ncbiTaxId||"—");
console.log("");

console.log("Resolved media");
console.log("  resolver   :",result.media?.resolver||"—");
console.log("  confidence :",result.media?.confidence||"—");
console.log("  source     :",result.media?.source||"—");
console.log("  image      :",result.media?.imageUrl||"—");
console.log("  original   :",result.media?.originalUrl||"—");
console.log("  creator    :",result.media?.creator||"—");
console.log("  license    :",result.media?.license||"—");
console.log("  license URL:",result.media?.licenseUrl||"—");
console.log("  metadata   :",result.media?.metadataPending?"pending":"resolved");
console.log("");

if(!result.media?.imageUrl){
  console.error("FAIL: no image resolved.");
  process.exitCode=1;
}else if(result.media.metadataPending){
  console.log("PARTIAL: image resolved, attribution metadata still needs resolution.");
}else{
  console.log("OK: image + attribution metadata resolved.");
}
