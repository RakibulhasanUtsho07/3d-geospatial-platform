#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateBuildingModel } from "../src/core/building-generation/generation-engine.mjs";
const args=process.argv.slice(2);
if(args.includes("--help")||args.length<2){console.log("Usage: node scripts/generate-building-model.mjs <building-spec.json> <output.glb>\nThe command also writes <output>.report.json.");process.exit(args.includes("--help")?0:2);}
const inputPath=path.resolve(process.cwd(),args[0]),outputPath=path.resolve(process.cwd(),args[1]);
if(!/\.glb$/i.test(outputPath))throw new TypeError("output path must end in .glb");
const spec=JSON.parse(await readFile(inputPath,"utf8"));
const {glb,report,normalizedSpec}=generateBuildingModel(spec);
await mkdir(path.dirname(outputPath),{recursive:true});await writeFile(outputPath,glb);
const reportPath=outputPath.replace(/\.glb$/i,"")+".report.json";
await writeFile(reportPath,JSON.stringify({normalizedSpec,report},null,2)+"\n","utf8");
console.log(JSON.stringify({outputPath,reportPath,bytes:glb.byteLength,buildingId:report.buildingId,reviewRequired:report.reviewRequired,warnings:report.warnings},null,2));