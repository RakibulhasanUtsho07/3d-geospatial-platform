#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runSingleImage3D } from "../src/core/building-generation/single-image-3d-worker.mjs";

const {values,positionals}=parseArgs({
 args:process.argv.slice(2),allowPositionals:true,
 options:{
  "confirm-single-view-inference":{type:"boolean",default:false},
  "runner-script":{type:"string"},"python":{type:"string"},"device":{type:"string",default:"cuda:0"},
  "resolution":{type:"string",default:"256"},"model":{type:"string",default:"stabilityai/TripoSR"},
  "timeout-ms":{type:"string",default:"1800000"},
 }
});
if(positionals.length!==4||!values["runner-script"]||process.argv.includes("--help")){
 console.log("Usage: node scripts/generate-building-from-image.mjs <workspaceRoot> <buildingSpec.json> <jobId> <sourceId> --runner-script <TripoSR-repo/run.py> --confirm-single-view-inference [--python python] [--device cuda:0|cpu] [--resolution 256] [--model stabilityai/TripoSR]\nRequires the externally-installed TripoSR dependencies/model. Output is AI-proposed, non-metric and review-only; it is not published to /map.");
 process.exit(process.argv.includes("--help")?0:2);
}
const [workspaceRoot, specPath, jobId, sourceId]=positionals;
const buildingSpec=JSON.parse(await readFile(path.resolve(specPath),"utf8"));
const result=await runSingleImage3D({
 workspaceRoot:path.resolve(workspaceRoot),buildingSpec,buildingId:buildingSpec.id,jobId,sourceId,
 runnerScript:values["runner-script"],pythonPath:values.python,device:values.device,
 mcResolution:Number(values.resolution),pretrainedModelNameOrPath:values.model,
 timeoutMs:Number(values["timeout-ms"]),allowSingleViewInference:values["confirm-single-view-inference"],
});
console.log(JSON.stringify({
 jobDirectory:path.relative(path.resolve(workspaceRoot),result.jobDir).split(path.sep).join("/"),
 reportPath:path.relative(path.resolve(workspaceRoot),result.reportPath).split(path.sep).join("/"),
 output:result.report.outputs.glb,status:result.report.status,confidence:result.report.confidence,
 mapReady:result.report.mapReady,publicationEligible:result.report.publicationEligible,warnings:result.report.warnings
},null,2));