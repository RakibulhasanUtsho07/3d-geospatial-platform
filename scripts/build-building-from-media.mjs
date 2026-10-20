#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runMediaToModelWorkflow } from "../src/core/building-generation/media-to-model-workflow.mjs";

const {values,positionals}=parseArgs({
 args:process.argv.slice(2),allowPositionals:true,
 options:{
  source:{type:"string",multiple:true}, licence:{type:"string",multiple:true},
  author:{type:"string",multiple:true}, attribution:{type:"string",multiple:true},
  "source-url":{type:"string",multiple:true}, "captured-at":{type:"string",multiple:true},
  description:{type:"string",multiple:true}, kind:{type:"string",multiple:true},
  views:{type:"string"}, strategy:{type:"string",default:"procedural"},
  "confirm-rights":{type:"boolean",default:false},
  "confirm-single-view-inference":{type:"boolean",default:false},
  "confirm-same-building":{type:"boolean",default:false},
  "confirm-overlap-reviewed":{type:"boolean",default:false},
  "confirm-up-axis-reviewed":{type:"boolean",default:false},
  "up-axis":{type:"string"}, "model-distance":{type:"string"}, "real-distance-m":{type:"string"},
  quality:{type:"string",default:"MEDIUM"}, "colmap-path":{type:"string"},
  "runner-script":{type:"string"}, python:{type:"string"}, device:{type:"string",default:"cuda:0"},
  resolution:{type:"string",default:"256"}, model:{type:"string",default:"stabilityai/TripoSR"},
  fps:{type:"string",default:"0.5"}, "max-frames":{type:"string",default:"60"},
  "frame-width":{type:"string",default:"1600"}, ffmpeg:{type:"string"},
  "frame-timeout-ms":{type:"string",default:"600000"},
  "reconstruction-timeout-ms":{type:"string",default:"3600000"},
  "ai-timeout-ms":{type:"string",default:"1800000"},
  "heading-degrees":{type:"string",default:"0"},
 }
});
function usage(){
 console.log("Usage: node scripts/build-building-from-media.mjs <workspaceRoot> <base-spec.json> <jobId> [options]\\n\\nSources (repeat as needed):\\n  --source <sourceId=workspace-relative-path>\\n  --licence <sourceId=known licence/permission basis>\\n  --author <sourceId=name> --attribution <sourceId=credit>\\n  --source-url <sourceId=https://...> --captured-at <sourceId=timestamp>\\n  --description <sourceId=text> --kind <sourceId=auto|image|video|floor-plan>\\n  --confirm-rights\\n  --views <comma-separated image/video-frame source IDs>\\n\\nStrategies:\\n  --strategy procedural\\n  --strategy single-image-ai --views <one image ID> --runner-script <TripoSR/run.py> --confirm-single-view-inference\\n  --strategy photogrammetry --views <3+ image IDs> --up-axis X|Y|Z --confirm-same-building --confirm-overlap-reviewed --confirm-up-axis-reviewed\\n\\nOptional:\\n  --model-distance <model units> --real-distance-m <metres>\\n  --fps 0.5 --max-frames 60 --frame-width 1600 --ffmpeg <executable>\\n  --quality LOW|MEDIUM|HIGH|EXTREME --colmap-path <executable>\\n  --python <executable> --device cuda:0|cpu --resolution 256 --model stabilityai/TripoSR\\n\\nInput files must exist inside workspaceRoot. Video input requires FFmpeg; COLMAP and TripoSR/PyTorch must be installed separately. Source rights must be checked by you. This command writes review candidates only and never publishes to /map.");
}
function asList(value){return value===undefined?[]:Array.isArray(value)?value:[value];}
function parsePairs(raw,label){
 const result=new Map();
 for(const item of asList(raw)){
  const equals=item.indexOf("=");
  if(equals<=0||equals===item.length-1)throw new TypeError("--"+label+" entries must be sourceId=value");
  const id=item.slice(0,equals).trim(),value=item.slice(equals+1).trim();
  if(result.has(id))throw new TypeError("duplicate --"+label+" for source '"+id+"'");
  result.set(id,value);
 }
 return result;
}
function numeric(value,label){const out=Number(value);if(!Number.isFinite(out))throw new TypeError(label+" must be numeric");return out;}
if(process.argv.includes("--help")||positionals.length!==3){usage();process.exit(process.argv.includes("--help")?0:2);}
const [workspaceRootArg,baseSpecArg,jobId]=positionals;
try{
 const sourceSpecs=asList(values.source).map(item=>{
  const equals=item.indexOf("=");
  if(equals<=0||equals===item.length-1)throw new TypeError("--source entries must be sourceId=relative/path");
  return {sourceId:item.slice(0,equals).trim(),relativePath:item.slice(equals+1).trim()};
 });
 const licences=parsePairs(values.licence,"licence"),authors=parsePairs(values.author,"author"),credits=parsePairs(values.attribution,"attribution");
 const urls=parsePairs(values["source-url"],"source-url"),captured=parsePairs(values["captured-at"],"captured-at");
 const descriptions=parsePairs(values.description,"description"),kinds=parsePairs(values.kind,"kind");
 const sourceIds=new Set(sourceSpecs.map(source=>source.sourceId));
 if(sourceIds.size!==sourceSpecs.length)throw new TypeError("each --source ID must be unique");
 const get=(map,id)=>map.has(id)?map.get(id):undefined;
 const sources=sourceSpecs.map(source=>({
  ...source,licence:get(licences,source.sourceId),author:get(authors,source.sourceId),
  attribution:get(credits,source.sourceId),sourceUrl:get(urls,source.sourceId),
  capturedAt:get(captured,source.sourceId),description:get(descriptions,source.sourceId),
  kind:get(kinds,source.sourceId)??"auto",
 }));
 const allMetadata=[licences,authors,credits,urls,captured,descriptions,kinds];
 const unknownMeta=allMetadata.flatMap(map=>[...map.keys()]).filter(id=>!sourceIds.has(id));
 if(unknownMeta.length)throw new TypeError("metadata supplied for source IDs not present in --source: "+[...new Set(unknownMeta)].join(", "));
 const viewSourceIds=values.views===undefined?undefined:values.views.split(",").map(v=>v.trim()).filter(Boolean);
 const modelDistanceUnits=values["model-distance"]===undefined?undefined:numeric(values["model-distance"],"--model-distance");
 const realDistanceM=values["real-distance-m"]===undefined?undefined:numeric(values["real-distance-m"],"--real-distance-m");
 const workspaceRoot=path.resolve(workspaceRootArg);
 const buildingSpec=JSON.parse(await readFile(path.resolve(baseSpecArg),"utf8"));
 const result=await runMediaToModelWorkflow({
  workspaceRoot,buildingSpec,jobId,sources,viewSourceIds,strategy:values.strategy,
  confirmRights:values["confirm-rights"],confirmSingleViewInference:values["confirm-single-view-inference"],
  confirmSameBuilding:values["confirm-same-building"],confirmOverlapReviewed:values["confirm-overlap-reviewed"],
  confirmUpAxisReviewed:values["confirm-up-axis-reviewed"],upAxis:values["up-axis"],
  modelDistanceUnits,realDistanceM,quality:values.quality,colmapPath:values["colmap-path"],
  runnerScript:values["runner-script"],pythonPath:values.python,device:values.device,
  mcResolution:numeric(values.resolution,"--resolution"),pretrainedModelNameOrPath:values.model,
  fps:numeric(values.fps,"--fps"),maxFrames:numeric(values["max-frames"],"--max-frames"),
  maxWidth:numeric(values["frame-width"],"--frame-width"),ffmpegPath:values.ffmpeg,
  frameTimeoutMs:numeric(values["frame-timeout-ms"],"--frame-timeout-ms"),
  reconstructionTimeoutMs:numeric(values["reconstruction-timeout-ms"],"--reconstruction-timeout-ms"),
  singleImageTimeoutMs:numeric(values["ai-timeout-ms"],"--ai-timeout-ms"),
  headingDegrees:numeric(values["heading-degrees"],"--heading-degrees"),
 });
 console.log(JSON.stringify({
  workflowDirectory:path.relative(workspaceRoot,result.workflowDir).split(path.sep).join("/"),
  modelPath:path.relative(workspaceRoot,result.modelPath).split(path.sep).join("/"),
  buildingSpecPath:path.relative(workspaceRoot,result.specPath).split(path.sep).join("/"),
  reportPath:path.relative(workspaceRoot,result.reportPath).split(path.sep).join("/"),
  mode:result.report.mode,status:result.report.status,modelBytes:result.report.output.modelBytes,
  modelSha256:result.report.output.modelSha256,mapReady:result.report.mapReady,
  publicationEligible:result.report.publicationEligible,warnings:result.report.warnings,
 },null,2));
}catch(error){
 console.error(JSON.stringify({error:error instanceof Error?error.message:String(error),reportPath:error?.reportPath},null,2));
 process.exitCode=1;
}