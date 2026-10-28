import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateBrf41InterimDatasetPolicy } from "../src/core/building-generation/brf41-interim-dataset-policy.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const manifestPath = path.join(repoRoot, "benchmarks/building-reconstruction/brf-41-interim-dataset-policy.json");
const cliPath = path.join(repoRoot, "scripts/validate-brf41-interim-dataset-policy.mjs");
const baseManifest = JSON.parse(await readFile(manifestPath, "utf8"));

function cloneManifest() {
  return structuredClone(baseManifest);
}

test("BRF-41 inventory is policy-compliant but admits only a limited demo sample", () => {
  const report = validateBrf41InterimDatasetPolicy(cloneManifest());

  assert.equal(report.status, "policy-compliant-demo-only");
  assert.equal(report.blockers.length, 0);
  assert.equal(report.demoOnlyAssetCount, 1);
  assert.equal(report.blockedAssetCount, 5);
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
  assert.ok(report.assets.find((asset) => asset.id === "tum-uas-images-archive").decision === "blocked");
  assert.ok(report.assets.find((asset) => asset.id === "gt-lod3-goldcoast-collection").decision === "blocked");
});

test("public accessibility cannot replace explicit rights-scope review", () => {
  const manifest = cloneManifest();
  manifest.policy.noLicenseInferenceFromPublicAvailability = false;

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("commercial-safe-policy"));
});

test("demo imagery cannot be reassigned as independent reference truth", () => {
  const manifest = cloneManifest();
  const asset = manifest.assets.find((item) => item.id === "brf13-flat-roof-image-0005");
  asset.role = "independent-reference";

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-brf13-flat-roof-image-0005-demo-use-boundary"));
});

test("demo imagery cannot be promoted to public redistribution or map publication", () => {
  const manifest = cloneManifest();
  const asset = manifest.assets.find((item) => item.id === "brf13-flat-roof-image-0005");
  asset.allowedUses.push("public-image-redistribution");
  asset.deniedUses = asset.deniedUses.filter((item) => item !== "public-image-redistribution");

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-brf13-flat-roof-image-0005-demo-use-boundary"));
  assert.ok(report.blockers.includes("asset-brf13-flat-roof-image-0005-claim-and-publication-boundary"));
});

test("blocked sources cannot acquire a use by flipping a manifest field", () => {
  const manifest = cloneManifest();
  const asset = manifest.assets.find((item) => item.id === "tum-uls-source-manual");
  asset.allowedUses = ["private-render-smoke-test"];

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-tum-uls-source-manual-blocked-no-uses"));
});

test("conflicting license declarations cannot enter the demo lane", () => {
  const manifest = cloneManifest();
  const asset = manifest.assets.find((item) => item.id === "gt-lod3-goldcoast-collection");
  asset.decision = "demo-only";
  asset.allowedUses = ["private-render-smoke-test"];

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-gt-lod3-goldcoast-collection-exact-source-pin"));
  assert.ok(report.blockers.includes("asset-gt-lod3-goldcoast-collection-limited-rights-statement"));
});

test("tampered expected source hash cannot reuse the previous byte-verification result", () => {
  const manifest = cloneManifest();
  const asset = manifest.assets.find((item) => item.id === "brf13-flat-roof-image-0005");
  asset.source.sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-brf13-flat-roof-image-0005-byte-evidence"));
});

test("release flags are rejected if any flag is promoted", () => {
  const manifest = cloneManifest();
  manifest.releaseFlags.mapReady = true;

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("release-flags-false"));
  assert.equal(report.releaseFlags.mapReady, false);
});

test("duplicate asset IDs are rejected", () => {
  const manifest = cloneManifest();
  manifest.assets[1].id = manifest.assets[0].id;

  const report = validateBrf41InterimDatasetPolicy(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("unique-asset-ids"));
});

test("CLI prints a reproducible report and retains demo-only status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "brf41-policy-"));
  try {
    const run = spawnSync(process.execPath, [cliPath, manifestPath, "--report", "report.json"], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    const report = JSON.parse(await readFile(path.join(tempDir, "report.json"), "utf8"));
    assert.equal(summary.status, "policy-compliant-demo-only");
    assert.equal(report.status, "policy-compliant-demo-only");
    assert.match(report.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(report.validatorSha256, /^[a-f0-9]{64}$/);
    assert.match(report.reportSha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.values(report.releaseFlags).every((value) => value === false));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI rejects an inventory that tries to publish interim data", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "brf41-blocked-"));
  try {
    const manifest = cloneManifest();
    manifest.releaseFlags.publicationEligible = true;
    const alteredManifest = path.join(tempDir, "altered-manifest.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(alteredManifest, JSON.stringify(manifest));
    const run = spawnSync(process.execPath, [cliPath, alteredManifest], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(run.status, 2);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.status, "blocked");
    assert.ok(summary.blockers.includes("release-flags-false"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
