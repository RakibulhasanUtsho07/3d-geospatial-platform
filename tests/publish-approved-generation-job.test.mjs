import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimNextGenerationJob, completeGenerationJob, enqueueGenerationJob, getGenerationJob, updateGenerationJob } from "../src/core/building-generation/generation-job-queue.mjs";
import { reviewGenerationJob, REQUIRED_GENERATION_REVIEW_CHECKS } from "../src/core/building-generation/generation-job-review.mjs";
import { publishApprovedGenerationJob } from "../src/core/building-generation/publish-approved-generation-job.mjs";
import {
  canonicalGenerationJobPublicationReviewBytes,
  createGenerationJobPublicationReviewSubmission,
} from "../src/core/building-generation/generation-job-publication-review.mjs";
import { getActivePublishedModels, validatePublishedModelCatalog } from "../src/core/building-generation/published-model-catalog-reader.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const placement = {
  position: { longitude: 90.406, latitude: 23.7086, height: 12.5 },
  headingDegrees: 0,
  pitchDegrees: 0,
  rollDegrees: 0,
  scale: 1,
  upAxis: "Y",
  forwardAxis: "Z",
  heightReference: "WGS84-ellipsoid",
};

function makeGlb(seed = "publish-test") {
  const payload = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: seed } }));
  const paddedLength = Math.ceil(payload.length / 4) * 4;
  const chunk = Buffer.alloc(paddedLength, 0x20);
  payload.copy(chunk);
  const glb = Buffer.alloc(20 + chunk.length);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(chunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(glb, 20);
  return glb;
}

function makeTestRegistry(publicKeyPem) {
  const now = Date.now();
  return JSON.stringify({
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "d3m02-publication-test-registry",
    issuedAtUtc: new Date(now - 60_000).toISOString(),
    expiresAtUtc: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    entries: [{
      reviewerId: "independent-operator",
      keyId: "d3m02-test-key-01",
      status: "active",
      publicKeyPem,
      validFromUtc: new Date(now - 60_000).toISOString(),
      validUntilUtc: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  });
}

async function makeApprovedJob(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "publish-approved-generation-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const queued = await enqueueGenerationJob({ workspaceRoot, input: { buildingSpec: fixture, strategy: "procedural", sources: [] } });
  await claimNextGenerationJob({ workspaceRoot, workerId: "publish-test-worker" });
  const workflowRelative = path.posix.join(".building-engine", "jobs", fixture.id, queued.jobId + "-workflow");
  const workflowDirectory = path.join(workspaceRoot, ...workflowRelative.split("/"));
  await mkdir(workflowDirectory, { recursive: true });
  const modelBytes = makeGlb();
  const modelPath = path.posix.join(workflowRelative, "model.glb");
  const reportPath = path.posix.join(workflowRelative, "workflow-report.json");
  await writeFile(path.join(workflowDirectory, "model.glb"), modelBytes);
  const report = {
    status: "completed-requires-review",
    output: { modelSha256: hash(modelBytes), modelBytes: modelBytes.length },
    mapReady: false,
    publicationEligible: false,
  };
  await writeFile(path.join(workflowDirectory, "workflow-report.json"), JSON.stringify(report, null, 2));
  await completeGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    result: { status: "completed-requires-review", modelPath, reportPath, modelSha256: hash(modelBytes), modelBytes: modelBytes.length, mapReady: false, publicationEligible: false },
  });
  const checks = Object.fromEntries(REQUIRED_GENERATION_REVIEW_CHECKS.map((key) => [key, true]));
  const reviewed = await reviewGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    input: {
      decision: "approved",
      reviewer: "independent-operator",
      notes: "Reviewed reference imagery, dimensions, scale, georeference and generated QA report.",
      checks,
      placement,
    },
  });

  const originalRegistry = process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON = makeTestRegistry(publicKeyPem);
  t.after(() => {
    if (originalRegistry === undefined) delete process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
    else process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON = originalRegistry;
  });

  const record = reviewed.review;
  const submission = createGenerationJobPublicationReviewSubmission({
    jobId: queued.jobId,
    buildingId: fixture.id,
    reviewRecord: record,
    reviewRecordSha256: reviewed.job.review.recordSha256,
  });
  const signatureBase64 = sign(
    null,
    canonicalGenerationJobPublicationReviewBytes(submission),
    keyPair.privateKey,
  ).toString("base64");
  const reviewReceipt = { submission, signatureBase64 };
  const reviewReceiptPath = path.join(workspaceRoot, "signed-generation-publication-review.json");
  await writeFile(reviewReceiptPath, JSON.stringify(reviewReceipt, null, 2), { mode: 0o600 });
  const privateKeyPath = path.join(workspaceRoot, "test-reviewer-private-key.pem");
  await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });

  return {
    workspaceRoot,
    jobId: queued.jobId,
    modelBytes,
    reviewed,
    reviewReceipt,
    reviewReceiptPath,
    privateKey: keyPair.privateKey,
    privateKeyPath,
  };
}

test("publishes only an approved, hash-matching review with explicit map placement", async (t) => {
  const setup = await makeApprovedJob(t);
  const result = await publishApprovedGenerationJob({ ...setup, placement });
  assert.equal(result.jobId, setup.jobId);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.placement.longitude, placement.position.longitude);
  assert.equal(result.placement.height, placement.position.height);
  assert.equal(result.placementHeightReference, "WGS84-ellipsoid");
  assert.equal(result.placementSha256, setup.reviewed.review.placementSha256);
  assert.match(result.assetUrl, /^\/models\/generated\//);
  const manifestPath = path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json");
  const catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(catalog.models.length, 1);
  const active = getActivePublishedModels(catalog)[0];
  assert.equal(active.definition.id, fixture.id);
  assert.equal(active.sha256, result.modelSha256);
  assert.equal(active.review.reviewer, "independent-operator");
  assert.equal(active.review.authentication.reviewerId, "independent-operator");
  assert.equal(active.review.authentication.keyId, "d3m02-test-key-01");
  assert.equal(active.review.authentication.registryId, "d3m02-publication-test-registry");
  assert.equal(active.review.authentication.scheme, "Ed25519");
  assert.match(active.review.authentication.signedReviewReceiptSha256, /^[a-f0-9]{64}$/);
  const asset = await readFile(path.join(setup.workspaceRoot, "public", result.assetUrl.slice(1)));
  assert.equal(hash(asset), result.modelSha256);
  const unchangedJob = await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId });
  assert.equal(unchangedJob.review.decision, "approved");
  assert.equal(unchangedJob.mapReady, false);
  assert.equal(unchangedJob.publicationEligible, false);
});

test("refuses any publication transform that differs from the immutable approved placement", async (t) => {
  const setup = await makeApprovedJob(t);
  const variants = [
    { position: { ...placement.position, longitude: placement.position.longitude + 0.0001 } },
    { position: { ...placement.position, latitude: placement.position.latitude + 0.0001 } },
    { position: { ...placement.position, height: placement.position.height + 1 } },
    { headingDegrees: 1 },
    { pitchDegrees: 1 },
    { rollDegrees: 1 },
    { scale: 1.01 },
    { upAxis: "X" },
    { forwardAxis: "X" },
  ];
  for (const patch of variants) {
    const candidate = {
      ...placement,
      ...patch,
      position: patch.position ?? placement.position,
    };
    await assert.rejects(
      publishApprovedGenerationJob({ ...setup, placement: candidate }),
      /exactly match the immutable approved review placement/i,
    );
  }
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("refuses publication when the job summary placement digest differs from its immutable review record", async (t) => {
  const setup = await makeApprovedJob(t);
  await updateGenerationJob({
    workspaceRoot: setup.workspaceRoot,
    jobId: setup.jobId,
    update: (state) => {
      state.review.placementSha256 = "0".repeat(64);
    },
  });

  await assert.rejects(
    publishApprovedGenerationJob({ ...setup, placement }),
    /exactly match the immutable approved review placement/i,
  );
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("refuses a legacy approved review record with no placement binding", async (t) => {
  const setup = await makeApprovedJob(t);
  const currentJob = await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId });
  const recordPath = path.join(setup.workspaceRoot, currentJob.review.recordPath);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  delete record.placement;
  delete record.placementSha256;
  const legacyBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
  await writeFile(recordPath, legacyBytes);
  await updateGenerationJob({
    workspaceRoot: setup.workspaceRoot,
    jobId: setup.jobId,
    update: (state) => {
      state.review.recordSha256 = hash(legacyBytes);
      delete state.review.placement;
      delete state.review.placementSha256;
    },
  });

  await assert.rejects(
    publishApprovedGenerationJob({ ...setup, placement }),
    /missing a valid immutable placement binding/i,
  );
  await assert.rejects(
    publishApprovedGenerationJob({
      ...setup,
      placement: { ...placement, heightReference: "EGM96" },
    }),
    /heightReference must be WGS84-ellipsoid/i,
  );
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("refuses publication without placement or without an approved review", async (t) => {
  const setup = await makeApprovedJob(t);
  await assert.rejects(publishApprovedGenerationJob({ ...setup, placement: {} }), /explicit reviewed placement/i);
  const queued = await enqueueGenerationJob({ workspaceRoot: setup.workspaceRoot, input: { buildingSpec: fixture, strategy: "procedural", sources: [] } });
  await assert.rejects(publishApprovedGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: queued.jobId, placement }), /Only completed generation jobs/);
});

test("refuses publication when the approved model or review evidence changes", async (t) => {
  const setup = await makeApprovedJob(t);
  const recordPath = path.join(setup.workspaceRoot, setup.reviewed.job.review.recordPath);
  await writeFile(recordPath, JSON.stringify({ tampered: true }));
  await assert.rejects(publishApprovedGenerationJob({ ...setup, placement }), /review record checksum mismatch/);
});

test("refuses publication if QA report changed since review", async (t) => {
  const setup = await makeApprovedJob(t);
  const job = await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId });
  await writeFile(path.join(setup.workspaceRoot, job.result.reportPath), JSON.stringify({ status: "completed-requires-review", mapReady: false, publicationEligible: false, output: { modelSha256: job.result.modelSha256 } }));
  await assert.rejects(publishApprovedGenerationJob({ ...setup, placement }), /QA report changed after approval/);
});


test("publishes the validated GLB and catalog into a separate application public root", async (t) => {
  const setup = await makeApprovedJob(t);
  const applicationRoot = await mkdtemp(path.join(os.tmpdir(), "publish-approved-app-root-"));
  t.after(() => rm(applicationRoot, { recursive: true, force: true }));

  const result = await publishApprovedGenerationJob({
    ...setup,
    placement,
    publicRoot: applicationRoot,
  });
  const manifestPath = path.join(applicationRoot, "public", "models", "generated", "manifest.json");
  const catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  const active = getActivePublishedModels(catalog)[0];

  assert.equal(active.definition.id, fixture.id);
  assert.equal(active.versionId, result.versionId);
  assert.equal(active.sha256, result.modelSha256);
  assert.equal(hash(await readFile(path.join(applicationRoot, "public", result.assetUrl.slice(1)))), result.modelSha256);
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
});

test("publishes an approved review through the operator CLI with the same WGS84 ellipsoid placement binding", async (t) => {
  const setup = await makeApprovedJob(t);
  const signerPath = path.resolve(process.cwd(), "scripts/sign-approved-generation-job-publication-review.mjs");
  const signedReceiptPath = path.join(setup.workspaceRoot, "cli-signed-publication-review.json");
  const signRun = spawnSync(process.execPath, [
    signerPath,
    setup.workspaceRoot,
    setup.jobId,
    "--private-key", setup.privateKeyPath,
    "--out", signedReceiptPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(signRun.status, 0, signRun.stderr || signRun.stdout);
  const signedReceipt = JSON.parse(await readFile(signedReceiptPath, "utf8"));
  assert.equal(signedReceipt.submission.reviewRecordSha256, setup.reviewed.job.review.recordSha256);

  const cliPath = path.resolve(process.cwd(), "scripts/publish-approved-generation-job.mjs");
  const args = [
    cliPath,
    setup.workspaceRoot,
    setup.jobId,
    "--longitude", String(placement.position.longitude),
    "--latitude", String(placement.position.latitude),
    "--height", String(placement.position.height),
    "--heading", String(placement.headingDegrees),
    "--pitch", String(placement.pitchDegrees),
    "--roll", String(placement.rollDegrees),
    "--scale", String(placement.scale),
    "--up-axis", placement.upAxis,
    "--forward-axis", placement.forwardAxis,
    "--review-receipt", signedReceiptPath,
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "published-reviewed-version");
  assert.equal(payload.placementHeightReference, "WGS84-ellipsoid");
  assert.equal(payload.placementSha256, setup.reviewed.review.placementSha256);
  assert.equal(payload.placement.longitude, placement.position.longitude);
  assert.equal(payload.placement.latitude, placement.position.latitude);
  assert.equal(payload.placement.height, placement.position.height);
  assert.equal(payload.mapReady, false);
  assert.equal(payload.publicationEligible, false);
  const catalogPath = path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json");
  const active = getActivePublishedModels(JSON.parse(await readFile(catalogPath, "utf8")))[0];
  assert.equal(active.sha256, payload.modelSha256);
});


test("requires a trusted signed reviewer receipt before catalog publication", async (t) => {
  const setup = await makeApprovedJob(t);
  const { reviewReceipt: _receipt, ...withoutReceipt } = setup;
  await assert.rejects(
    publishApprovedGenerationJob({ ...withoutReceipt, placement }),
    /signed generation-job review receipt must contain exactly submission and signatureBase64/,
  );
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("rejects a tampered or untrusted generation-job reviewer signature", async (t) => {
  const setup = await makeApprovedJob(t);
  const badReceipt = structuredClone(setup.reviewReceipt);
  badReceipt.signatureBase64 = Buffer.alloc(64, 0).toString("base64");
  await assert.rejects(
    publishApprovedGenerationJob({ ...setup, placement, reviewReceipt: badReceipt }),
    /Ed25519 signature is invalid/,
  );

  const untrusted = generateKeyPairSync("ed25519");
  const untrustedPublicKey = untrusted.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON = makeTestRegistry(untrustedPublicKey);
  await assert.rejects(
    publishApprovedGenerationJob({ ...setup, placement }),
    /Ed25519 signature is invalid/,
  );
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("rejects a signed receipt that substitutes a different placement or review-record hash", async (t) => {
  const setup = await makeApprovedJob(t);
  const altered = structuredClone(setup.reviewReceipt);
  altered.submission.placementSha256 = "0".repeat(64);
  altered.signatureBase64 = sign(
    null,
    canonicalGenerationJobPublicationReviewBytes(altered.submission),
    setup.privateKey,
  ).toString("base64");
  await assert.rejects(
    publishApprovedGenerationJob({ ...setup, placement, reviewReceipt: altered }),
    /bind the exact immutable review record, GLB, QA report, placement, reviewer and timestamp/,
  );
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("refuses a second publication while the model catalog lock is held", async (t) => {
  const setup = await makeApprovedJob(t);
  const catalogLockDirectory = path.join(setup.workspaceRoot, ".generated-model-catalog.publish.lock");
  await mkdir(catalogLockDirectory, { recursive: true });

  await assert.rejects(
    publishApprovedGenerationJob({ ...setup, placement }),
    /publication is already in progress/,
  );
  await assert.rejects(
    readFile(path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json")),
    { code: "ENOENT" },
  );
});
