#!/usr/bin/env node
import { parseArgs } from "node:util";
import { reviewBuildingSource } from "../src/core/building-generation/source-workflow.mjs";

const {values,positionals}=parseArgs({
 args:process.argv.slice(2),allowPositionals:true,
 options:{
  licence:{type:"string"},author:{type:"string"},attribution:{type:"string"},title:{type:"string"},
  "source-url":{type:"string"},"captured-at":{type:"string"},description:{type:"string"},
  "capture-lon":{type:"string"},"capture-lat":{type:"string"},"heading-degrees":{type:"string"},
  "confirm-rights":{type:"boolean",default:false},
 }
});
if(positionals.length!==3||!values.licence||process.argv.includes("--help")){
 console.log("Usage: node scripts/review-building-source.mjs <workspaceRoot> <buildingId> <sourceId> --licence <known licence/permission basis> --confirm-rights [--author <name>] [--attribution <credit>] [--source-url <https://...>] [--capture-lon <deg> --capture-lat <deg> [--heading-degrees <0..360>]]\nOnly use --confirm-rights after independently verifying ownership or permission. This writes a local attestation; it does not verify copyright for you.");
 process.exit(process.argv.includes("--help")?0:2);
}
const [workspaceRoot,buildingId,sourceId]=positionals;
const lon=values["capture-lon"]===undefined?undefined:Number(values["capture-lon"]);
const lat=values["capture-lat"]===undefined?undefined:Number(values["capture-lat"]);
const heading=values["heading-degrees"]===undefined?undefined:Number(values["heading-degrees"]);
if((lon===undefined)!==(lat===undefined))throw new TypeError("--capture-lon and --capture-lat must be supplied together");
const result=await reviewBuildingSource({
 workspaceRoot,buildingId,sourceId,licence:values.licence,confirmRights:values["confirm-rights"],
 author:values.author,attribution:values.attribution,title:values.title,sourceUrl:values["source-url"],
 capturedAt:values["captured-at"],description:values.description,
 captureLocation:lon===undefined?undefined:{longitude:lon,latitude:lat,...(heading===undefined?{}:{headingDegrees:heading})}
});
console.log(JSON.stringify({sourceId:result.record.id,buildingId:result.record.buildingId,licence:result.record.licence,usageStatus:result.record.usageStatus,assetSha256:result.assetSha256,recordPath:result.recordPath,attestation:result.attestation},null,2));