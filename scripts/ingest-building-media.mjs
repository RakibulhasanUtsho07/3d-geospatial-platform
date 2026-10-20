#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { extractVideoFrames } from "../src/core/building-generation/video-frame-extractor.mjs";

const [workspaceArg,buildingId,sourceId,sourcePathArg,kindArg="auto",fpsArg="0.5",maxFramesArg="60"] = process.argv.slice(2);
if(!workspaceArg||!buildingId||!sourceId||!sourcePathArg||process.argv.includes("--help")){
 console.log("Usage: node scripts/ingest-building-media.mjs <workspaceRoot> <buildingId> <sourceId> <relativeSourcePath> [image|video|floor-plan|auto] [fps=0.5] [maxFrames=60]\nLocal files only. Videos are stored privately in the workspace and sampled with FFmpeg. This command does not perform 3D reconstruction.");
 process.exit(process.argv.includes("--help")?0:2);
}
const workspaceRoot=path.resolve(workspaceArg);
const sourcePath=path.relative(workspaceRoot,path.resolve(workspaceRoot,sourcePathArg)).split(path.sep).join("/");
const kind=kindArg==="auto"?"auto":kindArg;
const ingested=await ingestMediaFile({workspaceRoot,sourcePath,buildingId,sourceId,kind,title:path.basename(sourcePath),licence:"unknown",usageStatus:"unreviewed",description:"Local media intake; record source licence and usage approval before publication."});
let result={media:ingested.record,videoFrames:null};
if(ingested.record.kind==="video"){
 const fps=Number(fpsArg),maxFrames=Number(maxFramesArg);
 const extracted=await extractVideoFrames({workspaceRoot,videoRelativePath:ingested.record.relativePath,buildingId,sourceId,fps,maxFrames,maxWidth:1600,timeoutMs:600000,videoRecord:ingested.record});
 result.videoFrames={extractedFrames:extracted.extractedFrames,frames:extracted.frames.map(frame=>({id:frame.id,assetId:frame.assetId,relativePath:frame.relativePath,sha256:frame.sha256,frameNumber:frame.frameNumber,nominalTimeSeconds:frame.nominalTimeSeconds})),warning:extracted.warning};
}
const resultPath=path.join(workspaceRoot,".building-engine","media",buildingId,"sources",sourceId+".result.json");
await writeFile(resultPath,JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({resultPath:path.relative(workspaceRoot,resultPath),media:{id:ingested.record.id,kind:ingested.record.kind,mimeType:ingested.record.mimeType,bytes:ingested.record.byteSize,sha256:ingested.record.sha256,licence:ingested.record.licence,usageStatus:ingested.record.usageStatus},videoFrames:result.videoFrames?.extractedFrames??0},null,2));