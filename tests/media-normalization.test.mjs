import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMediaFileKey, hasCompleteAttribution, isLikelyPhotographicMedia } from "../src/media.mjs";

test("Wikimedia batch keys normalize underscores and spaces identically",()=>{
  assert.equal(
    normalizeMediaFileKey("Mollusca_Diversity.png"),
    normalizeMediaFileKey("File:Mollusca Diversity.png")
  );
  assert.equal(
    normalizeMediaFileKey("Arthropoda__collage.png"),
    "arthropoda collage.png"
  );
});

test("attribution placeholders never count as complete",()=>{
  assert.equal(hasCompleteAttribution({
    imageUrl:"https://example.test/image.jpg",
    originalUrl:"https://example.test/source",
    creator:"Unknown creator",
    license:"CC BY 4.0",
  }),false);

  assert.equal(hasCompleteAttribution({
    imageUrl:"https://example.test/image.jpg",
    originalUrl:"https://example.test/source",
    creator:"Jane Doe",
    license:"See source",
  }),false);

  assert.equal(hasCompleteAttribution({
    imageUrl:"https://example.test/image.jpg",
    originalUrl:"https://example.test/source",
    creator:"Jane Doe",
    license:"CC BY 4.0",
  }),true);
});


test("coverage-first visual gate rejects obvious diagrams but accepts photos without attribution",()=>{
  assert.equal(isLikelyPhotographicMedia({
    imageUrl:"https://example.test/photo.jpg",
    title:"Panthera leo in Serengeti",
  }),true);

  assert.equal(isLikelyPhotographicMedia({
    imageUrl:"https://example.test/range.svg",
    title:"Panthera leo range map",
  }),false);

  assert.equal(isLikelyPhotographicMedia({
    imageUrl:"https://example.test/image.png",
    title:"Felidae cladogram diagram",
  }),false);
});
