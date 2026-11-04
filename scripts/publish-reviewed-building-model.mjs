#!/usr/bin/env node

function usage() {
  console.log("Direct unsigned publication from a plain JSON attestation has been retired.");
  console.log("");
  console.log("Use a signed, workflow-specific publication path instead:");
  console.log("  - approved generation job: npm run sign:approved-generation-job-publication-review");
  console.log("  - floor-plan candidate: npm run sign:floor-plan-publication-review");
  console.log("  - evidence-backed vertical slice: npm run publish:evidence-backed-vertical-slice");
  console.log("");
  console.log("Every catalog writer call now requires verified Ed25519 reviewer authentication from the server-configured D3M-01 trust registry.");
}

usage();
process.exitCode = process.argv.includes("--help") ? 0 : 2;
