import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_TAXONOMY_DB = "/tmp/lifecards-no-full-taxonomy.sqlite";

const { definitionFromTaxon } = await import("../src/definitions.mjs");
const { generatePackBlueprint } = await import("../src/game-engine.mjs");

test("curated species keep game metadata while using stable taxonomy ids", () => {
  const definition = definitionFromTaxon({
    id: "col-panthera-leo",
    scientificName: "Panthera leo",
    canonicalName: "Panthera leo",
    commonName: "lion",
    parentId: "col-panthera",
    rank: "species",
    kind: "species",
    extinct: false,
    gameRarity: "COMMON",
    source: "Catalogue of Life",
  });

  assert.equal(definition.id, "col-panthera-leo");
  assert.equal(definition.curatedDefinitionId, "panthera-leo");
  assert.equal(definition.rarity, "RARE");
  assert.equal(definition.editionCap, 23000);
  assert.equal(definition.commonName, "Lion");
});

test("uncurated imported species default to Research-compatible Common cards", () => {
  const definition = definitionFromTaxon({
    id: "col-new-species",
    scientificName: "Testus exampleii",
    canonicalName: "Testus exampleii",
    commonName: "Testus exampleii",
    parentId: "col-genus",
    rank: "species",
    kind: "species",
    extinct: false,
    gameRarity: "COMMON",
    source: "Catalogue of Life",
  });

  assert.equal(definition.rarity, "COMMON");
  assert.equal(definition.editionCap, 0);
  assert.equal(definition.temporalStatus, "extant");
});

test("higher imported taxa inherit rank-based rarity and Foundation caps", () => {
  const definition = definitionFromTaxon({
    id: "col-family",
    scientificName: "Exampleidae",
    canonicalName: "Exampleidae",
    commonName: "Exampleidae",
    parentId: "col-order",
    rank: "family",
    kind: "taxon",
    extinct: false,
    gameRarity: "RARE",
    source: "Catalogue of Life",
  });

  assert.equal(definition.rarity, "RARE");
  assert.equal(definition.editionCap, 50000);
  assert.equal(definition.kind, "taxon");
});

test("pack generator can use an indexed external definition selector", () => {
  const rng = {
    float: () => 0,
    int: () => 1,
  };
  const config = {
    cardsPerPack: 6,
    holoRate: 0,
    lucaDenominator: 100,
  };

  const result = generatePackBlueprint({
    rng,
    config,
    definitionSelector: () => ({ id: "virtual-card", rarity: "COMMON", kind: "species" }),
  });

  assert.equal(result.cards.length, 6);
  assert.ok(result.cards.every((card) => card.definitionId === "virtual-card"));
});
