import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateBrf45ExactAssetRightsAdmission } from "../src/core/building-generation/brf45-exact-asset-rights-admission.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const EVALUATED_AT = "2026-10-28T00:00:00.000Z";
const SOURCE_COMMIT = "source-commit-fixture-001";
const REQUIRED = ["inspect-source", "use-for-validation", "derive-model"];

async function setup(t, count = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf45-rights-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot);
  const views = [];
  for (let i = 0; i < count; i++) {
    const index = i + 1;
    const bytes = Buffer.from("synthetic source image bytes " + index);
    views.push({
      id: "view-" + index,
      filename: "capture-" + index + ".jpg",
      sourceUrl: "https://example.test/images/capture-" + index + ".jpg",
      expectedByteSize: bytes.length,
      expectedSha256: sha(bytes),
      declaredWidth: 2048,
      declaredHeight: 1536,
    });
  }
  const sourceManifest = {
    schemaVersion: "1.0.0",
    sampleId: "synthetic-source-sample",
    evaluationStage: "multiview-source-byte-intake-only",
    dataset: {
      sourceRepositoryCommit: SOURCE_COMMIT,
      license: "SOURCE-DECLARED-ONLY",
      licenseScope: "Synthetic fixture only.",
      rightsStatus: "source-authority-not-authenticated",
    },
    views,
  };
  const manifest = {
    schemaVersion: "1.0.0",
    recordType: "brf-45-exact-asset-rights-admission",
    evaluationId: "BRF-45-EXACT-ASSET-RIGHTS-ADMISSION",
    evaluatedAt: EVALUATED_AT,
    requestedPurpose: "private-local-reconstruction-and-validation",
    sourceBinding: {
      sourceManifestFilename: "brf-14-multiview-source.json",
      sampleId: sourceManifest.sampleId,
      sourceRepositoryCommit: SOURCE_COMMIT,
      declaredLicense: sourceManifest.dataset.license,
      licenseScope: sourceManifest.dataset.licenseScope,
      rightsStatus: sourceManifest.dataset.rightsStatus,
    },
    requiredScopes: [...REQUIRED],
    policy: {
      inferPermissionFromPublicAvailability: false,
      repositoryLicenseAloneSufficient: false,
      requireExactAssetByteBinding: true,
      requireHumanReview: true,
      sourceRedistributionRequested: false,
      publicDerivedModelDisplayRequested: false,
    },
    assets: views.map(view => ({
      sourceId: view.id,
      filename: view.filename,
      sourceUrl: view.sourceUrl,
      sourceRepositoryCommit: SOURCE_COMMIT,
      byteSize: view.expectedByteSize,
      sha256: view.expectedSha256,
      requestedScopes: [...REQUIRED],
      decision: "pending",
      rights: null,
    })),
    releaseFlags: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false },
  };
  return { root, evidenceRoot, sourceManifest, manifest, views };
}

async function approveAll(fixture) {
  for (const row of fixture.manifest.assets) {
    const evidenceFilename = "rights-evidence/" + row.sourceId + ".txt";
    await mkdir(path.join(fixture.evidenceRoot, "rights-evidence"), { recursive: true });
    const evidenceBytes = Buffer.from("Synthetic permission evidence for " + row.sourceId + "; test fixture only.\n");
    await writeFile(path.join(fixture.evidenceRoot, evidenceFilename), evidenceBytes);
    row.decision = "approved";
    row.rights = {
      status: "approved",
      rightsHolderOrGrantor: "Synthetic test grantor; not a real rights holder",
      authorityBasis: "Synthetic fixture authority statement only",
      license: {
        identifier: "SYNTHETIC-TEST-LICENSE",
        name: "Synthetic test-only license",
        url: "https://example.test/license",
      },
      scopeDescription: "Private local reconstruction and validation of this synthetic source only.",
      attributionText: "Synthetic test attribution.",
      restrictionsText: "No real permission is asserted; test data only.",
      grantedScopes: [...REQUIRED],
      evidenceSnapshots: [{
        filename: evidenceFilename,
        sourceUrl: "https://example.test/rights/" + row.sourceId,
        retrievedAt: EVALUATED_AT,
        byteSize: evidenceBytes.length,
        sha256: sha(evidenceBytes),
        evidenceType: "synthetic-test-grant-record",
      }],
      reviewedBy: "synthetic-reviewer",
      reviewedAt: EVALUATED_AT,
      decisionId: "synthetic-decision-" + row.sourceId,
      effectiveAt: EVALUATED_AT,
      expiresAt: null,
      revoked: false,
      explicitGrantConfirmed: true,
    };
  }
}

test("complete synthetic exact-asset records pass only the rights-evidence completeness gate", async t => {
  const f = await setup(t);
  await approveAll(f);
  const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
    sourceManifest: f.sourceManifest,
    evidenceRoot: f.evidenceRoot,
    sourceManifestSha256: sha(Buffer.from(JSON.stringify(f.sourceManifest))),
  });
  assert.equal(report.status, "rights-admission-complete-human-review-required");
  assert.equal(report.rightsApprovedAssetCount, f.views.length);
  assert.deepEqual(report.blockers, []);
  assert.ok(Object.values(report.releaseFlags).every(value => value === false));
});

test("actual-style pending rows block even if the dataset has a license label", async t => {
  const f = await setup(t);
  const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
    sourceManifest: f.sourceManifest,
    evidenceRoot: f.evidenceRoot,
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.rightsApprovedAssetCount, 0);
  assert.ok(report.blockers.some(value => value.endsWith("-decision-approved")));
  assert.ok(Object.values(report.releaseFlags).every(value => value === false));
});

test("exact filename, URL, source hash, size and commit are mandatory", async t => {
  for (const mutate of [
    row => { row.filename = "other.jpg"; },
    row => { row.sourceUrl = "https://example.test/other.jpg"; },
    row => { row.sha256 = "f".repeat(64); },
    row => { row.byteSize += 1; },
    row => { row.sourceRepositoryCommit = "different-commit"; },
  ]) {
    const f = await setup(t);
    await approveAll(f);
    mutate(f.manifest.assets[0]);
    const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
      sourceManifest: f.sourceManifest,
      evidenceRoot: f.evidenceRoot,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.some(value => value.includes("-exact-source-binding")));
  }
});

test("missing requested scopes, expired or revoked rights and absent explicit grant block admission", async t => {
  for (const mutate of [
    rights => { rights.grantedScopes = rights.grantedScopes.filter(scope => scope !== "derive-model"); },
    rights => { rights.expiresAt = "2025-01-01T00:00:00.000Z"; },
    rights => { rights.revoked = true; },
    rights => { rights.explicitGrantConfirmed = false; },
    rights => { rights.effectiveAt = "2027-01-01T00:00:00.000Z"; },
    rights => { rights.reviewedAt = "2027-01-01T00:00:00.000Z"; },
    rights => { rights.authorityBasis = ""; },
  ]) {
    const f = await setup(t);
    await approveAll(f);
    mutate(f.manifest.assets[0].rights);
    const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
      sourceManifest: f.sourceManifest,
      evidenceRoot: f.evidenceRoot,
    });
    assert.equal(report.status, "blocked");
  }
});

test("changed evidence bytes cannot be hidden by a valid-looking rights manifest", async t => {
  const f = await setup(t);
  await approveAll(f);
  await writeFile(path.join(f.evidenceRoot, "rights-evidence/view-1.txt"), "changed evidence");
  const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
    sourceManifest: f.sourceManifest,
    evidenceRoot: f.evidenceRoot,
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some(value => value.includes("evidence-bytes-rights-evidence/view-1.txt")));
});

test("symlinked local rights evidence cannot satisfy byte verification", async t => {
  const f = await setup(t);
  await approveAll(f);
  const snapshot = f.manifest.assets[0].rights.evidenceSnapshots[0];
  const target = path.join(f.evidenceRoot, snapshot.filename);
  const outside = path.join(f.root, "outside-rights-evidence.txt");
  await writeFile(outside, await readFile(target));
  await rm(target);
  await symlink(outside, target);
  const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
    sourceManifest: f.sourceManifest,
    evidenceRoot: f.evidenceRoot,
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some(value => value.includes("-evidence-bytes-" + snapshot.filename)));
});

test("path traversal, duplicate asset IDs and attempted release promotion are blocked", async t => {
  const f = await setup(t);
  await approveAll(f);
  f.manifest.assets[0].rights.evidenceSnapshots[0].filename = "../outside.txt";
  f.manifest.assets[1].sourceId = f.manifest.assets[0].sourceId;
  f.manifest.releaseFlags.publicationEligible = true;
  const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
    sourceManifest: f.sourceManifest,
    evidenceRoot: f.evidenceRoot,
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("release-flags-false"));
  assert.ok(report.blockers.includes("unique-source-ids"));
});

test("source rights admission does not grant source redistribution or public-display permission", async t => {
  const f = await setup(t);
  await approveAll(f);
  for (const row of f.manifest.assets) {
    row.rights.grantedScopes = [...REQUIRED];
  }
  const report = await validateBrf45ExactAssetRightsAdmission(f.manifest, {
    sourceManifest: f.sourceManifest,
    evidenceRoot: f.evidenceRoot,
  });
  assert.equal(report.status, "rights-admission-complete-human-review-required");
  for (const row of f.manifest.assets) {
    assert.ok(!row.rights.grantedScopes.includes("redistribute-source"));
    assert.ok(!row.rights.grantedScopes.includes("public-display-derived-model"));
  }
});
