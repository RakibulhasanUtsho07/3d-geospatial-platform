#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewMeshSurfaces } from "../src/core/building-generation/mesh-surface-review.mjs";

async function main() {
  const [inputArg, outputArg, ...flags] = process.argv.slice(2);
  if (!inputArg || !outputArg || path.resolve(inputArg) === path.resolve(outputArg)) {
    throw new Error("Usage: node scripts/review-mesh-surfaces.mjs <mesh-candidate.json> <surface-review.json> [--max-boundary-edges=0]");
  }
  const options = {};
  for (const flag of flags) {
    if (flag.startsWith("--max-boundary-edges=")) options.maxBoundaryEdges = Number(flag.split("=")[1]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  const mesh = JSON.parse(await readFile(path.resolve(inputArg), "utf8"));
  const report = reviewMeshSurfaces(mesh, options);
  await writeFile(path.resolve(outputArg), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    status: report.status,
    acceptedTriangles: report.acceptedTriangleCount,
    boundaryEdges: report.boundaryEdges.length,
    nonManifoldEdges: report.nonManifoldEdges.length,
    repairProposals: report.repairProposals.length,
    publicationEligible: report.publicationEligible,
  }, null, 2));
  if (report.status !== "topology-check-passed") process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
