#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMultiViewWireframe } from "../src/core/building-generation/multi-view-wireframe-registration.mjs";
async function main(){
 const args=process.argv.slice(2);
 if(args.includes("--help")||args.length!==2){console.log("Usage: node scripts/build-multi-view-wireframe.mjs <correspondence-input.json> <output-wireframe.json>\nInput JSON schema: {cameras:[{id,projection:[[3x4 matrix]]}],features:[{id,observations:[{cameraId,x,y}]}],edges:[[featureIdA,featureIdB]],options?:{maxRmsReprojectionError?:number}}. Provide calibrated cameras and manually verified cross-view feature matches.");process.exit(args.includes("--help")?0:2);}
 const inputPath=path.resolve(args[0]),outputPath=path.resolve(args[1]);
 if(inputPath===outputPath)throw new Error("output path must differ from input path");
 const input=JSON.parse(await readFile(inputPath,"utf8"));
 const model=buildMultiViewWireframe(input);
 await writeFile(outputPath,JSON.stringify(model,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log(JSON.stringify({status:model.status,triangulatedVertexCount:model.triangulatedVertexCount,edgeCount:model.edgeCount,issueCount:model.issues.length,outputPath,publicationEligible:model.publicationEligible},null,2));
 if(model.issues.length)process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
