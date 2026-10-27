#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assessBuildingBenchmarkReadiness } from "../src/core/building-generation/building-benchmark-readiness.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (process.argv.includes("--help") || args.length !== 1) {
  console.log("Usage: node scripts/validate-building-benchmark-readiness.mjs <intake-manifest.json>\nChecks a BRF-10 source-intake manifest for declared identity, rights review, asset checksums, frame registration, candidate/reference separation and held-out controls. This is a metadata preflight only; it does not download/hash files, authenticate licences/surveys, run reconstruction or approve a model.");
  process.exitCode = process.argv.includes("--help") ? 0 : 2;
} else {
  try {
    const manifestPath = path.resolve(args[0]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const report = assessBuildingBenchmarkReadiness(manifest);
    console.log(JSON.stringify({
      manifestPath,
      status: report.status,
      counts: report.counts,
      blockers: report.blockers,
      checks: report.checks,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
      limitation: "Metadata preflight only. Re-hash exact files, verify asset-level rights and survey provenance, inspect coordinate registration, then run the actual GLB/reference evaluator and human review.",
    }, null, 2));
    if (report.status !== "manifest-complete") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
