#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMeshFromReviewedWireframe } from "../src/core/building-generation/wireframe-to-mesh.mjs";

async function main() {
  const [inputArg, outputArg, ...flags] = process.argv.slice(2);
  if (!inputArg || !outputArg || path.resolve(inputArg) === path.resolve(outputArg)) {
    throw new Error("Usage: node scripts/build-reviewed-wireframe-mesh.mjs <reviewed-wireframe.json> <mesh-candidate.json> [--min-triangle-area=0.00000001]");
  }
  const options = {};
  for (const flag of flags) {
    if (flag.startsWith("--min-triangle-area=")) options.minTriangleArea = Number(flag.split("=")[1]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  const input = JSON.parse(await readFile(path.resolve(inputArg), "utf8"));
  const result = buildMeshFromReviewedWireframe(input, options);
  await writeFile(path.resolve(outputArg), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ acceptedFaces: result.qa.acceptedFaceCount, rejectedFaces: result.qa.rejectedFaces.length, boundaryEdges: result.qa.boundaryEdgeCount, nonManifoldEdges: result.qa.nonManifoldEdges.length, publicationEligible: false }, null, 2));
  if (result.qa.acceptedFaceCount === 0 || result.qa.rejectedFaces.length > 0 || result.qa.boundaryEdgeCount > 0 || result.qa.nonManifoldEdges.length > 0) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
