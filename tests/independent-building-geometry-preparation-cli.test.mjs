import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {MODEL_TO_EVALUATION,createBuildingGlb,surveyGeometryDocument} from "./fixtures/glb-geometry-fixture.mjs";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const prepSource=fileURLToPath(new URL("../scripts/prepare-independent-building-truth-manifest.mjs",import.meta.url));
const evalSource=fileURLToPath(new URL("../scripts/evaluate-independent-building-truth.mjs",import.meta.url));
const implSource=fileURLToPath(new URL("../src/core/building-generation/glb-geometry-extraction.mjs",import.meta.url));
async function setup(t){
  const root=await mkdtemp(path.join(os.tmpdir(),"brf-09-glb-prep-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ["scripts","src/core/building-generation","evidence","configs"])await mkdir(path.join(root,dir),{recursive:true});
  await writeFile(path.join(root,"scripts/prepare-independent-building-truth-manifest.mjs"),await readFile(prepSource));
  await writeFile(path.join(root,"scripts/evaluate-independent-building-truth.mjs"),await readFile(evalSource));
  await writeFile(path.join(root,"src/core/building-generation/glb-geometry-extraction.mjs"),await readFile(implSource));
  await writeFile(path.join(root,"src/core/building-generation/geometry-extraction-provenance.mjs"),
    await readFile(fileURLToPath(new URL("../src/core/building-generation/geometry-extraction-provenance.mjs",import.meta.url))));
  const glb=createBuildingGlb(),reference=Buffer.from(JSON.stringify(surveyGeometryDocument(),null,2)+"\n");
  await writeFile(path.join(root,"evidence/candidate.glb"),glb);await writeFile(path.join(root,"evidence/survey.json"),reference);
  const config={schemaVersion:"1.0.0",evaluationId:"cli-test-evaluation-01",buildingId:"cli-test-building-01",
    generatedAt:"2026-10-27T09:00:00.000Z",extractorCommitSha:"1234567890abcdef1234567890abcdef12345678",
    candidate:{glbPath:"evidence/candidate.glb",expectedGlbSha256:hash(glb),coordinateFrameId:"test-building-frame-y-up-v1",
      units:"m",modelCoordinateFrameId:"synthetic-unit-test-frame",modelToEvaluationFrameMatrix4x4:MODEL_TO_EVALUATION,
      checkPoints:[]},
    reference:{sourcePath:"evidence/survey.json",expectedSourceSha256:hash(reference)},
    tolerances:{footprintAreaRelativeErrorPercent:5,footprintBoundaryP95M:0.1,footprintBoundaryMaxM:0.2,
      dimensionRelativeErrorPercent:5,checkPointRmseM:0.1,checkPointMaxM:0.2,surfaceDistanceP95M:0.1,surfaceDistanceMaxM:0.2}};
  await writeFile(path.join(root,"configs/evaluation.json"),JSON.stringify(config,null,2));
  return {root,config,glb,reference};
}
function run(script,root,args){return spawnSync(process.execPath,[script,...args,"--root="+root],{cwd:root,encoding:"utf8"});}

test("prepares a manifest from exact GLB bytes and independently supplied reference JSON",async t=>{
  const {root}=await setup(t);
  const prepared=run(prepSource,root,["configs/evaluation.json","prepared.json"]);
  assert.equal(prepared.status,0,prepared.stderr);
  const manifest=JSON.parse(await readFile(path.join(root,"prepared.json"),"utf8"));
  assert.equal(manifest.candidate.glbSha256,hash(await readFile(path.join(root,"evidence/candidate.glb"))));
  assert.equal(manifest.candidate.geometryExtractionSummary.sourceVertexCount,8);
  assert.equal(manifest.candidate.geometryExtractionSummary.sourceTriangleCount,12);
  assert.deepEqual(manifest.candidate.dimensionsM,{widthM:2,heightM:3,depthM:4});
  assert.equal(manifest.candidate.geometryExtractionProvenance.extractor.artifactPath,"src/core/building-generation/glb-geometry-extraction.mjs");
  assert.equal(manifest.preparation.acceptanceEligible,false);
  const evaluated=run(evalSource,root,["prepared.json","report.json"]);
  assert.equal(evaluated.status,2,evaluated.stderr);
  const report=JSON.parse(await readFile(path.join(root,"report.json"),"utf8"));
  assert.equal(report.geometryExtractionProvenance.candidate.status,"passed");
  assert.equal(report.geometryExtractionProvenance.reference.status,"passed");
  assert.equal(report.assetIntegrity.every(item=>item.status==="passed"),true);
  assert.equal(report.policy.acceptanceEligible,false);
  assert.equal(report.policy.publicationEligible,false);
  assert.equal(report.policy.mapReady,false);
  assert.ok(report.warnings.some(check=>check.id==="independent-check-points-present"));
  assert.match(manifest.reference.sourceDescription,/Synthetic fixture/);
});

test("rejects hash-pinned GLB/reference changes and coordinate-frame disagreement",async t=>{
  const {root}=await setup(t);
  await writeFile(path.join(root,"evidence/candidate.glb"),Buffer.from("modified"));
  const stale=run(prepSource,root,["configs/evaluation.json","stale.json"]);
  assert.equal(stale.status,1);assert.match(stale.stderr,/differs from actual source bytes/);
  const freshRoot=await setup(t);t.after(()=>rm(freshRoot.root,{recursive:true,force:true}));
  const truth=JSON.parse((await readFile(path.join(freshRoot.root,"evidence/survey.json"))).toString("utf8"));
  truth.coordinateFrameId="wrong-frame";
  const changed=Buffer.from(JSON.stringify(truth,null,2)+"\n");
  await writeFile(path.join(freshRoot.root,"evidence/survey.json"),changed);
  const revised={...freshRoot.config,reference:{sourcePath:"evidence/survey.json",expectedSourceSha256:hash(changed)}};
  await writeFile(path.join(freshRoot.root,"configs/evaluation.json"),JSON.stringify(revised,null,2));
  const mismatch=run(prepSource,freshRoot.root,["configs/evaluation.json","frame.json"]);
  assert.equal(mismatch.status,1);assert.match(mismatch.stderr,/same coordinateFrameId/);
});

test("refuses output traversal and malformed input config paths",async t=>{
  const {root}=await setup(t);
  assert.equal(run(prepSource,root,["configs/evaluation.json","../escaped.json"]).status,1);
  const configPath=path.join(root,"configs/evaluation.json");
  const config=JSON.parse(await readFile(configPath,"utf8"));config.candidate.glbPath="../secret.glb";
  await writeFile(configPath,JSON.stringify(config,null,2));
  const unsafe=run(prepSource,root,["configs/evaluation.json","unsafe.json"]);
  assert.equal(unsafe.status,1);assert.match(unsafe.stderr,/safe project-relative path/);
});
