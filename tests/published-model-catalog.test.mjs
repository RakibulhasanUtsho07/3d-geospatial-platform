import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activatePublishedModelVersion,
  getActivePublishedModels,
  publishReviewedBuildingModel,
  validatePublishedModelCatalog,
} from "../src/core/building-generation/published-model-catalog.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeGlb(seed = "") {
  const payload = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: seed || "test-fixture" } }));
  const paddedLength = Math.ceil(payload.length / 4) * 4;
  const jsonChunk = Buffer.alloc(paddedLength, 0x20);
  payload.copy(jsonChunk);
  const bytes = Buffer.alloc(20 + jsonChunk.length);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonChunk.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(bytes, 20);
  return bytes;
}

function validCatalog() {
  const bytes = makeGlb();
  const sha256 = hash(bytes);
  const review = {
    reviewer: "reviewer-id",
    reviewedAt: "2026-10-22T10:00:00.000Z",
    evidenceId: "review-package-001",
    evidenceSha256: "a".repeat(64),
    checks: {
      rightsVerified: true,
      sourceIdentityVerified: true,
      architectureReviewed: true,
      metricScaleVerified: true,
      horizontalGeoreferenceVerified: true,
      verticalDatumVerified: true,
    },
    notes: "Independent dimensions and placement reviewed.",
  };
  const version = {
    versionId: "a".repeat(16),
    url: "/models/generated/demo-" + sha256.slice(0, 12) + ".glb",
    sha256,
    bytes: bytes.length,
    publishedAt: "2026-10-22T10:01:00.000Z",
    position: { longitude: 90.406, latitude: 23.7086, height: 0 },
    headingDegrees: 0,
    pitchDegrees: 0,
    rollDegrees: 0,
    scale: 1,
    upAxis: "Y",
    forwardAxis: "Z",
    review,
  };
  return { schemaVersion: "1.0.0", models: [{ id: "demo-building", name: "Demo building", activeVersion: version.versionId, versions: [version] }] };
}

test("validates an empty publication catalog", () => {
  assert.deepEqual(validatePublishedModelCatalog({ schemaVersion: "1.0.0", models: [] }), {
    schemaVersion: "1.0.0",
    models: [],
  });
});

test("normalizes the active published version for the map", () => {
  const catalog = validCatalog();
  const [active] = getActivePublishedModels(catalog);
  assert.equal(active.definition.id, "demo-building");
  assert.equal(active.definition.url, catalog.models[0].versions[0].url);
  assert.deepEqual(active.definition.position, { longitude: 90.406, latitude: 23.7086, height: 0 });
  assert.equal(active.versionId, catalog.models[0].activeVersion);
  assert.equal(active.sha256, catalog.models[0].versions[0].sha256);
  assert.equal(active.review.reviewer, "reviewer-id");
});

test("rejects an unpublished/invalid review, unsafe URL and invalid active version", () => {
  const base = validCatalog();
  const falseReview = structuredClone(base);
  falseReview.models[0].versions[0].review.checks.horizontalGeoreferenceVerified = false;
  assert.throws(() => validatePublishedModelCatalog(falseReview), /horizontalGeoreferenceVerified/);

  const unsafeUrl = structuredClone(base);
  unsafeUrl.models[0].versions[0].url = "/models/generated/../private.glb";
  assert.throws(() => validatePublishedModelCatalog(unsafeUrl), /url/);

  const missingActive = structuredClone(base);
  missingActive.models[0].activeVersion = "b".repeat(16);
  assert.throws(() => validatePublishedModelCatalog(missingActive), /activeVersion/);

  const invalidHash = structuredClone(base);
  invalidHash.models[0].versions[0].sha256 = "not-a-hash";
  assert.throws(() => validatePublishedModelCatalog(invalidHash), /sha256/);
});

test("rejects duplicate model IDs and invalid placement ranges", () => {
  const duplicate = validCatalog();
  duplicate.models.push(structuredClone(duplicate.models[0]));
  assert.throws(() => validatePublishedModelCatalog(duplicate), /Duplicate published model id/);

  const invalidPosition = validCatalog();
  invalidPosition.models[0].versions[0].position.longitude = 181;
  assert.throws(() => validatePublishedModelCatalog(invalidPosition), /Longitude/);
});

test("publishes a candidate with matching checksums, preserves versions and supports verified rollback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "published-model-catalog-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const candidateDir = path.join(root, ".building-engine", "jobs", "demo");
  const reviewDir = path.join(root, "review");
  await mkdir(candidateDir, { recursive: true });
  await mkdir(reviewDir, { recursive: true });

  const candidatePath = path.join(candidateDir, "model.glb");
  const evidencePath = path.join(reviewDir, "independent-review.json");
  const attestationPath = path.join(reviewDir, "attestation.json");
  const evidence = JSON.stringify({ reviewed: true, report: "independent inspection record" });
  await writeFile(evidencePath, evidence);
  let glb = makeGlb("first");
  await writeFile(candidatePath, glb);
  const checks = {
    rightsVerified: true,
    sourceIdentityVerified: true,
    architectureReviewed: true,
    metricScaleVerified: true,
    horizontalGeoreferenceVerified: true,
    verticalDatumVerified: true,
  };
  const makeAttestation = (bytes, reviewNote) => ({
    schemaVersion: "1.0.0",
    candidateSha256: hash(bytes),
    model: {
      id: "test-building",
      name: "Test building",
      position: { longitude: 90.406, latitude: 23.7086, height: 0 },
      headingDegrees: 0,
      scale: 1,
      upAxis: "Y",
      forwardAxis: "Z",
    },
    review: {
      reviewer: "reviewer-id",
      reviewedAt: "2026-10-22T10:00:00.000Z",
      evidenceId: "independent-review-001",
      evidencePath: "review/independent-review.json",
      evidenceSha256: hash(Buffer.from(evidence)),
      checks,
      notes: reviewNote,
    },
  });
  await writeFile(attestationPath, JSON.stringify(makeAttestation(glb, "First independent review."), null, 2));

  const first = await publishReviewedBuildingModel({
    workspaceRoot: root,
    candidatePath: ".building-engine/jobs/demo/model.glb",
    attestationPath: "review/attestation.json",
    publishedAt: "2026-10-22T10:02:00.000Z",
  });
  assert.equal(first.modelId, "test-building");
  assert.match(first.assetUrl, /^\/models\/generated\/test-building-[a-f0-9]{12}\.glb$/);
  assert.equal(hash(await readFile(path.join(root, "public", first.assetUrl.slice(1))), first.sha256);
  const manifestPath = path.join(root, "public", "models", "generated", "manifest.json");
  let catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(catalog.models[0].versions.length, 1);
  const firstVersion = first.versionId;

  glb = makeGlb("second");
  await writeFile(candidatePath, glb);
  await writeFile(attestationPath, JSON.stringify(makeAttestation(glb, "Second independent review."), null, 2));
  const second = await publishReviewedBuildingModel({
    workspaceRoot: root,
    candidatePath: ".building-engine/jobs/demo/model.glb",
    attestationPath: "review/attestation.json",
    publishedAt: "2026-10-22T10:03:00.000Z",
  });
  assert.notEqual(firstVersion, second.versionId);

  catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(catalog.models[0].versions.length, 2);
  assert.equal(catalog.models[0].activeVersion, second.versionId);
  assert.equal(getActivePublishedModels(catalog)[0].versionId, second.versionId);

  const rollback = await activatePublishedModelVersion({
    workspaceRoot: root,
    modelId: "test-building",
    versionId: firstVersion,
  });
  assert.equal(rollback.versionId, firstVersion);
  assert.equal(getActivePublishedModels(JSON.parse(await readFile(manifestPath, "utf8")))[0].versionId, firstVersion);
});

test("refuses mismatched candidate hashes, unverified checks and tampered review evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "published-model-reject-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "review"), { recursive: true });
  const bytes = makeGlb();
  await writeFile(path.join(root, "candidate.glb"), bytes);
  await writeFile(path.join(root, "review", "evidence.json"), "{}");
  const base = {
    schemaVersion: "1.0.0",
    candidateSha256: hash(bytes),
    model: {
      id: "test-model",
      name: "Test model",
      position: { longitude: 0, latitude: 0, height: 0 },
    },
    review: {
      reviewer: "reviewer",
      reviewedAt: "2026-10-22T10:00:00.000Z",
      evidencePath: "review/evidence.json",
      evidenceSha256: hash(Buffer.from("{}")),
      checks: {
        rightsVerified: true,
        sourceIdentityVerified: true,
        architectureReviewed: true,
        metricScaleVerified: true,
        horizontalGeoreferenceVerified: true,
        verticalDatumVerified: true,
      },
      notes: "Verified by a human reviewer.",
    },
  };
  await writeFile(path.join(root, "review", "attestation.json"), JSON.stringify({ ...base, candidateSha256: "0".repeat(64) }));
  await assert.rejects(publishReviewedBuildingModel({
    workspaceRoot: root, candidatePath: "candidate.glb", attestationPath: "review/attestation.json",
  }), /candidateSha256/);

  const noGeo = structuredClone(base);
  noGeo.review.checks.horizontalGeoreferenceVerified = false;
  await writeFile(path.join(root, "review", "attestation.json"), JSON.stringify(noGeo));
  await assert.rejects(publishReviewedBuildingModel({
    workspaceRoot: root, candidatePath: "candidate.glb", attestationPath: "review/attestation.json",
  }), /horizontalGeoreferenceVerified/);

  await writeFile(path.join(root, "review", "attestation.json"), JSON.stringify(base));
  await writeFile(path.join(root, "review", "evidence.json"), "tampered");
  await assert.rejects(publishReviewedBuildingModel({
    workspaceRoot: root, candidatePath: "candidate.glb", attestationPath: "review/attestation.json",
  }), /Review evidence SHA-256/);
});

test("refuses a version activation after the published asset has been tampered with", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "published-model-integrity-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "public", "models", "generated"), { recursive: true });
  const catalog = validCatalog();
  const version = catalog.models[0].versions[0];
  const assetPath = path.join(root, "public", version.url.slice(1));
  await mkdir(path.dirname(assetPath), { recursive: true });
  const bytes = makeGlb();
  version.sha256 = hash(bytes);
  version.bytes = bytes.length;
  version.url = "/models/generated/demo-" + version.sha256.slice(0, 12) + ".glb";
  await writeFile(assetPath, bytes);
  await writeFile(path.join(root, "public", "models", "generated", "manifest.json"), JSON.stringify(catalog));
  await writeFile(assetPath, Buffer.from("tampered"));
  await assert.rejects(activatePublishedModelVersion({
    workspaceRoot: root,
    modelId: "demo-building",
    versionId: version.versionId,
  }), /checksum mismatch/);
});
