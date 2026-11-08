import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { reviewBuildingSource } from "../src/core/building-generation/source-workflow.mjs";
import { createFloorPlanModelCandidate, loadFloorPlanModelCandidate } from "../src/core/building-generation/floor-plan-model-job.mjs";
import {
  getFloorPlanModelReviewStatus,
  publishReviewedFloorPlanModelCandidate,
  reviewFloorPlanModelCandidate,
  REQUIRED_FLOOR_PLAN_REVIEW_CHECKS,
} from "../src/core/building-generation/floor-plan-model-review.mjs";
import { getActivePublishedModels, validatePublishedModelCatalog } from "../src/core/building-generation/published-model-catalog-reader.mjs";
import {
  canonicalFloorPlanPublicationReviewBytes,
  createFloorPlanPublicationReviewSubmission,
} from "../src/core/building-generation/floor-plan-publication-review.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-floor-plan-geometry.json", import.meta.url), "utf8"));
const PDF_BYTES = Buffer.from("%PDF-1.7\nreview lifecycle floor plan fixture\n", "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeWorkspace(t, { approveRights = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await mkdir(path.join(root, "evidence"), { recursive: true });
  await writeFile(path.join(root, "uploads", "floor-plan.pdf"), PDF_BYTES);
  const ingested = await ingestMediaFile({
    workspaceRoot: root,
    sourcePath: "uploads/floor-plan.pdf",
    buildingId: fixture.buildingId,
    sourceId: "measured-plan-pdf",
    kind: "floor-plan",
    licence: "CC BY 4.0",
    usageStatus: "unreviewed",
    title: "Measured floor plan",
  });
  let sourceRecord = ingested.record;
  if (approveRights) {
    const rights = await reviewBuildingSource({
      workspaceRoot: root,
      buildingId: fixture.buildingId,
      sourceId: sourceRecord.id,
      licence: "CC BY 4.0",
      permittedOperations: ["private-media-ingestion", "procedural-model-derivation"],
      confirmRights: true,
      attribution: "Operator-provided permission record",
    });
    sourceRecord = rights.record;
  }
  const floorPlan = {
    ...structuredClone(fixture),
    source: { sourceId: sourceRecord.id, sha256: sourceRecord.sha256 },
  };
  const candidate = await createFloorPlanModelCandidate({ workspaceRoot: root, floorPlan });
  const evidencePath = "evidence/field-measurement-review.json";
  const evidenceBytes = Buffer.from(JSON.stringify({
    purpose: "operator review evidence fixture",
    candidateId: candidate.candidateId,
    sourceSha256: sourceRecord.sha256,
    measuredAt: "2026-10-22",
  }, null, 2) + "\n", "utf8");
  await writeFile(path.join(root, ...evidencePath.split("/")), evidenceBytes);
  return {
    root,
    sourceRecord,
    candidate,
    evidencePath,
    evidenceSha256: hash(evidenceBytes),
  };
}

const publication = {
  modelId: "dhaka-demo-ground-floor",
  modelName: "Dhaka Demo Ground Floor",
  position: { longitude: 90.406, latitude: 23.709, height: 3.5 },
  headingDegrees: 0,
  pitchDegrees: 0,
  rollDegrees: 0,
  scale: 1,
  upAxis: "Y",
  forwardAxis: "Z",
};

function makeTestRegistry(publicKeyPem) {
  const now = Date.now();
  return JSON.stringify({
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "floor-plan-publication-test-registry",
    issuedAtUtc: new Date(now - 60_000).toISOString(),
    expiresAtUtc: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    entries: [{
      reviewerId: "reviewer-operator",
      keyId: "floor-plan-test-key-01",
      status: "active",
      publicKeyPem,
      validFromUtc: "2026-10-01T00:00:00.000Z",
      validUntilUtc: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  });
}

async function makeSignedPublicationReceipt(setup, t) {
  const originalRegistry = process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON = makeTestRegistry(publicKeyPem);
  t.after(() => {
    if (originalRegistry === undefined) delete process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
    else process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON = originalRegistry;
  });

  const directory = path.join(
    setup.root, ".building-engine", "floor-plan-candidates",
    setup.candidate.buildingId, setup.candidate.candidateId,
  );
  const reviewBytes = await readFile(path.join(directory, "review.json"));
  const attestationBytes = await readFile(path.join(directory, "attestation.json"));
  const reviewRecord = JSON.parse(reviewBytes.toString("utf8"));
  const submission = createFloorPlanPublicationReviewSubmission({
    reviewRecord,
    reviewRecordSha256: hash(reviewBytes),
    publicationAttestationSha256: hash(attestationBytes),
  });
  const signatureBase64 = sign(
    null,
    canonicalFloorPlanPublicationReviewBytes(submission),
    keyPair.privateKey,
  ).toString("base64");
  return { submission, signatureBase64 };
}

function reviewInput(setup, decision = "approved", overrides = {}) {
  const checks = Object.fromEntries(REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.map((key) => [key, true]));
  return {
    decision,
    reviewer: "reviewer-operator",
    notes: "Inspected the explicit room trace, openings, metric dimensions and source evidence.",
    checks,
    evidencePath: setup.evidencePath,
    evidenceSha256: setup.evidenceSha256,
    ...(decision === "approved" ? { publication } : {}),
    ...overrides,
  };
}

test("records an immutable approved review and publishes only through the explicit catalog command", async (t) => {
  const setup = await makeWorkspace(t);
  const reviewed = await reviewFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
    input: reviewInput(setup),
    now: "2026-10-22T14:00:00.000Z",
  });
  assert.equal(reviewed.review.decision, "approved");
  assert.equal(reviewed.review.checks.qaReportReviewed, true);
  assert.equal(reviewed.attestationCreated, true);
  assert.equal(reviewed.mapReady, false);
  assert.equal(reviewed.publicationEligible, false);

  const status = await getFloorPlanModelReviewStatus({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
  });
  assert.equal(status.status, "approved");
  assert.equal(status.attestationReady, true);
  assert.equal(status.publication, null);
  assert.equal(status.mapReady, false);
  assert.equal(status.publicationEligible, false);

  const candidateDir = path.join(
    setup.root, ".building-engine", "floor-plan-candidates",
    setup.candidate.buildingId, setup.candidate.candidateId,
  );
  const auditRecord = JSON.parse(await readFile(path.join(candidateDir, "review.json"), "utf8"));
  const attestation = JSON.parse(await readFile(path.join(candidateDir, "attestation.json"), "utf8"));
  assert.equal(auditRecord.candidate.modelSha256, setup.candidate.modelSha256);
  const reportBytes = await readFile(path.join(candidateDir, "report.json"));
  assert.equal(auditRecord.candidate.reportSha256, hash(reportBytes));
  assert.equal(auditRecord.candidate.geometrySha256, setup.candidate.geometrySha256);
  assert.equal(attestation.candidateSha256, setup.candidate.modelSha256);
  assert.equal(attestation.model.id, publication.modelId);
  assert.equal(attestation.review.evidenceSha256, setup.evidenceSha256);
  assert.ok(REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.every((key) => attestation.review.checks[key] === true));

  await assert.rejects(
    reviewFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
      input: reviewInput(setup),
    }),
    (error) => error.code === "REVIEW_ALREADY_RECORDED",
  );

  const reviewReceipt = await makeSignedPublicationReceipt(setup, t);
  const expectedReceiptSha256 = hash(Buffer.from(JSON.stringify(reviewReceipt, null, 2) + "\n", "utf8"));
  const published = await publishReviewedFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
    reviewReceipt,
    publishedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(published.modelId, publication.modelId);
  assert.equal(published.assetUrl.startsWith("/models/generated/"), true);
  assert.equal(published.sha256, setup.candidate.modelSha256);
  assert.equal(published.reviewerAuthentication.signedReviewReceiptSha256, expectedReceiptSha256);
  assert.equal(published.mapReady, false);
  assert.equal(published.publicationEligible, false);

  const repeatedPublish = await publishReviewedFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
    reviewReceipt,
    publishedAt: new Date(Date.now() + 120_000).toISOString(),
  });
  assert.equal(repeatedPublish.alreadyPublished, true);
  assert.equal(repeatedPublish.versionId, published.versionId);
  assert.equal(repeatedPublish.assetUrl, published.assetUrl);

  const manifestPath = path.join(setup.root, "public", "models", "generated", "manifest.json");
  const catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(catalog.models.length, 1);
  assert.equal(getActivePublishedModels(catalog)[0].definition.id, publication.modelId);
  const asset = await readFile(path.join(setup.root, "public", published.assetUrl.slice(1)));
  assert.equal(hash(asset), published.sha256);

  const savedCandidate = await loadFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
  });
  assert.equal(savedCandidate.mapReady, false);
  assert.equal(savedCandidate.publicationEligible, false);

  const finalStatus = await getFloorPlanModelReviewStatus({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
  });
  assert.equal(finalStatus.status, "approved");
  assert.equal(finalStatus.publication.versionId, published.versionId);
  assert.equal(finalStatus.publication.sha256, published.sha256);
});

test("rejected or changes-requested candidates do not receive a publication attestation", async (t) => {
  const setup = await makeWorkspace(t);
  const result = await reviewFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
    input: reviewInput(setup, "changes_requested", {
      checks: Object.fromEntries(REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.map((key) => [key, false])),
    }),
  });
  assert.equal(result.review.decision, "changes_requested");
  assert.equal(result.attestationCreated, false);
  const candidateDir = path.join(
    setup.root, ".building-engine", "floor-plan-candidates",
    setup.candidate.buildingId, setup.candidate.candidateId,
  );
  await assert.rejects(stat(path.join(candidateDir, "attestation.json")), { code: "ENOENT" });
  await assert.rejects(
    publishReviewedFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
    }),
    (error) => error.code === "REVIEW_NOT_APPROVED_OR_STALE",
  );
});

test("approval fails closed until source rights are reviewed before candidate generation", async (t) => {
  const setup = await makeWorkspace(t, { approveRights: false });
  await assert.rejects(
    reviewFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
      input: reviewInput(setup),
    }),
    (error) => error.code === "SOURCE_RIGHTS_NOT_APPROVED",
  );

  await reviewBuildingSource({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    sourceId: setup.sourceRecord.id,
    licence: "CC BY 4.0",
    permittedOperations: ["private-media-ingestion", "procedural-model-derivation"],
    confirmRights: true,
  });
  await assert.rejects(
    reviewFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
      input: reviewInput(setup),
    }),
    (error) => error.code === "CANDIDATE_SOURCE_REVIEW_STALE",
  );
});

test("evidence mismatch and incomplete approval checks do not create review records", async (t) => {
  const setup = await makeWorkspace(t);
  await assert.rejects(
    reviewFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
      input: reviewInput(setup, "approved", { evidenceSha256: "0".repeat(64) }),
    }),
    (error) => error.code === "REVIEW_EVIDENCE_CHECKSUM_MISMATCH",
  );
  await assert.rejects(
    reviewFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
      input: reviewInput(setup, "approved", {
        checks: { ...Object.fromEntries(REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.map((key) => [key, true])), metricScaleVerified: false },
      }),
    }),
    /every floor-plan review check/,
  );
  const candidateDir = path.join(
    setup.root, ".building-engine", "floor-plan-candidates",
    setup.candidate.buildingId, setup.candidate.candidateId,
  );
  await assert.rejects(stat(path.join(candidateDir, "review.json")), { code: "ENOENT" });
});

test("publication refuses review evidence that is modified after approval", async (t) => {
  const setup = await makeWorkspace(t);
  await reviewFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
    input: reviewInput(setup),
  });
  await writeFile(path.join(setup.root, ...setup.evidencePath.split("/")), "tampered after approval");
  await assert.rejects(
    publishReviewedFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
    }),
    /Review evidence SHA-256 does not match/,
  );
  await assert.rejects(
    stat(path.join(setup.root, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("publication refuses geometry or model tampering after review", async (t) => {
  const setup = await makeWorkspace(t);
  await reviewFloorPlanModelCandidate({
    workspaceRoot: setup.root,
    buildingId: setup.candidate.buildingId,
    candidateId: setup.candidate.candidateId,
    input: reviewInput(setup),
  });
  const candidateDir = path.join(
    setup.root, ".building-engine", "floor-plan-candidates",
    setup.candidate.buildingId, setup.candidate.candidateId,
  );
  const planPath = path.join(candidateDir, "floor-plan.json");
  await writeFile(planPath, JSON.stringify({ tampered: true }));
  await assert.rejects(
    publishReviewedFloorPlanModelCandidate({
      workspaceRoot: setup.root,
      buildingId: setup.candidate.buildingId,
      candidateId: setup.candidate.candidateId,
    }),
    /geometry checksum or identity/,
  );
});
