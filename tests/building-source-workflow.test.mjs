import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { prepareBuildingSpecSources, reviewBuildingSource } from "../src/core/building-generation/source-workflow.mjs";
import { planGeneration } from "../src/core/building-generation/generation-engine.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(64,13)]);
async function workspace(t) { const root = await mkdtemp(path.join(os.tmpdir(), "source-workflow-")); t.after(() => rm(root,{recursive:true,force:true})); return root; }
async function intake(root, sourceId, options = {}) {
  const dir=path.join(root,"uploads");await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,sourceId+".png"),Buffer.concat([png,Buffer.from(sourceId)]));
  return await ingestMediaFile({workspaceRoot:root,sourcePath:"uploads/"+sourceId+".png",buildingId:fixture.id,sourceId,kind:"image",title:sourceId+" facade",...options});
}
test("source cannot be approved without explicit rights attestation and a known licence",async t=>{
  const root=await workspace(t);await intake(root,"photo-a");
  await assert.rejects(reviewBuildingSource({workspaceRoot:root,buildingId:fixture.id,sourceId:"photo-a",licence:"CC BY 4.0",confirmRights:false}),/confirmRights must be true/);
  await assert.rejects(reviewBuildingSource({workspaceRoot:root,buildingId:fixture.id,sourceId:"photo-a",licence:"unknown",confirmRights:true}),/known source licence/);
  const stored=JSON.parse(await readFile(path.join(root,".building-engine","media",fixture.id,"sources","photo-a.json"),"utf8"));
  assert.equal(stored.usageStatus,"unreviewed");assert.equal(stored.licence,"unknown");
});
test("review records explicit licence, attribution and capture metadata after hash verification",async t=>{
  const root=await workspace(t);const ingested=await intake(root,"photo-a");
  const result=await reviewBuildingSource({workspaceRoot:root,buildingId:fixture.id,sourceId:"photo-a",licence:"CC BY 4.0",confirmRights:true,author:"Sample photographer",attribution:"Sample photographer / source page",sourceUrl:"https://example.org/photo",captureLocation:{longitude:90.406,latitude:23.709,headingDegrees:182}});
  assert.equal(result.record.usageStatus,"approved");assert.equal(result.record.licence,"CC BY 4.0");assert.equal(result.record.author,"Sample photographer");
  assert.equal(result.record.location.headingDegrees,182);assert.equal(result.assetSha256,ingested.record.sha256);assert.ok(result.record.rightsReviewedAt);
});
test("source review refuses tampered source bytes",async t=>{
  const root=await workspace(t);const ingested=await intake(root,"photo-tampered");
  await writeFile(path.join(root,ingested.record.relativePath),"tampered image bytes");
  await assert.rejects(reviewBuildingSource({workspaceRoot:root,buildingId:fixture.id,sourceId:"photo-tampered",licence:"CC BY 4.0",confirmRights:true}),/SHA-256/);
});
test("prepares a versioned BuildingSpec using selected current source records and preserves other sources",async t=>{
  const root=await workspace(t);await intake(root,"front-photo");
  await reviewBuildingSource({workspaceRoot:root,buildingId:fixture.id,sourceId:"front-photo",licence:"CC BY 4.0",confirmRights:true,attribution:"Open sample attribution"});
  const prepared=await prepareBuildingSpecSources({workspaceRoot:root,buildingSpec:fixture,sourceIds:["front-photo"]});
  assert.equal(prepared.buildingSpec.id,fixture.id);assert.ok(prepared.buildingSpec.sources.some(s=>s.id==="survey-notes"));
  const photo=prepared.buildingSpec.sources.find(s=>s.id==="front-photo");
  assert.equal(photo.assetId,prepared.sourceStatuses[0].assetId);assert.equal(photo.usageStatus,"approved");assert.equal(photo.licence,"CC BY 4.0");
});
test("rejects duplicate source IDs and missing media records when preparing a spec",async t=>{
  const root=await workspace(t);
  await assert.rejects(prepareBuildingSpecSources({workspaceRoot:root,buildingSpec:fixture,sourceIds:["x","x"]}),/duplicates/);
  await assert.rejects(prepareBuildingSpecSources({workspaceRoot:root,buildingSpec:fixture,sourceIds:["not-found"]}),/ENOENT/);
});
test("routes three approved images to a reconstruction candidate even without GPS",()=>{
  const sources=[1,2,3].map(i=>({id:"view-"+i,kind:"image",title:"view "+i,licence:"CC BY 4.0",usageStatus:"approved",assetId:"a".repeat(64)}));
  const candidate={...fixture,sources:[...fixture.sources.filter(s=>s.id==="survey-notes"),...sources]};
  const plan=planGeneration(candidate);
  assert.equal(plan.sourceRoute,"multiview-photogrammetry-candidate");
  assert.equal(plan.visualReferences.withCaptureLocation,0);
  assert.ok(plan.warnings.some(w=>w.toLowerCase().includes("georeference")||w.toLowerCase().includes("ground-control")));
});