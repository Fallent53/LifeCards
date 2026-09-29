export const rarityOrder = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "SUPER_RARE",
  "ULTRA_RARE",
  "LEGENDARY",
  "MYTHIC",
  "UNKNOWN",
];

/**
 * Prototype catalog.
 * Scientific population figures in production MUST come from a versioned, cited import.
 * `editionCap` values below are gameplay seed values for this vertical slice, not claims
 * about current wild populations unless a source is attached later by the ingestion layer.
 */
export const catalog = [
  { id: "bacteria", kind: "taxon", scientificName: "Bacteria", commonName: "Bacteria", rank: "domain", parentId: "cellular-life", rarity: "MYTHIC", selectionWeight: 0.28, editionCap: 250, icon: "🦠", summary: "One of the deepest major lineages of cellular life." },
  { id: "archaea", kind: "taxon", scientificName: "Archaea", commonName: "Archaea", rank: "domain", parentId: "cellular-life", rarity: "MYTHIC", selectionWeight: 0.28, editionCap: 250, icon: "◉", summary: "A major lineage of cellular organisms distinct from Bacteria and Eukaryota." },
  { id: "eukaryota", kind: "taxon", scientificName: "Eukaryota", commonName: "Eukaryotes", rank: "domain", parentId: "cellular-life", rarity: "MYTHIC", selectionWeight: 0.28, editionCap: 250, icon: "◎", summary: "Organisms whose cells contain a nucleus and other membrane-bound structures." },
  { id: "animalia", kind: "taxon", scientificName: "Animalia", commonName: "Animals", rank: "kingdom", parentId: "eukaryota", rarity: "MYTHIC", selectionWeight: 0.62, editionCap: 1000, icon: "✦", summary: "The animal kingdom — one of the central collectible branches in LifeCards." },
  { id: "mollusca", kind: "taxon", scientificName: "Mollusca", commonName: "Molluscs", rank: "phylum", parentId: "animalia", rarity: "LEGENDARY", selectionWeight: 0.8, editionCap: 5000, icon: "🐚", summary: "A diverse phylum including snails, bivalves, octopuses and squids." },
  { id: "arthropoda", kind: "taxon", scientificName: "Arthropoda", commonName: "Arthropods", rank: "phylum", parentId: "animalia", rarity: "LEGENDARY", selectionWeight: 0.8, editionCap: 5000, icon: "🪲", summary: "The enormous phylum containing insects, arachnids, crustaceans and relatives." },
  { id: "chordata", kind: "taxon", scientificName: "Chordata", commonName: "Chordates", rank: "phylum", parentId: "animalia", rarity: "LEGENDARY", selectionWeight: 0.8, editionCap: 5000, icon: "🧬", summary: "The phylum containing vertebrates and their closest chordate relatives." },
  { id: "mammalia", kind: "taxon", scientificName: "Mammalia", commonName: "Mammals", rank: "class", parentId: "chordata", rarity: "ULTRA_RARE", selectionWeight: 1, editionCap: 10000, icon: "🐾", summary: "Warm-blooded vertebrates characterized by mammary glands and hair." },
  { id: "tetrapoda", kind: "taxon", scientificName: "Tetrapoda", commonName: "Tetrapods", rank: "clade", parentId: "chordata", rarity: "ULTRA_RARE", selectionWeight: 0.9, editionCap: 10000, icon: "◈", summary: "The vertebrate lineage containing amphibians, reptiles, birds and mammals." },
  { id: "sauropsida", kind: "taxon", scientificName: "Sauropsida", commonName: "Sauropsids", rank: "clade", parentId: "tetrapoda", rarity: "SUPER_RARE", selectionWeight: 0.9, editionCap: 18000, icon: "🦎", summary: "The amniote lineage containing reptiles and birds." },
  { id: "dinosauria", kind: "taxon", scientificName: "Dinosauria", commonName: "Dinosaurs", rank: "clade", parentId: "sauropsida", rarity: "SUPER_RARE", selectionWeight: 0.8, editionCap: 18000, icon: "🦖", summary: "The dinosaur lineage, including the living avian branch." },
  { id: "aves", kind: "taxon", scientificName: "Aves", commonName: "Birds", rank: "class", parentId: "dinosauria", rarity: "ULTRA_RARE", selectionWeight: 1, editionCap: 10000, icon: "🪶", summary: "Living avian dinosaurs." },
  { id: "carnivora", kind: "taxon", scientificName: "Carnivora", commonName: "Carnivorans", rank: "order", parentId: "mammalia", rarity: "SUPER_RARE", selectionWeight: 1, editionCap: 25000, icon: "◫", summary: "The mammalian order containing cats, dogs, bears, seals and relatives." },
  { id: "felidae", kind: "taxon", scientificName: "Felidae", commonName: "Cats", rank: "family", parentId: "carnivora", rarity: "RARE", selectionWeight: 1, editionCap: 50000, icon: "🐈", summary: "The cat family." },
  { id: "canidae", kind: "taxon", scientificName: "Canidae", commonName: "Dogs", rank: "family", parentId: "carnivora", rarity: "RARE", selectionWeight: 1, editionCap: 50000, icon: "🐕", summary: "The dog family." },
  { id: "panthera", kind: "taxon", scientificName: "Panthera", commonName: "Panthera", rank: "genus", parentId: "felidae", rarity: "UNCOMMON", selectionWeight: 1, editionCap: 100000, icon: "◐", summary: "The genus containing lions, tigers, jaguars, leopards and snow leopards." },
  { id: "panthera-leo", kind: "species", scientificName: "Panthera leo", commonName: "Lion", parentId: "panthera", rarity: "RARE", selectionWeight: 1, temporalStatus: "extant", editionCap: 23000, icon: "🦁", conservation: "VU", mediaQuery: "Panthera leo", summary: "A large social cat native to parts of sub-Saharan Africa and a remnant population in India." },
  { id: "panthera-tigris", kind: "species", scientificName: "Panthera tigris", commonName: "Tiger", parentId: "panthera", rarity: "RARE", selectionWeight: 1, temporalStatus: "extant", editionCap: 5500, icon: "🐅", conservation: "EN", mediaQuery: "Panthera tigris", summary: "The largest living cat species, distributed in fragmented populations across Asia." },
  { id: "canis-lupus", kind: "species", scientificName: "Canis lupus", commonName: "Grey wolf", parentId: "canidae", rarity: "UNCOMMON", selectionWeight: 1, temporalStatus: "extant", editionCap: 200000, icon: "🐺", conservation: "LC", mediaQuery: "Canis lupus", summary: "A highly adaptable social canid with a broad Holarctic distribution." },
  { id: "columba-livia", kind: "species", scientificName: "Columba livia", commonName: "Rock pigeon", parentId: "aves", rarity: "COMMON", selectionWeight: 1, temporalStatus: "extant", editionCap: 125000, icon: "🐦", conservation: "LC", mediaQuery: "Columba livia", summary: "A widespread bird and living dinosaur lineage member." },
  { id: "apis-mellifera", kind: "species", scientificName: "Apis mellifera", commonName: "Western honey bee", parentId: "arthropoda", rarity: "COMMON", selectionWeight: 1, temporalStatus: "extant", editionCap: 500000, icon: "🐝", conservation: "NE", mediaQuery: "Apis mellifera", summary: "A social bee with enormous ecological and agricultural importance." },
  { id: "octopus-vulgaris", kind: "species", scientificName: "Octopus vulgaris", commonName: "Common octopus", parentId: "mollusca", rarity: "UNCOMMON", selectionWeight: 1, temporalStatus: "extant", editionCap: 80000, icon: "🐙", conservation: "NE", mediaQuery: "Octopus vulgaris", summary: "An intelligent cephalopod associated with rocky and coastal marine habitats." },
  { id: "ambystoma-mexicanum", kind: "species", scientificName: "Ambystoma mexicanum", commonName: "Axolotl", parentId: "tetrapoda", rarity: "ULTRA_RARE", selectionWeight: 1, temporalStatus: "extant", editionCap: 1000, icon: "🦎", conservation: "CR", mediaQuery: "Ambystoma mexicanum", summary: "A critically endangered neotenic salamander native to the Xochimilco system in Mexico." },
  { id: "tyrannosaurus-rex", kind: "species", scientificName: "Tyrannosaurus rex", commonName: "Tyrannosaurus rex", parentId: "dinosauria", rarity: "LEGENDARY", selectionWeight: 1, temporalStatus: "extinct", editionCap: 4000, icon: "🦖", conservation: "EX", mediaQuery: "Tyrannosaurus rex reconstruction", summary: "A large theropod dinosaur from the Late Cretaceous of western North America." },
  { id: "archaeopteryx-lithographica", kind: "species", scientificName: "Archaeopteryx lithographica", commonName: "Archaeopteryx", parentId: "dinosauria", rarity: "LEGENDARY", selectionWeight: 1, temporalStatus: "extinct", editionCap: 1200, icon: "🪶", conservation: "EX", mediaQuery: "Archaeopteryx lithographica fossil", summary: "A famous Late Jurassic avialan known from exceptionally preserved fossils." },
  { id: "luca", kind: "origin", scientificName: "LUCA", commonName: "Last Universal Common Ancestor", parentId: null, rarity: "UNKNOWN", selectionWeight: 0, editionCap: 1, icon: "✺", summary: "The most recent common ancestor of all current cellular life. LifeCards' unique Origin card.", droppable: false },
];

export const byId = new Map(catalog.map((entry) => [entry.id, entry]));

export function getDroppableDefinitions() {
  return catalog.filter((entry) => entry.droppable !== false && entry.kind !== "origin");
}

export function lineageFor(id) {
  const lineage = [];
  let current = byId.get(id);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    lineage.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return lineage;
}

export function publicCatalog() {
  return catalog.map(({ selectionWeight, ...entry }) => ({ ...entry }));
}
