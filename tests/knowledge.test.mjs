import test from "node:test";
import assert from "node:assert/strict";
import { lifemapUrlForTaxId, ncbiUrlForTaxId } from "../src/knowledge.mjs";

test("Lifemap deep-links use NCBI taxids", () => {
  assert.equal(
    lifemapUrlForTaxId("9681"),
    "https://lifemap-ncbi.univ-lyon1.fr/?tid=9681"
  );
  assert.equal(lifemapUrlForTaxId("taxid: 9681"), "https://lifemap-ncbi.univ-lyon1.fr/?tid=9681");
});

test("NCBI taxonomy links are sanitized", () => {
  assert.equal(
    ncbiUrlForTaxId(" 9606 "),
    "https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=9606"
  );
  assert.equal(ncbiUrlForTaxId(""), null);
});
