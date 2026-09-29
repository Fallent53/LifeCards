import test from "node:test";
import assert from "node:assert/strict";
import { generatePackBlueprint, packsAccrued, rollFinish, rollOrigin } from "../src/game-engine.mjs";

function rng(sequence=[0.5],ints=[1]){let fi=0,ii=0;return{float:()=>sequence[(fi++)%sequence.length],int:()=>ints[(ii++)%ints.length]}}

test("pack blueprint always contains six normal cards",()=>{
  const config={cardsPerPack:6,holoRate:0.075,lucaDenominator:1_000_000_000};
  const result=generatePackBlueprint({rng:rng([0.2,0.8,0.4,0.6],[1]),config});
  assert.equal(result.cards.length,6);
});
test("holo is independent and configurable",()=>{
  assert.equal(rollFinish(rng([0.01]),0.075),"HOLO");
  assert.equal(rollFinish(rng([0.5]),0.075),"STANDARD");
});
test("LUCA origin roll is hit only on zero",()=>{
  assert.equal(rollOrigin(rng([0.5],[0]),10),true);
  assert.equal(rollOrigin(rng([0.5],[4]),10),false);
});
test("pack storage accrues every eight minutes and caps at eight",()=>{
  const config={packIntervalMs:8*60*1000,maxStoredPacks:8},anchorAt=1_000_000;
  assert.equal(packsAccrued({now:anchorAt+40*60*1000,anchorAt,balance:1,config}).balance,6);
  assert.equal(packsAccrued({now:anchorAt+10*60*60*1000,anchorAt,balance:1,config}).balance,8);
});
