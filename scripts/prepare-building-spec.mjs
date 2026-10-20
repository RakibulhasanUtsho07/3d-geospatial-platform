#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareBuildingSpecSources } from "../src/core/building-generation/source-workflow.mjs";

const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{pretty:{type:"boolean",default:true}}});
if(positionals.length!==4||process.argv.includes("--help")){
 console.log("Usage: node scripts/prepare-building-spec.mjs <workspaceRoot> <base-spec.json> <sourceId1,sourceId2,...> <output-spec.json>\nThis replaces/inserts the selected source records in BuildingSpec from the current local intake metadata, retaining other sources and validating the final schema.");
 process.exit(process.argv.includes("--help")?0:2);
}
const [workspaceRoot,specPath,sourceIdsCsv,outputArg]=positionals;
const buildingSpec=JSON.parse(await readFile(path.resolve(specPath),"utf8")),sourceIds=sourceIdsCsv.split(",").map(s=>s.trim()).filter(Boolean);
const prepared=await prepareBuildingSpecSources({workspaceRoot:path.resolve(workspaceRoot),buildingSpec,sourceIds});
const outputPath=path.resolve(outputArg);await mkdir(path.dirname(outputPath),{recursive:true});
const tempPath=outputPath+"."+randomUUID()+".tmp";
await writeFile(tempPath,JSON.stringify(prepared.buildingSpec,null,values.pretty?2:0)+"\n",{flag:"wx",mode:0o600});
try{await rename(tempPath,outputPath);}catch(error){await rm(tempPath,{force:true});throw error;}
console.log(JSON.stringify({outputPath,buildingId:prepared.buildingSpec.id,sourceCount:prepared.buildingSpec.sources.length,selected:prepared.sourceStatuses},null,2));