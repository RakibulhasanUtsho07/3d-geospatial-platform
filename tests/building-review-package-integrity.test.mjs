import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile, mkdtemp, mkdir, rm, writeFile, symlink, truncate } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";
import { buildBuildingReviewPackageManifest } from "../src/core/building-generation/building-review-package.mjs";
import { verifyBuildingReviewPackage } from "../src/core/building-generation/building-review-package-integrity.mjs";
import { verifyBuildingReviewPackageDirectory } from "../src/core/building-generation/building-review-package-directory.mjs";
import { createExternalTrustRegistryGovernanceStateStore } from "../src/core/building-generation/trust-registry-governance-external-store.mjs";
import { readStableSingleImageSurveyObservationRecord } from "../src/core/building-generation/single-image-review-package-evidence.mjs";
import {
  buildSingleImageSurveyObservationRecordInventory,
  singleImageSurveyObservationRecordPath,
  MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
} from "../src/core/building-generation/single-image-survey-observation-records.mjs";
import {
  createSingleImageGeoreferenceEvidence,
  loadSingleImageControlPointManifest,
} from "../src/core/building-generation/single-image-georeference-evidence.mjs";
import { canonicalJson } from "../src/core/building-generation/generation-artifact-receipt.mjs";
import {
  buildSurveyObservationAttributionInventory,
  createSurveyObservationAttributionAttestation,
  surveyObservationAttributionAttestationPath,
} from "../src/core/building-generation/survey-observation-attribution-attestation.mjs";
import {
  signBuildingReviewPackageManifest,
  signBuildingReviewPackageManifestWithTrustedRegistry,
} from "../src/core/building-generation/building-review-package-signature.mjs";
import {
  buildSurveyObservationDeviceAttestationInventory,
  createSurveyObservationDeviceAttestation,
  surveyObservationDeviceAttestationPath,
} from "../src/core/building-generation/survey-observation-device-attestation.mjs";
import {
  surveyDeviceEnrollmentEvidencePath,
  surveyDeviceEnrollmentEvidenceSigningBytes,
  SURVEY_DEVICE_ENROLLMENT_EVIDENCE_NOTE,
} from "../src/core/building-generation/survey-device-enrollment-evidence.mjs";
import { buildSurveyDeviceEnrollmentEvidenceInventory } from "../src/core/building-generation/survey-device-enrollment-evidence-inventory.mjs";
import { buildTrustRegistrySnapshotInventory } from "../src/core/building-generation/trust-registry-snapshot.mjs";
import {
  signTrustRegistryGovernanceAttestation,
  verifyTrustRegistryGovernanceAttestation,
} from "../src/core/building-generation/trust-registry-governance-attestation.mjs";


const hash = (value) => createHash("sha256").update(value).digest("hex");
const semanticDigest = (value) => hash(Buffer.from(JSON.stringify(value)));
const JSON_BYTES = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const EARTH_RADIUS_M = 6378137;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNED_VERIFY_CLI = path.join(REPO_ROOT, "scripts/verify-signed-building-review-package.mjs");
const REVIEWER_REGISTRY_ENV = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";

function fakePng(width, height, label) {
  const suffix = Buffer.from(label);
  const bytes = Buffer.alloc(24 + suffix.length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  suffix.copy(bytes, 24);
  return bytes;
}

function fakeJpeg(width, height, label) {
  const suffix = Buffer.from(label);
  const bytes = Buffer.alloc(24 + suffix.length);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xc0;
  bytes.writeUInt16BE(17, 4);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  suffix.copy(bytes, 24);
  return bytes;
}

function makeAccuracyEvidence(candidateHash, geometryQa) {
  const dimensions = geometryQa.bounds.dimensions;
  const latitudeOrigin = 23.7;
  const longitudeOrigin = 90.4;
  const latitudeOriginRadians = latitudeOrigin * Math.PI / 180;
  const lonLatFromLocal = (east, north) => ({
    longitude: (longitudeOrigin + east / (EARTH_RADIUS_M * Math.cos(latitudeOriginRadians)) * 180 / Math.PI + 540) % 360 - 180,
    latitude: latitudeOrigin + north / EARTH_RADIUS_M * 180 / Math.PI,
  });
  const controlPoints = [
    [0, 0], [dimensions[0], 0], [0, dimensions[2]], [dimensions[0], dimensions[2]],
  ].map(([modelX, modelZ], index) => ({
    id: "package-gcp-" + (index + 1),
    modelX,
    modelZ,
    ...lonLatFromLocal(modelX * 2.5 + 100, modelZ * 2.5 + 200),
    evidenceSourceId: "survey-record-package-test",
  }));
  return {
    generatedAt: "2026-10-21T12:00:00Z",
    dimensionReference: {
      referenceDimensionsM: { x: dimensions[0], y: dimensions[1], z: dimensions[2] },
      metresPerModelUnit: 1,
      tolerancePercent: 1,
      evidence: {
        basis: "surveyed",
        referenceId: "package-survey-fixture",
        sourceDescription: "Independent dimensions in package integrity fixture.",
      },
    },
    groundControl: {
      modelCoordinatesGlbSha256: candidateHash,
      coordinateEvidenceBasis: "surveyed",
      sourceDescription: "Horizontal survey control fixture bound to this exact GLB.",
      controlPoints,
      maxRmsErrorM: 0.5,
      maxResidualM: 1,
    },
  };
}

async function createFixture() {
  const spec = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
  const { glb } = generateProceduralGlb(spec);
  const candidateHash = hash(glb);
  const geometryQa = analyzeGlbQuality(glb);
  const textureQa = reviewGlbTextureBindings(glb);
  const accuracyEvidence = makeAccuracyEvidence(candidateHash, geometryQa);
  const referenceBuffers = new Map();
  const renderBuffers = new Map();
  const views = REQUIRED_REVIEW_VIEWS.map((id) => {
    const filename = id + ".png";
    const bytes = fakePng(512, 512, "fake-render-payload:" + id);
    renderBuffers.set(id, { filename, bytes, sha256: hash(bytes), width: 512, height: 512 });
    return {
      id, filename, width: 512, height: 512, bytes: bytes.length,
      sha256: hash(bytes), renderComplete: true,
      pixelStatistics: { luminanceMean: 0.4, luminanceStandardDeviation: 0.15, transparentRatio: 0, sampledPixels: 1000 },
    };
  });
  const renderManifest = {
    schemaVersion: "1.0.0",
    engine: "building-render-review-manifest-v1",
    status: "render-set-ready-for-human-review",
    valid: true,
    publicationEligible: false,
    modelSha256: candidateHash,
    renderer: "Blender",
    rendererVersion: "4.x-test",
    renderResolution: { width: 512, height: 512 },
    sceneBounds: { min: [0, 0, 0], max: [1, 1, 1], dimensions: [1, 1, 1] },
    counts: { requiredViews: REQUIRED_REVIEW_VIEWS.length, generatedViews: views.length, errors: 0, warnings: 0 },
    views, warnings: [], errors: [],
  };
  const manifestBytes = JSON_BYTES(renderManifest);
  const manifestHash = hash(manifestBytes);
  const referenceImages = REQUIRED_REVIEW_VIEWS.map((viewId) => {
    const id = "reference-" + viewId;
    const filename = id + ".jpg";
    const bytes = fakeJpeg(512, 512, "fake-reference-payload:" + viewId);
    const reference = {
      id, filename, sha256: hash(bytes), width: 512, height: 512, bytes: bytes.length,
      sourceDescription: "Independently supplied test reference for " + viewId,
      sourceUrl: "https://example.invalid/" + filename,
      attribution: "Test fixture",
      rightsStatus: "verified",
      facadeLabel: viewId,
      captureHeadingDegrees: 0,
      captureHeadingBasis: "measured",
    };
    referenceBuffers.set(id, { ...reference, content: bytes });
    return reference;
  });
  const comparisons = REQUIRED_REVIEW_VIEWS.map((viewId) => {
    const view = views.find((item) => item.id === viewId);
    const reference = referenceImages.find((item) => item.id === "reference-" + viewId);
    return {
      viewId,
      renderFilename: view.filename,
      renderSha256: view.sha256,
      referenceImageId: reference.id,
      referenceSha256: reference.sha256,
      comparisonBasis: "same-facade-known",
      outcome: "match",
      reviewer: "test-reviewer",
      reviewedAt: "2026-10-21T12:00:00Z",
      notes: "Fixture-only human review metadata used to exercise package integrity.",
      correctionRequest: null,
    };
  });
  const review = {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: "integrity-test-building",
    reviewStatus: "reviewer-reported-matches",
    valid: true,
    publicationEligible: false,
    provenance: { renderManifestSha256: manifestHash, sourceModelSha256: candidateHash, renderManifestStatus: renderManifest.status, referenceImageCount: referenceImages.length },
    counts: { renderViewCount: views.length, referenceImageCount: referenceImages.length, comparisonCount: comparisons.length, match: comparisons.length, partial: 0, mismatch: 0, notComparable: 0, pending: 0, viewsWithoutComparisons: 0, errors: 0, warnings: 0 },
    referenceImages, comparisons, viewsWithoutComparisons: [], errors: [], warnings: [],
    limitations: ["Human-reported fixture judgements only."],
  };
  const backlog = {
    schemaVersion: "1.0.0",
    engine: "render-review-correction-tasks-v1",
    buildingId: review.buildingId,
    sourceReviewStatus: "needs-model-or-reference-correction",
    createdFromReviewReportSha256: hash(Buffer.from("older-review-report")),
    provenance: { sourceModelSha256: "a".repeat(64), renderManifestSha256: "b".repeat(64) },
    counts: { total: 0, open: 0, highPriority: 0, mediumPriority: 0, byKind: {} },
    tasks: [],
    automationPolicy: { publicationEligible: false },
  };
  // These hash fields describe the exact QA report-file bytes used by the package builder.
  const correctionArtifactEvidence = {
    validated: true,
    candidateGlbSha256: candidateHash,
    renderManifestSha256: manifestHash,
    geometryQaReportSha256: hash(JSON_BYTES(geometryQa)),
    textureQaReportSha256: hash(JSON_BYTES(textureQa)),
    qaReportsRecomputedFromCandidateModel: true,
  };
  // The fixture uses an empty backlog; any non-empty backlog must have file-backed evidence for every correction task.
  const verification = verifyRenderCorrectionTasks(backlog, review, correctionArtifactEvidence);
  const actualRenderFiles = views.map((view) => ({
    filename: view.filename,
    sha256: renderBuffers.get(view.id).sha256,
    width: 512, height: 512, bytes: renderBuffers.get(view.id).bytes.length,
  }));
  const readiness = buildBuildingReleaseReadiness({
    buildingId: review.buildingId,
    candidateGlbSha256: candidateHash,
    renderManifest,
    renderManifestSha256: manifestHash,
    actualRenderFiles,
    geometryQa, textureQa,
    renderReferenceReview: review,
    correctionTaskBacklog: backlog,
    correctionVerification: verification,
    correctionArtifactEvidence,
    accuracyEvidence,
  });

  const artifactInputs = [];
  const add = (artifactType, relativePath, bytes, metadata = {}, contentObject = null, objectDigest = false) => {
    artifactInputs.push({
      artifactType,
      relativePath,
      sha256: hash(bytes),
      bytes: bytes.length,
      content: bytes,
      ...metadata,
      ...(objectDigest && contentObject ? { contentDigest: semanticDigest(contentObject) } : {}),
    });
  };
  add("candidate-glb", "model/candidate.glb", glb);
  add("geometry-qa", "reports/geometry-qa.json", JSON_BYTES(geometryQa), {}, geometryQa, true);
  add("texture-qa", "reports/texture-qa.json", JSON_BYTES(textureQa), {}, textureQa, true);
  add("render-manifest", "renders/render-review-manifest.json", manifestBytes, {}, renderManifest, true);
  add("render-reference-review", "reports/render-reference-review.json", JSON_BYTES(review), {}, review, true);
  add("correction-task-backlog", "reports/correction-tasks.json", JSON_BYTES(backlog), {}, backlog, true);
  add("correction-verification", "reports/correction-verification.json", JSON_BYTES(verification), {}, verification, true);
  add("accuracy-evidence", "reports/accuracy-evidence.json", JSON_BYTES(accuracyEvidence), {}, accuracyEvidence, true);
  add("release-readiness-report", "reports/release-readiness.json", JSON_BYTES(readiness), {}, readiness, true);
  for (const view of views) {
    const actual = renderBuffers.get(view.id);
    add("render-image", "renders/" + view.filename, actual.bytes, {
      viewId: view.id, width: actual.width, height: actual.height,
    });
  }
  for (const reference of referenceImages) {
    const actual = referenceBuffers.get(reference.id);
    add("reference-image", "references/" + hash(Buffer.from(reference.id)).slice(0, 12) + "-" + reference.filename,
      actual.content, {
        referenceImageId: reference.id, rightsStatus: reference.rightsStatus,
        width: reference.width, height: reference.height,
      });
  }
  const readme = Buffer.from("# Building Review Package\n\nHuman review only.\n");
  add("review-instructions", "README.md", readme);

  // Raw manifest SHA is the render manifest's on-disk byte hash, while its
  // contentDigest remains a semantic JSON digest as required for JSON reports.
  const packageArtifacts = artifactInputs.map(({ content, ...descriptor }) => descriptor);
  const packageManifest = buildBuildingReviewPackageManifest({
    buildingId: review.buildingId,
    readinessReport: readiness,
    renderManifestViews: views,
    artifacts: packageArtifacts,
    generatedAt: "2026-10-21T12:00:00Z",
  });
  const actualFiles = artifactInputs.map((artifact) => ({
    relativePath: artifact.relativePath,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    content: artifact.content,
    isRegularFile: true,
    ...(artifact.width ? { width: artifact.width, height: artifact.height } : {}),
  }));
  return { packageManifest, actualFiles };
}

test("verifies intact package files and recomputes geometry/texture QA from candidate GLB bytes", async () => {
  const { packageManifest, actualFiles } = await createFixture();
  const manifestBytes = JSON_BYTES(packageManifest);
  const report = verifyBuildingReviewPackage({
    packageManifest, actualFiles, packageManifestSha256: hash(manifestBytes),
  });
  assert.equal(report.status, "verified");
  assert.equal(report.valid, true);
  assert.equal(report.counts.errors, 0);
  assert.equal(report.publicationEligible, false);
  assert.ok(report.checks.some((item) => item.id === "candidate-geometry-recomputed" && item.status === "passed"));
  assert.ok(report.checks.some((item) => item.id === "candidate-texture-recomputed" && item.status === "passed"));
});

test("detects modified artifact bytes", async () => {
  const { packageManifest, actualFiles } = await createFixture();
  const file = actualFiles.find((item) => item.relativePath === "renders/front.png");
  file.content = Buffer.concat([file.content, Buffer.from("changed")]);
  const report = verifyBuildingReviewPackage({
    packageManifest, actualFiles, packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(report.status, "tampered-or-invalid");
  assert.ok(report.errors.some((item) => item.id === "file-sha256:renders/front.png"));
  assert.ok(report.errors.some((item) => item.id === "file-size:renders/front.png"));
});

test("detects missing files, unlisted extras and unverified reference rights", async () => {
  const { packageManifest, actualFiles } = await createFixture();
  const altered = actualFiles.filter((item) => item.relativePath !== "renders/back.png");
  altered.push({ relativePath: "extra.txt", content: Buffer.from("extra"), bytes: 5, isRegularFile: true });
  const ref = packageManifest.artifacts.find((item) => item.artifactType === "reference-image");
  ref.rightsStatus = "pending";
  const report = verifyBuildingReviewPackage({
    packageManifest, actualFiles: altered, packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(report.status, "tampered-or-invalid");
  assert.ok(report.errors.some((item) => item.id === "file-present:renders/back.png"));
  assert.ok(report.errors.some((item) => item.id === "no-extra-file:extra.txt"));
  assert.ok(report.errors.some((item) => item.id.startsWith("reference-rights:")));
});

test("detects JSON content-digest changes and refuses unsafe manifest entries", async () => {
  const { packageManifest, actualFiles } = await createFixture();
  const file = actualFiles.find((item) => item.relativePath === "reports/geometry-qa.json");
  file.content = JSON_BYTES({ schemaVersion: "1.0.0", engine: "forged-report", valid: true });
  const report = verifyBuildingReviewPackage({
    packageManifest, actualFiles, packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(report.status, "tampered-or-invalid");
  assert.ok(report.errors.some((item) => item.id === "file-sha256:reports/geometry-qa.json"));
  assert.ok(report.errors.some((item) => item.id === "json-content-digest:reports/geometry-qa.json"));

  const unsafe = await createFixture();
  unsafe.packageManifest.artifacts[0].relativePath = "../outside.glb";
  const unsafeReport = verifyBuildingReviewPackage({
    packageManifest: unsafe.packageManifest,
    actualFiles: unsafe.actualFiles,
    packageManifestSha256: hash(JSON_BYTES(unsafe.packageManifest)),
  });
  assert.equal(unsafeReport.valid, false);
  assert.ok(unsafeReport.errors.some((item) => item.id === "manifest-artifact:0"));
});


test("rejects a partial single-image evidence group when the signed package metadata is absent", async () => {
  const { packageManifest, actualFiles } = await createFixture();
  const bytes = Buffer.from("partial-smoke-report");
  packageManifest.artifacts.push({
    artifactType: "single-image-smoke-report",
    relativePath: "reports/single-image-runtime-smoke.json",
    sha256: hash(bytes),
    bytes: bytes.length,
  });
  actualFiles.push({
    relativePath: "reports/single-image-runtime-smoke.json",
    sha256: hash(bytes),
    bytes: bytes.length,
    content: bytes,
    isRegularFile: true,
  });
  const report = verifyBuildingReviewPackage({
    packageManifest,
    actualFiles,
    packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.id === "single-image-evidence-group-absent-or-complete"));
});


test("combined verifier accepts a fully materialized signed package and rejects later artifact tampering", async (t) => {
  const { packageManifest, actualFiles } = await createFixture();
  const parent = await mkdtemp(path.join(os.tmpdir(), "d3m12-combined-verifier-"));
  const packageDir = path.join(parent, "review-package");
  await mkdir(packageDir, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));

  for (const file of actualFiles) {
    const destination = path.join(packageDir, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: "wx" });
  }
  const manifestBytes = JSON_BYTES(packageManifest);
  await writeFile(path.join(packageDir, "package-manifest.json"), manifestBytes, { flag: "wx" });

  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const now = Date.now();
  const iso = (offset) => new Date(now + offset).toISOString();
  const trustedRegistry = {
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "combined-verifier-test-registry",
    issuedAtUtc: iso(-60_000),
    expiresAtUtc: iso(86_400_000),
    entries: [{
      reviewerId: "combined-verifier-reviewer",
      keyId: "combined-verifier-key",
      status: "active",
      publicKeyPem,
      validFromUtc: iso(-60_000),
      validUntilUtc: iso(86_400_000),
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  const registryJson = JSON.stringify(trustedRegistry);
  const envelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes,
    privateKeyPem,
    reviewerId: "combined-verifier-reviewer",
    trustedReviewerRegistry: trustedRegistry,
    signedAt: iso(0),
  });
  await writeFile(
    path.join(packageDir, "package-manifest.sig.json"),
    JSON.stringify(envelope, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );

  const runVerifier = (extraArgs = [], env = { ...process.env, NODE_ENV: "production", [REVIEWER_REGISTRY_ENV]: registryJson }) => spawnSync(
    process.execPath,
    [SIGNED_VERIFY_CLI, packageDir, ...extraArgs],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env },
  );
  const intact = runVerifier();
  assert.equal(intact.status, 0, intact.stderr);
  const intactSummary = JSON.parse(intact.stdout);
  assert.equal(intactSummary.status, "verified");
  assert.equal(intactSummary.valid, true);
  assert.equal(intactSummary.packageIntegrity, "verified");
  assert.equal(intactSummary.signature, "signature-verified");
  assert.equal(intactSummary.publicationEligible, false);
  assert.equal(intactSummary.mapReady, false);

  // Exercise the explicit legacy v1 combined-verifier path with a key file
  // outside the package directory; the verifier must use the stable key reader.
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  await rm(signaturePath);
  const legacyEnvelope = signBuildingReviewPackageManifest({
    manifestBytes,
    privateKeyPem,
    signedAt: iso(0),
  });
  await writeFile(signaturePath, JSON.stringify(legacyEnvelope, null, 2) + "\n", { flag: "wx" });
  const legacyPublicKeyPath = path.join(parent, "legacy-trusted-public.pem");
  await writeFile(legacyPublicKeyPath, publicKeyPem, { flag: "wx", mode: 0o600 });
  const legacyVerified = runVerifier(
    ["--legacy-public-key", legacyPublicKeyPath],
    { ...process.env, NODE_ENV: "production" },
  );
  assert.equal(legacyVerified.status, 0, legacyVerified.stderr);
  const legacySummary = JSON.parse(legacyVerified.stdout);
  assert.equal(legacySummary.valid, true);
  assert.equal(legacySummary.signature, "signature-verified");
  assert.equal(legacySummary.status, "verified");

  const candidateImage = path.join(packageDir, "renders", "front.png");
  await writeFile(candidateImage, Buffer.from("tampered"), { flag: "a" });
  const tampered = runVerifier(
    ["--legacy-public-key", legacyPublicKeyPath],
    { ...process.env, NODE_ENV: "production" },
  );
  assert.equal(tampered.status, 2, tampered.stderr);
  const tamperedSummary = JSON.parse(tampered.stdout);
  assert.equal(tamperedSummary.valid, false);
  assert.equal(tamperedSummary.signature, "signature-verified");
  assert.equal(tamperedSummary.packageIntegrity, "tampered-or-invalid");
});


function makeHeldOutManifest(sourceSha256) {
  const theta = 30 * Math.PI / 180;
  const scale = 2.5;
  const baseLongitude = 90.4;
  const baseLatitude = 23.7;
  const earthRadius = 6378137;
  const lonLat = (east, north) => ({
    longitude: baseLongitude + east / (earthRadius * Math.cos(baseLatitude * Math.PI / 180)) * 180 / Math.PI,
    latitude: baseLatitude + north / earthRadius * 180 / Math.PI,
  });
  const fitModel = [[-10, -8], [10, -8], [10, 8], [-10, 8]];
  const controlPoints = fitModel.map(([modelX, modelZ], index) => ({
    id: "fit-gcp-" + (index + 1),
    observationId: "fit-observation-" + (index + 1),
    modelX,
    modelZ,
    ...lonLat(
      scale * (Math.cos(theta) * modelX - Math.sin(theta) * modelZ) + 100,
      scale * (Math.sin(theta) * modelX + Math.cos(theta) * modelZ) + 200,
    ),
    evidenceSourceId: "front-image",
  }));
  const model = [
    [-8, 0.25, -6], [-4, 0.75, 5], [0, 1.5, -2],
    [4, 2.25, 7], [8, 3.25, -5], [12, 4, 3],
  ];
  return {
    schemaVersion: "1.2.0",
    kind: "single-image-control-point-manifest",
    buildingId: "integrity-test-building",
    source: { sourceId: "front-image", sha256: sourceSha256 },
    horizontalCrs: "EPSG:4326",
    horizontalDatum: "WGS84",
    verticalDatum: "EPSG:4979-ellipsoidal",
    survey: {
      method: "RTK GNSS",
      reference: "package-fit-survey-2026-11-04",
      observedAtUtc: "2026-11-04T10:00:00.000Z",
      horizontalAccuracyM: 0.03,
    },
    controlPoints,
    vertical: {
      crs: "EPSG:4979",
      heightType: "ellipsoidal",
      unit: "metre",
      referenceFrame: "WGS 84 (G2139)",
      coordinateEpoch: 2022.25,
      survey: {
        method: "RTK GNSS ellipsoidal-height observation",
        reference: "package-vertical-survey-2026-11-04",
        observedAtUtc: "2026-11-04T10:30:00.000Z",
        verticalAccuracyM: 0.04,
      },
      controlPoints: controlPoints.map((point, index) => ({
        horizontalControlPointId: point.id,
        observationId: point.observationId,
        modelY: index * 1.5,
        ellipsoidalHeightM: 135 + scale * index * 1.5,
        evidenceSourceId: "front-image",
      })),
    },
    heldOutCheckpoints: {
      crs: "EPSG:4979",
      heightType: "ellipsoidal",
      unit: "metre",
      referenceFrame: "WGS 84 (G2139)",
      coordinateEpoch: 2022.25,
      survey: {
        method: "independent RTK GNSS checkpoint survey",
        reference: "package-heldout-survey-2026-11-04",
        observedAtUtc: "2026-11-04T11:00:00.000Z",
        horizontalAccuracyM: 0.03,
        verticalAccuracyM: 0.04,
      },
      points: model.map(([modelX, modelY, modelZ], index) => ({
        id: "heldout-" + (index + 1),
        observationId: "heldout-observation-" + (index + 1),
        observationRecordSha256: String(index + 1).padStart(2, "0").repeat(32),
        modelX, modelY, modelZ,
        ...lonLat(
          scale * (Math.cos(theta) * modelX - Math.sin(theta) * modelZ) + 100,
          scale * (Math.sin(theta) * modelX + Math.cos(theta) * modelZ) + 200,
        ),
        ellipsoidalHeightM: 135 + scale * modelY,
      })),
    },
  };
}

test("binds original held-out survey record bytes through the complete review package and preserves legacy D3M-14 packages", async (t) => {
  const base = await createFixture();
  const candidate = base.packageManifest.artifacts.find((item) => item.artifactType === "candidate-glb");
  const candidateFile = base.actualFiles.find((item) => item.relativePath === candidate.relativePath);
  const candidateBytes = candidateFile.content;
  const candidateSha256 = hash(candidateBytes);
  const sourceBytes = Buffer.from("fixture source facade image bytes");
  const sourceSha256 = hash(sourceBytes);
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m15-package-e2e-"));
  await mkdir(path.join(root, "survey"), { recursive: true });
  await mkdir(path.join(root, "evidence/survey-observations"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const manifest = makeHeldOutManifest(sourceSha256);
  const recordInputs = manifest.heldOutCheckpoints.points.map((checkpoint) => {
    const bytes = Buffer.from("synthetic-test-only GNSS observation fixture:" + checkpoint.observationId);
    checkpoint.observationRecordSha256 = hash(bytes);
    return {
      observationId: checkpoint.observationId,
      relativePath: singleImageSurveyObservationRecordPath(checkpoint.observationId),
      sha256: hash(bytes),
      bytes,
    };
  });
  for (const record of recordInputs) {
    await writeFile(path.join(root, ...record.relativePath.split("/")), record.bytes, { flag: "wx" });
  }
  const recordInventory = buildSingleImageSurveyObservationRecordInventory(recordInputs.map((record) => ({
    observationId: record.observationId,
    relativePath: record.relativePath,
    sha256: record.sha256,
    bytes: record.bytes.length,
  })));
  const manifestBytes = JSON_BYTES(manifest);
  await writeFile(path.join(root, "survey", "controls.json"), manifestBytes, { flag: "wx" });
  const loadedManifest = await loadSingleImageControlPointManifest({
    workspaceRoot: root,
    relativePath: "survey/controls.json",
    buildingId: "integrity-test-building",
    sourceId: "front-image",
    sourceSha256,
  });
  const georeferenceEvidence = createSingleImageGeoreferenceEvidence({
    loadedManifest,
    modelSha256: candidateSha256,
  });
  assert.equal(georeferenceEvidence.schemaVersion, "1.2.0");
  assert.equal(georeferenceEvidence.independentCheckpointEvidence.status, "validated-needs-human-review");

  const jobId = "smoke-job-checkpoints";
  const buildingId = "integrity-test-building";
  const outputPath = candidate.relativePath;
  const outputMeshCount = 1;
  const source = {
    sourceId: "front-image",
    sha256: sourceSha256,
    bytes: sourceBytes.length,
    mimeType: "image/jpeg",
  };
  const workerHost = {
    inventorySchemaVersion: "1.1.0",
    stableAcrossInference: true,
    before: { python: "3.11.9", torch: "2.5.1", device: "cpu" },
    after: { python: "3.11.9", torch: "2.5.1", device: "cpu" },
  };
  const modelLoadEvidence = { status: "verified", roles: ["tripoConfig", "tripoCheckpoint", "rembgWeights"] };
  const geometryQa = {
    valid: true,
    sourceStatus: "candidate",
    status: "passed",
    warningCount: 0,
    warnings: [],
    counts: { meshes: 1, vertices: 3, triangles: 1 },
  };
  const geometryReceiptSummary = {
    schemaVersion: "1.0.0",
    engine: "glb-geometry-qa-v2",
    valid: geometryQa.valid,
    sourceStatus: geometryQa.sourceStatus,
    status: geometryQa.status,
    warningCount: geometryQa.warningCount,
    warnings: geometryQa.warnings,
    counts: geometryQa.counts,
  };
  const workflowReport = {
    jobId,
    buildingId,
    mode: "single-image-ai",
    status: "completed-requires-review",
    inputs: {
      selectedViewIds: ["front-image"],
      mediaRecords: [{
        id: "front-image",
        sha256: sourceSha256,
        mimeType: "image/jpeg",
        usageStatus: "approved",
      }],
    },
    output: {
      modelPath: outputPath,
      modelBytes: candidateBytes.length,
      modelSha256: candidateSha256,
    },
    modelReport: {
      source: { sha256: sourceSha256 },
      outputs: { glb: { sha256: candidateSha256, bytes: candidateBytes.length, meshCount: outputMeshCount } },
      mapReady: false,
      publicationEligible: false,
    },
    georeference: georeferenceEvidence.registration,
    mapReady: false,
    publicationEligible: false,
  };
  const workflowBytes = JSON_BYTES(workflowReport);
  const workflowSha256 = hash(workflowBytes);
  const smokeReport = {
    schemaVersion: "1.6.0",
    kind: "single-image-runtime-smoke",
    status: "passed",
    jobId,
    buildingId,
    source,
    output: {
      relativePath: outputPath,
      bytes: candidateBytes.length,
      sha256: candidateSha256,
      meshCount: outputMeshCount,
    },
    workerHost,
    modelLoadEvidence,
    geometryQa,
    georeferenceEvidence,
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
  const receiptPayload = {
    kind: "single-image-generation-artifact",
    schemaVersion: "1.2.0",
    jobId,
    buildingId,
    source: {
      sourceId: source.sourceId,
      sha256: sourceSha256,
      bytes: source.bytes,
      mimeType: source.mimeType,
      loaderEvidence: { sha256: sourceSha256 },
    },
    output: {
      path: outputPath,
      bytes: candidateBytes.length,
      format: "glb",
      sha256: candidateSha256,
      meshCount: outputMeshCount,
    },
    workflowReport: {
      path: ".building-engine/jobs/integrity-test-building/smoke-job-checkpoints/workflow-report.json",
      bytes: workflowBytes.length,
      sha256: workflowSha256,
    },
    workerHost,
    modelLoadEvidence,
    geometryQa: geometryReceiptSummary,
    georeference: georeferenceEvidence,
  };
  const payloadSha256 = hash(Buffer.from(canonicalJson(receiptPayload), "utf8"));
  const receipt = { schemaVersion: "1.2.0", payload: receiptPayload, payloadSha256 };
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  const receiptSha256 = hash(receiptBytes);
  smokeReport.generationArtifactReceipt = {
    path: ".building-engine/runtime-smokes/" + jobId + ".artifact.json",
    schemaVersion: "1.2.0",
    bytes: receiptBytes.length,
    sha256: receiptSha256,
    payloadSha256,
  };

  const groupFiles = [
    ["single-image-smoke-report", "reports/single-image-runtime-smoke.json", JSON_BYTES(smokeReport)],
    ["single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", receiptBytes],
    ["single-image-workflow-report", "reports/single-image-workflow-report.json", workflowBytes],
    ["single-image-control-point-manifest", "evidence/single-image-control-points.json", manifestBytes],
  ];
  const newArtifacts = [
    ...groupFiles.map(([artifactType, relativePath, bytes]) => ({
      artifactType, relativePath, sha256: hash(bytes), bytes: bytes.length,
    })),
    ...recordInputs.map((record) => ({
      artifactType: "single-image-survey-observation-record",
      relativePath: record.relativePath,
      sha256: record.sha256,
      bytes: record.bytes.length,
    })),
  ];
  const newFiles = [
    ...groupFiles.map(([, relativePath, bytes]) => ({
      relativePath, sha256: hash(bytes), bytes: bytes.length, content: bytes, isRegularFile: true,
    })),
    ...recordInputs.map((record) => ({
      relativePath: record.relativePath,
      sha256: record.sha256,
      bytes: record.bytes.length,
      content: record.bytes,
      isRegularFile: true,
    })),
  ];
  const artifactDescriptors = [...base.packageManifest.artifacts, ...newArtifacts];
  const verticalEvidence = georeferenceEvidence.verticalEvidence;
  const checkpointEvidence = georeferenceEvidence.independentCheckpointEvidence;
  const singleImageEvidence = {
    schemaVersion: "1.3.0",
    jobId,
    buildingId,
    sourceId: source.sourceId,
    sourceSha256,
    candidateGlbSha256: candidateSha256,
    georeferenceStatus: georeferenceEvidence.status,
    controlPointManifestSha256: hash(manifestBytes),
    smokeReportSha256: hash(groupFiles[0][2]),
    generationArtifactReceiptSha256: receiptSha256,
    workflowReportSha256: workflowSha256,
    verticalDatum: "EPSG:4979-ellipsoidal",
    verticalStatus: verticalEvidence.status,
    verticalEvidenceSha256: hash(Buffer.from(canonicalJson(verticalEvidence), "utf8")),
    verticalReferenceFrame: verticalEvidence.referenceFrame,
    verticalCoordinateEpoch: verticalEvidence.coordinateEpoch,
    verticalHeightOffsetM: verticalEvidence.heightOffsetM,
    verticalRmsErrorM: verticalEvidence.controls.rmsErrorM,
    verticalMaxResidualM: verticalEvidence.controls.maxResidualM,
    verticalControlPointCount: verticalEvidence.controls.count,
    checkpointValidationStatus: checkpointEvidence.status,
    checkpointEvidenceSha256: hash(Buffer.from(canonicalJson(checkpointEvidence), "utf8")),
    checkpointReferenceFrame: checkpointEvidence.referenceFrame,
    checkpointCoordinateEpoch: checkpointEvidence.coordinateEpoch,
    checkpointCount: checkpointEvidence.controls.count,
    checkpointHorizontalRmsErrorM: checkpointEvidence.controls.horizontalRmsErrorM,
    checkpointHorizontalMaxResidualM: checkpointEvidence.controls.horizontalMaxResidualM,
    checkpointVerticalRmsErrorM: checkpointEvidence.controls.verticalRmsErrorM,
    checkpointVerticalMaxResidualM: checkpointEvidence.controls.verticalMaxResidualM,
    checkpoint3dRmsErrorM: checkpointEvidence.controls.spatial3dRmsErrorM,
    checkpoint3dMaxResidualM: checkpointEvidence.controls.spatial3dMaxResidualM,
    surveyObservationRecordCount: recordInventory.count,
    surveyObservationRecordBytes: recordInventory.totalBytes,
    surveyObservationRecordsSha256: recordInventory.sha256,
    surveyObservationRecords: recordInventory.records,
    files: [
      ...groupFiles.map(([artifactType, relativePath, bytes]) => ({
        artifactType, relativePath, sha256: hash(bytes), bytes,
      })),
      ...recordInputs.map((record) => ({
        artifactType: "single-image-survey-observation-record",
        observationId: record.observationId,
        relativePath: record.relativePath,
        sha256: record.sha256,
        bytes: record.bytes,
      })),
    ],
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
  const readiness = JSON.parse(base.actualFiles.find((item) =>
    item.relativePath === "reports/release-readiness.json").content.toString("utf8"));
  const renderManifest = JSON.parse(base.actualFiles.find((item) =>
    item.relativePath === "renders/render-review-manifest.json").content.toString("utf8"));
  const packageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: artifactDescriptors,
    singleImageEvidence,
    generatedAt: "2026-11-04T12:00:00.000Z",
  });
  const actualFiles = [...base.actualFiles, ...newFiles];
  const report = verifyBuildingReviewPackage({
    packageManifest,
    actualFiles,
    packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.status, "verified");
  assert.ok(report.checks.some((item) =>
    item.id === "single-image-georeference-recomputed" && item.status === "passed"));
  assert.equal(report.publicationEligible, false);
  assert.equal(packageManifest.singleImageEvidence.mapReady, false);
  assert.equal(packageManifest.singleImageEvidence.publicationEligible, false);
  assert.equal(packageManifest.singleImageEvidence.automaticApproval, false);
  assert.equal(packageManifest.singleImageEvidence.schemaVersion, "1.3.0");
  assert.equal(packageManifest.singleImageEvidence.surveyObservationRecordCount, 6);
  assert.equal(packageManifest.singleImageEvidence.surveyObservationRecordBytes, recordInventory.totalBytes);
  assert.equal(packageManifest.artifacts.filter((item) =>
    item.artifactType === "single-image-survey-observation-record").length, 6);

  const legacyManifest = JSON.parse(JSON.stringify(packageManifest));
  const removedRecords = legacyManifest.artifacts.filter((item) =>
    item.artifactType === "single-image-survey-observation-record");
  legacyManifest.artifacts = legacyManifest.artifacts.filter((item) =>
    item.artifactType !== "single-image-survey-observation-record");
  legacyManifest.counts.artifacts -= removedRecords.length;
  legacyManifest.counts.totalBytes -= removedRecords.reduce((sum, item) => sum + item.bytes, 0);
  legacyManifest.singleImageEvidence.schemaVersion = "1.2.0";
  delete legacyManifest.singleImageEvidence.surveyObservationRecordCount;
  delete legacyManifest.singleImageEvidence.surveyObservationRecordBytes;
  delete legacyManifest.singleImageEvidence.surveyObservationRecordsSha256;
  const legacyFiles = actualFiles.filter((item) =>
    !recordInputs.some((record) => record.relativePath === item.relativePath));
  const legacyReport = verifyBuildingReviewPackage({
    packageManifest: legacyManifest,
    actualFiles: legacyFiles,
    packageManifestSha256: hash(JSON_BYTES(legacyManifest)),
  });
  assert.equal(legacyReport.valid, true, JSON.stringify(legacyReport.errors));

  const missingRecordFiles = actualFiles.filter((item) =>
    item.relativePath !== recordInputs[0].relativePath);
  const missingRecordReport = verifyBuildingReviewPackage({
    packageManifest,
    actualFiles: missingRecordFiles,
    packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(missingRecordReport.valid, false);
  assert.ok(missingRecordReport.errors.some((item) =>
    item.id === "file-present:" + recordInputs[0].relativePath));

  const tamperedRecordFiles = actualFiles.map((item) => item.relativePath === recordInputs[0].relativePath
    ? { ...item, content: Buffer.concat([item.content, Buffer.from("tampered")]) }
    : item);
  const tamperedRecordReport = verifyBuildingReviewPackage({
    packageManifest,
    actualFiles: tamperedRecordFiles,
    packageManifestSha256: hash(JSON_BYTES(packageManifest)),
  });
  assert.equal(tamperedRecordReport.valid, false);
  assert.ok(tamperedRecordReport.errors.some((item) =>
    item.id === "file-sha256:" + recordInputs[0].relativePath));
  assert.ok(tamperedRecordReport.errors.some((item) =>
    item.id === "single-image-georeference-recomputed"));

  const forgedInventory = {
    ...packageManifest,
    singleImageEvidence: {
      ...packageManifest.singleImageEvidence,
      surveyObservationRecordsSha256: "f".repeat(64),
    },
  };
  const forgedInventoryReport = verifyBuildingReviewPackage({
    packageManifest: forgedInventory,
    actualFiles,
    packageManifestSha256: hash(JSON_BYTES(forgedInventory)),
  });
  assert.equal(forgedInventoryReport.valid, false);
  assert.ok(forgedInventoryReport.errors.some((item) =>
    item.id === "single-image-georeference-recomputed"));

  const forgedMetadata = {
    ...packageManifest,
    singleImageEvidence: {
      ...packageManifest.singleImageEvidence,
      checkpoint3dRmsErrorM: packageManifest.singleImageEvidence.checkpoint3dRmsErrorM + 0.01,
    },
  };
  const forgedReport = verifyBuildingReviewPackage({
    packageManifest: forgedMetadata,
    actualFiles,
    packageManifestSha256: hash(JSON_BYTES(forgedMetadata)),
  });
  assert.equal(forgedReport.valid, false);
  assert.ok(forgedReport.errors.some((item) => item.id === "single-image-georeference-recomputed"));

  const driftedManifest = JSON.parse(manifestBytes.toString("utf8"));
  driftedManifest.heldOutCheckpoints.points[0].ellipsoidalHeightM += 0.25;
  const driftedBytes = JSON_BYTES(driftedManifest);
  const driftedFiles = actualFiles.map((file) => file.relativePath === "evidence/single-image-control-points.json"
    ? { ...file, content: driftedBytes, bytes: driftedBytes.length, sha256: hash(driftedBytes) }
    : file);
  const driftedArtifacts = packageManifest.artifacts.map((artifact) =>
    artifact.relativePath === "evidence/single-image-control-points.json"
      ? { ...artifact, bytes: driftedBytes.length, sha256: hash(driftedBytes) }
      : artifact);
  const driftedPackage = {
    ...packageManifest,
    counts: {
      ...packageManifest.counts,
      totalBytes: packageManifest.counts.totalBytes - manifestBytes.length + driftedBytes.length,
    },
    artifacts: driftedArtifacts,
  };
  const driftedReport = verifyBuildingReviewPackage({
    packageManifest: driftedPackage,
    actualFiles: driftedFiles,
    packageManifestSha256: hash(JSON_BYTES(driftedPackage)),
  });
  assert.equal(driftedReport.valid, false);
  assert.ok(driftedReport.errors.some((item) => item.id === "single-image-georeference-recomputed"));

  // D3M-16: convert the exact D3M-15 byte-only package into a schema 1.4.0
  // package using ephemeral test keys and detached per-observation sidecars.
  const surveyorPair = generateKeyPairSync("ed25519");
  const surveyorPrivateKeyPem = surveyorPair.privateKey.export({
    type: "pkcs8", format: "pem",
  }).toString();
  const surveyorPublicKeyPem = surveyorPair.publicKey.export({
    type: "spki", format: "pem",
  }).toString();
  const trustedSurveyorRegistry = {
    schemaVersion: "1.0.0",
    recordType: "trusted-surveyor-public-key-registry",
    registryId: "synthetic-surveyors-test-registry",
    issuedAtUtc: "2026-11-01T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    entries: [{
      surveyorId: "synthetic-surveyor-01",
      keyId: "synthetic-surveyor-key-01",
      status: "active",
      publicKeyPem: surveyorPublicKeyPem,
      validFromUtc: "2026-11-01T00:00:00.000Z",
      validUntilUtc: "2026-12-01T00:00:00.000Z",
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  const attestationSidecars = recordInputs.map((record) => {
    const checkpoint = manifest.heldOutCheckpoints.points.find(
      (item) => item.observationId === record.observationId,
    );
    assert.ok(checkpoint);
    const attestation = createSurveyObservationAttributionAttestation({
      recordBytes: record.bytes,
      controlPointManifestBytes: manifestBytes,
      observationId: checkpoint.observationId,
      checkpointId: checkpoint.id,
      buildingId,
      surveyorId: "synthetic-surveyor-01",
      privateKeyPem: surveyorPrivateKeyPem,
      trustedSurveyorRegistry,
      attestedAtUtc: "2026-11-05T06:00:00.000Z",
    });
    const relativePath = surveyObservationAttributionAttestationPath(record.observationId);
    const bytes = JSON_BYTES(attestation);
    return {
      artifactType: "single-image-survey-observation-attestation",
      observationId: checkpoint.observationId,
      checkpointId: checkpoint.id,
      relativePath,
      sha256: hash(bytes),
      bytes,
      registryId: attestation.registryId,
      surveyorId: attestation.surveyorId,
      keyId: attestation.keyId,
    };
  });
  const attestationInventory = buildSurveyObservationAttributionInventory(
    attestationSidecars.map((item) => ({
      observationId: item.observationId,
      checkpointId: item.checkpointId,
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes.length,
    })),
  );
  const signedEvidence = {
    ...singleImageEvidence,
    schemaVersion: "1.4.0",
    surveyObservationAttestationCount: attestationInventory.count,
    surveyObservationAttestationBytes: attestationInventory.totalBytes,
    surveyObservationAttestationsSha256: attestationInventory.sha256,
    surveyObservationAttestations: attestationInventory.entries,
    surveyObservationAttributionStatus: "attribution-signatures-verified",
    trustedSurveyorRegistryId: trustedSurveyorRegistry.registryId,
    files: [
      ...singleImageEvidence.files,
      ...attestationSidecars.map((item) => ({
        artifactType: item.artifactType,
        observationId: item.observationId,
        checkpointId: item.checkpointId,
        relativePath: item.relativePath,
        sha256: item.sha256,
        bytes: item.bytes,
      })),
    ],
  };
  const signedArtifacts = [
    ...packageManifest.artifacts,
    ...attestationSidecars.map((item) => ({
      artifactType: item.artifactType,
      observationId: item.observationId,
      checkpointId: item.checkpointId,
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes.length,
    })),
  ];
  const signedPackageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: signedArtifacts,
    singleImageEvidence: signedEvidence,
    generatedAt: "2026-11-05T06:10:00.000Z",
  });
  const signedActualFiles = [
    ...actualFiles,
    ...attestationSidecars.map((item) => ({
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes.length,
      content: item.bytes,
      isRegularFile: true,
    })),
  ];
  const signedReport = verifyBuildingReviewPackage({
    packageManifest: signedPackageManifest,
    actualFiles: signedActualFiles,
    packageManifestSha256: hash(JSON_BYTES(signedPackageManifest)),
    trustedSurveyorRegistry,
  });
  assert.equal(signedReport.valid, true, JSON.stringify(signedReport.errors));
  assert.equal(signedReport.status, "verified");
  assert.equal(signedPackageManifest.singleImageEvidence.schemaVersion, "1.4.0");
  assert.equal(signedPackageManifest.singleImageEvidence.surveyObservationAttestationCount, 6);
  assert.equal(signedPackageManifest.singleImageEvidence.trustedSurveyorRegistryId, trustedSurveyorRegistry.registryId);
  assert.equal(signedReport.publicationEligible, false);
  assert.ok(signedReport.checks.some((item) =>
    item.id === "single-image-georeference-recomputed" && item.status === "passed"));

  const signedWithoutRegistry = verifyBuildingReviewPackage({
    packageManifest: signedPackageManifest,
    actualFiles: signedActualFiles,
    packageManifestSha256: hash(JSON_BYTES(signedPackageManifest)),
  });
  assert.equal(signedWithoutRegistry.valid, false);
  assert.ok(signedWithoutRegistry.errors.some((item) =>
    item.message.includes("trusted-surveyor-registry-required-for-package-schema-1.4.0")));

  const missingAttestationFiles = signedActualFiles.filter((file) =>
    file.relativePath !== attestationSidecars[0].relativePath);
  const missingAttestation = verifyBuildingReviewPackage({
    packageManifest: signedPackageManifest,
    actualFiles: missingAttestationFiles,
    packageManifestSha256: hash(JSON_BYTES(signedPackageManifest)),
    trustedSurveyorRegistry,
  });
  assert.equal(missingAttestation.valid, false);
  assert.ok(missingAttestation.errors.some((item) =>
    item.id === "file-present:" + attestationSidecars[0].relativePath));

  const tamperedAttestationFiles = signedActualFiles.map((file) =>
    file.relativePath === attestationSidecars[0].relativePath
      ? { ...file, content: Buffer.concat([file.content, Buffer.from("tampered")]) }
      : file);
  const tamperedAttestation = verifyBuildingReviewPackage({
    packageManifest: signedPackageManifest,
    actualFiles: tamperedAttestationFiles,
    packageManifestSha256: hash(JSON_BYTES(signedPackageManifest)),
    trustedSurveyorRegistry,
  });
  assert.equal(tamperedAttestation.valid, false);
  assert.ok(tamperedAttestation.errors.some((item) =>
    item.id === "single-image-georeference-recomputed"));

  const wrongSurveyorPair = generateKeyPairSync("ed25519");
  const wrongRegistry = {
    ...trustedSurveyorRegistry,
    entries: [{
      ...trustedSurveyorRegistry.entries[0],
      publicKeyPem: wrongSurveyorPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }],
  };
  const wrongSigner = verifyBuildingReviewPackage({
    packageManifest: signedPackageManifest,
    actualFiles: signedActualFiles,
    packageManifestSha256: hash(JSON_BYTES(signedPackageManifest)),
    trustedSurveyorRegistry: wrongRegistry,
  });
  assert.equal(wrongSigner.valid, false);

  // D3M-17: add an independent device-key signature for every same held-out
  // observation and verify a 1.5.0 package against both current trust registries.
  const devicePair = generateKeyPairSync("ed25519");
  const devicePrivateKeyPem = devicePair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const devicePublicKeyPem = devicePair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const registryNow = new Date();
  const registryIssued = new Date(registryNow.getTime() - 60 * 60 * 1000).toISOString();
  const registryExpires = new Date(registryNow.getTime() + 30 * 86400000).toISOString();
  const trustedDeviceRegistry = {
    schemaVersion: "1.0.0",
    recordType: "trusted-survey-device-public-key-registry",
    registryId: "synthetic-devices-test-registry",
    issuedAtUtc: registryIssued,
    expiresAtUtc: registryExpires,
    entries: [{
      deviceId: "synthetic-receiver-01",
      manufacturerId: "synthetic-vendor",
      modelId: "synthetic-gnss-model",
      deviceSerialCommitmentSha256: hash(Buffer.from("synthetic-keyed-serial-commitment")),
      enrollmentEvidenceSha256: "0".repeat(64),
      keyId: "synthetic-receiver-key-01",
      status: "active",
      publicKeyPem: devicePublicKeyPem,
      validFromUtc: registryIssued,
      validUntilUtc: registryExpires,
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  const authorityPair = generateKeyPairSync("ed25519");
  const authorityPrivateKey = authorityPair.privateKey;
  const authorityPublicKeyPem = authorityPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const trustedEnrollmentAuthorityRegistry = {
    schemaVersion: "1.0.0",
    recordType: "trusted-survey-device-enrollment-authority-public-key-registry",
    registryId: "synthetic-enrollment-authorities-test-registry",
    issuedAtUtc: registryIssued,
    expiresAtUtc: registryExpires,
    entries: [{
      authorityId: "synthetic-survey-enrollment-office",
      authorityType: "independent-enrollment-authority",
      keyId: "synthetic-enrollment-authority-key-01",
      status: "active",
      publicKeyPem: authorityPublicKeyPem,
      validFromUtc: registryIssued,
      validUntilUtc: registryExpires,
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  const enrollmentUnsigned = {
    schemaVersion: "1.0.0",
    recordType: "survey-device-enrollment-evidence",
    engine: "survey-device-enrollment-evidence-v1",
    signatureAlgorithm: "Ed25519",
    signaturePurpose: "survey-device-hardware-identity-enrollment-only",
    enrollmentId: "synthetic-enrollment-record-01",
    deviceId: "synthetic-receiver-01",
    manufacturerId: "synthetic-vendor",
    modelId: "synthetic-gnss-model",
    deviceSerialCommitmentSha256: trustedDeviceRegistry.entries[0].deviceSerialCommitmentSha256,
    authorityId: "synthetic-survey-enrollment-office",
    authorityType: "independent-enrollment-authority",
    authorityKeyId: "synthetic-enrollment-authority-key-01",
    authorityRegistryId: trustedEnrollmentAuthorityRegistry.registryId,
    authorityRegistryIssuedAtUtc: trustedEnrollmentAuthorityRegistry.issuedAtUtc,
    authorityRegistryExpiresAtUtc: trustedEnrollmentAuthorityRegistry.expiresAtUtc,
    issuedAtUtc: registryNow.toISOString(),
    validFromUtc: registryIssued,
    validUntilUtc: registryExpires,
    publicationEligible: false,
    note: SURVEY_DEVICE_ENROLLMENT_EVIDENCE_NOTE,
    signatureBase64: "",
  };
  const enrollmentEvidence = {
    ...enrollmentUnsigned,
    signatureBase64: sign(null, surveyDeviceEnrollmentEvidenceSigningBytes(enrollmentUnsigned), authorityPrivateKey).toString("base64"),
  };
  const enrollmentEvidenceBytes = Buffer.from(canonicalJson(enrollmentEvidence), "utf8");
  trustedDeviceRegistry.entries[0].enrollmentEvidenceSha256 = hash(enrollmentEvidenceBytes);
  const enrollmentEvidenceRelativePath = surveyDeviceEnrollmentEvidencePath("synthetic-receiver-01");
  const enrollmentEvidenceArtifact = {
    artifactType: "single-image-survey-device-enrollment-evidence",
    deviceId: "synthetic-receiver-01",
    authorityId: "synthetic-survey-enrollment-office",
    authorityType: "independent-enrollment-authority",
    authorityRegistryId: trustedEnrollmentAuthorityRegistry.registryId,
    relativePath: enrollmentEvidenceRelativePath,
    sha256: hash(enrollmentEvidenceBytes),
    bytes: enrollmentEvidenceBytes,
  };
  const enrollmentEvidenceInventory = buildSurveyDeviceEnrollmentEvidenceInventory([{
    deviceId: enrollmentEvidenceArtifact.deviceId,
    relativePath: enrollmentEvidenceArtifact.relativePath,
    sha256: enrollmentEvidenceArtifact.sha256,
    bytes: enrollmentEvidenceBytes.length,
    authorityId: enrollmentEvidenceArtifact.authorityId,
    authorityType: enrollmentEvidenceArtifact.authorityType,
    authorityRegistryId: enrollmentEvidenceArtifact.authorityRegistryId,
  }]);
  assert.throws(
    () => buildSurveyDeviceEnrollmentEvidenceInventory([
      ...enrollmentEvidenceInventory.entries,
      ...enrollmentEvidenceInventory.entries,
    ]),
    /duplicated device or path/,
  );
  const deviceSidecars = recordInputs.map((record) => {
    const checkpoint = manifest.heldOutCheckpoints.points.find(
      (item) => item.observationId === record.observationId,
    );
    const attestation = createSurveyObservationDeviceAttestation({
      recordBytes: record.bytes,
      controlPointManifestBytes: manifestBytes,
      observationId: checkpoint.observationId,
      checkpointId: checkpoint.id,
      buildingId,
      deviceId: "synthetic-receiver-01",
      privateKeyPem: devicePrivateKeyPem,
      trustedDeviceRegistry,
      attestedAtUtc: new Date().toISOString(),
    });
    const relativePath = surveyObservationDeviceAttestationPath(record.observationId);
    const bytes = JSON_BYTES(attestation);
    return {
      artifactType: "single-image-survey-observation-device-attestation",
      observationId: checkpoint.observationId,
      checkpointId: checkpoint.id,
      deviceId: attestation.deviceId,
      keyId: attestation.keyId,
      relativePath,
      sha256: hash(bytes),
      bytes,
    };
  });
  const deviceInventory = buildSurveyObservationDeviceAttestationInventory(
    deviceSidecars.map((item) => ({
      observationId: item.observationId,
      checkpointId: item.checkpointId,
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes.length,
    })),
  );
  const deviceEvidence = {
    ...signedEvidence,
    schemaVersion: "1.5.0",
    surveyObservationDeviceAttestationCount: deviceInventory.count,
    surveyObservationDeviceAttestationBytes: deviceInventory.totalBytes,
    surveyObservationDeviceAttestationsSha256: deviceInventory.sha256,
    surveyObservationDeviceAttestations: deviceInventory.entries,
    surveyObservationDeviceAttestationStatus: "device-key-attestations-verified",
    trustedSurveyDeviceRegistryId: trustedDeviceRegistry.registryId,
    files: [
      ...signedEvidence.files,
      ...deviceSidecars.map((item) => ({
        artifactType: item.artifactType,
        observationId: item.observationId,
        checkpointId: item.checkpointId,
        deviceId: item.deviceId,
        keyId: item.keyId,
        relativePath: item.relativePath,
        sha256: item.sha256,
        bytes: item.bytes,
      })),
    ],
  };
  const devicePackageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: [
      ...signedArtifacts,
      ...deviceSidecars.map((item) => ({
        artifactType: item.artifactType,
        observationId: item.observationId,
        checkpointId: item.checkpointId,
        deviceId: item.deviceId,
        keyId: item.keyId,
        relativePath: item.relativePath,
        sha256: item.sha256,
        bytes: item.bytes.length,
      })),
    ],
    singleImageEvidence: deviceEvidence,
    generatedAt: new Date().toISOString(),
  });
  const deviceActualFiles = [
    ...signedActualFiles,
    ...deviceSidecars.map((item) => ({
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes.length,
      content: item.bytes,
      isRegularFile: true,
    })),
  ];
  const deviceReport = verifyBuildingReviewPackage({
    packageManifest: devicePackageManifest,
    actualFiles: deviceActualFiles,
    packageManifestSha256: hash(JSON_BYTES(devicePackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
  });
  assert.equal(deviceReport.valid, true, JSON.stringify(deviceReport.errors));
  assert.equal(devicePackageManifest.singleImageEvidence.schemaVersion, "1.5.0");
  assert.equal(devicePackageManifest.singleImageEvidence.surveyObservationDeviceAttestationCount, 6);
  assert.equal(devicePackageManifest.singleImageEvidence.trustedSurveyDeviceRegistryId, trustedDeviceRegistry.registryId);
  assert.equal(deviceReport.publicationEligible, false);
  assert.ok(deviceReport.checks.some((item) =>
    item.id === "single-image-georeference-recomputed" && item.status === "passed"));

  // D3M-ENGINE-19: package one immutable signed enrollment statement per distinct
  // device identity; D3M-17 retains per-key attestation and rotation checks.
  const enrollmentEvidenceFileMetadata = {
    artifactType: enrollmentEvidenceArtifact.artifactType,
    deviceId: enrollmentEvidenceArtifact.deviceId,
    authorityId: enrollmentEvidenceArtifact.authorityId,
    authorityType: enrollmentEvidenceArtifact.authorityType,
    authorityRegistryId: enrollmentEvidenceArtifact.authorityRegistryId,
    relativePath: enrollmentEvidenceArtifact.relativePath,
    sha256: enrollmentEvidenceArtifact.sha256,
    bytes: enrollmentEvidenceBytes.length,
  };
  const enrolledEvidence = {
    ...deviceEvidence,
    schemaVersion: "1.6.0",
    surveyDeviceEnrollmentEvidenceCount: enrollmentEvidenceInventory.count,
    surveyDeviceEnrollmentEvidenceBytes: enrollmentEvidenceInventory.totalBytes,
    surveyDeviceEnrollmentEvidenceSha256: enrollmentEvidenceInventory.sha256,
    surveyDeviceEnrollmentEvidence: enrollmentEvidenceInventory.entries,
    surveyDeviceEnrollmentEvidenceStatus: "enrollment-authority-evidence-verified",
    trustedSurveyDeviceEnrollmentAuthorityRegistryId: trustedEnrollmentAuthorityRegistry.registryId,
    files: [...deviceEvidence.files, enrollmentEvidenceFileMetadata],
  };
  const enrolledPackageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: [
      ...devicePackageManifest.artifacts,
      { ...enrollmentEvidenceFileMetadata },
    ],
    singleImageEvidence: enrolledEvidence,
    generatedAt: registryNow.toISOString(),
  });
  const packagedEnrollmentArtifact = enrolledPackageManifest.artifacts.find((item) =>
    item.artifactType === enrollmentEvidenceArtifact.artifactType);
  assert.equal(packagedEnrollmentArtifact.deviceId, enrollmentEvidenceArtifact.deviceId);
  assert.equal(Object.hasOwn(packagedEnrollmentArtifact, "keyId"), false);
  const enrolledActualFiles = [
    ...deviceActualFiles,
    {
      relativePath: enrollmentEvidenceArtifact.relativePath,
      sha256: enrollmentEvidenceArtifact.sha256,
      bytes: enrollmentEvidenceBytes.length,
      content: enrollmentEvidenceBytes,
      isRegularFile: true,
    },
  ];
  const enrolledReport = verifyBuildingReviewPackage({
    packageManifest: enrolledPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(enrolledPackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
  });
  assert.equal(enrolledReport.valid, true, JSON.stringify(enrolledReport.errors));
  assert.equal(enrolledPackageManifest.singleImageEvidence.schemaVersion, "1.6.0");
  assert.equal(enrolledPackageManifest.singleImageEvidence.surveyDeviceEnrollmentEvidenceCount, 1);
  assert.equal(enrolledPackageManifest.singleImageEvidence.trustedSurveyDeviceEnrollmentAuthorityRegistryId,
    trustedEnrollmentAuthorityRegistry.registryId);
  assert.equal(enrolledReport.publicationEligible, false);
  assert.ok(enrolledReport.checks.some((item) =>
    item.id === "single-image-georeference-recomputed" && item.status === "passed"));

  const missingAuthorityRegistry = verifyBuildingReviewPackage({
    packageManifest: enrolledPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(enrolledPackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
  });
  assert.equal(missingAuthorityRegistry.valid, false);
  assert.ok(missingAuthorityRegistry.errors.some((item) =>
    item.message.includes("trusted-survey-device-enrollment-authority-registry-required-for-package-schema-1.6.0")));

  const missingEnrollmentEvidence = verifyBuildingReviewPackage({
    packageManifest: enrolledPackageManifest,
    actualFiles: enrolledActualFiles.filter((item) => item.relativePath !== enrollmentEvidenceArtifact.relativePath),
    packageManifestSha256: hash(JSON_BYTES(enrolledPackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
  });
  assert.equal(missingEnrollmentEvidence.valid, false);

  const tamperedEnrollmentEvidence = verifyBuildingReviewPackage({
    packageManifest: enrolledPackageManifest,
    actualFiles: enrolledActualFiles.map((item) => item.relativePath === enrollmentEvidenceArtifact.relativePath
      ? { ...item, content: Buffer.concat([item.content, Buffer.from("tampered")]) }
      : item),
    packageManifestSha256: hash(JSON_BYTES(enrolledPackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
  });
  assert.equal(tamperedEnrollmentEvidence.valid, false);

  const wrongAuthorityPair = generateKeyPairSync("ed25519");
  const wrongAuthorityRegistry = {
    ...trustedEnrollmentAuthorityRegistry,
    entries: [{
      ...trustedEnrollmentAuthorityRegistry.entries[0],
      publicKeyPem: wrongAuthorityPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }],
  };
  const wrongAuthority = verifyBuildingReviewPackage({
    packageManifest: enrolledPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(enrolledPackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry: wrongAuthorityRegistry,
  });
  assert.equal(wrongAuthority.valid, false);

  const orphanEvidenceBytes = Buffer.from("orphaned-enrollment-evidence");
  const orphanRelativePath = "evidence/device-enrollments/orphan-device.enrollment.json";
  const orphanArtifact = {
    artifactType: "single-image-survey-device-enrollment-evidence",
    deviceId: "orphan-device",
    authorityId: "synthetic-survey-enrollment-office",
    authorityType: "independent-enrollment-authority",
    authorityRegistryId: trustedEnrollmentAuthorityRegistry.registryId,
    relativePath: orphanRelativePath,
    sha256: hash(orphanEvidenceBytes),
    bytes: orphanEvidenceBytes.length,
  };
  const orphanPackage = {
    ...enrolledPackageManifest,
    counts: {
      ...enrolledPackageManifest.counts,
      artifacts: enrolledPackageManifest.counts.artifacts + 1,
      totalBytes: enrolledPackageManifest.counts.totalBytes + orphanEvidenceBytes.length,
    },
    artifacts: [...enrolledPackageManifest.artifacts, orphanArtifact],
  };
  const orphanReport = verifyBuildingReviewPackage({
    packageManifest: orphanPackage,
    actualFiles: [...enrolledActualFiles, {
      relativePath: orphanRelativePath, sha256: orphanArtifact.sha256,
      bytes: orphanEvidenceBytes.length, content: orphanEvidenceBytes, isRegularFile: true,
    }],
    packageManifestSha256: hash(JSON_BYTES(orphanPackage)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
  });
  assert.equal(orphanReport.valid, false);

  const deviceWithoutRegistry = verifyBuildingReviewPackage({
    packageManifest: devicePackageManifest,
    actualFiles: deviceActualFiles,
    packageManifestSha256: hash(JSON_BYTES(devicePackageManifest)),
    trustedSurveyorRegistry,
  });
  assert.equal(deviceWithoutRegistry.valid, false);
  assert.ok(deviceWithoutRegistry.errors.some((item) =>
    item.message.includes("trusted-survey-device-registry-required-for-package-schema-1.5.0")));

  const missingDeviceSidecars = deviceActualFiles.filter((file) =>
    file.relativePath !== deviceSidecars[0].relativePath);
  const missingDevice = verifyBuildingReviewPackage({
    packageManifest: devicePackageManifest,
    actualFiles: missingDeviceSidecars,
    packageManifestSha256: hash(JSON_BYTES(devicePackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
  });
  assert.equal(missingDevice.valid, false);
  assert.ok(missingDevice.errors.some((item) =>
    item.id === "file-present:" + deviceSidecars[0].relativePath));

  const tamperedDeviceSidecars = deviceActualFiles.map((file) =>
    file.relativePath === deviceSidecars[0].relativePath
      ? { ...file, content: Buffer.concat([file.content, Buffer.from("tampered")]) }
      : file);
  const tamperedDevice = verifyBuildingReviewPackage({
    packageManifest: devicePackageManifest,
    actualFiles: tamperedDeviceSidecars,
    packageManifestSha256: hash(JSON_BYTES(devicePackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
  });
  assert.equal(tamperedDevice.valid, false);

  const wrongDevicePair = generateKeyPairSync("ed25519");
  const wrongDeviceRegistry = {
    ...trustedDeviceRegistry,
    entries: [{
      ...trustedDeviceRegistry.entries[0],
      publicKeyPem: wrongDevicePair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }],
  };
  const wrongDeviceSigner = verifyBuildingReviewPackage({
    packageManifest: devicePackageManifest,
    actualFiles: deviceActualFiles,
    packageManifestSha256: hash(JSON_BYTES(devicePackageManifest)),
    trustedSurveyorRegistry,
    trustedDeviceRegistry: wrongDeviceRegistry,
  });
  assert.equal(wrongDeviceSigner.valid, false);

  // D3M-20: bind the exact raw bytes for all three external registries. The
  // registries remain external; the package records only ID/type/schema/hash/size.
  const trustRegistryRaw = {
    trustedSurveyorRegistry: JSON.stringify(trustedSurveyorRegistry),
    trustedDeviceRegistry: JSON.stringify(trustedDeviceRegistry),
    trustedEnrollmentAuthorityRegistry: JSON.stringify(trustedEnrollmentAuthorityRegistry),
  };
  const trustRegistryInventory = buildTrustRegistrySnapshotInventory(trustRegistryRaw);
  const snapshotEvidence = {
    ...enrolledEvidence,
    schemaVersion: "1.7.0",
    trustRegistrySnapshotSchemaVersion: trustRegistryInventory.schemaVersion,
    trustRegistrySnapshotCount: trustRegistryInventory.count,
    trustRegistrySnapshotBytes: trustRegistryInventory.totalBytes,
    trustRegistrySnapshotsSha256: trustRegistryInventory.sha256,
    trustRegistrySnapshots: trustRegistryInventory.entries,
  };
  assert.throws(() => buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: enrolledPackageManifest.artifacts,
    singleImageEvidence: {
      ...snapshotEvidence,
      trustedSurveyorRegistryId: "wrong-snapshot-role-id",
    },
    generatedAt: registryNow.toISOString(),
  }));

  const snapshotPackageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: enrolledPackageManifest.artifacts,
    singleImageEvidence: snapshotEvidence,
    generatedAt: registryNow.toISOString(),
  });
  const snapshotReport = verifyBuildingReviewPackage({
    packageManifest: snapshotPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(snapshotPackageManifest)),
    ...trustRegistryRaw,
  });
  assert.equal(snapshotReport.valid, true, JSON.stringify(snapshotReport.errors));
  assert.equal(snapshotPackageManifest.singleImageEvidence.schemaVersion, "1.7.0");
  assert.equal(snapshotPackageManifest.singleImageEvidence.trustRegistrySnapshotCount, 3);
  assert.equal(snapshotPackageManifest.singleImageEvidence.trustRegistrySnapshotBytes, trustRegistryInventory.totalBytes);
  assert.equal(snapshotPackageManifest.singleImageEvidence.trustRegistrySnapshotsSha256, trustRegistryInventory.sha256);
  assert.doesNotMatch(JSON.stringify(snapshotPackageManifest), /BEGIN PUBLIC KEY|BEGIN PRIVATE KEY/);
  assert.deepEqual(Object.keys(snapshotPackageManifest.singleImageEvidence.trustRegistrySnapshots[0]), [
    "role", "recordType", "registryId", "schemaVersion", "sha256", "bytes",
  ]);
  assert.equal(snapshotReport.publicationEligible, false);
  assert.ok(snapshotReport.checks.some((item) =>
    item.id === "single-image-georeference-recomputed" && item.status === "passed"));

  const missingDeviceRegistrySnapshot = verifyBuildingReviewPackage({
    packageManifest: snapshotPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(snapshotPackageManifest)),
    trustedSurveyorRegistry: trustRegistryRaw.trustedSurveyorRegistry,
    trustedEnrollmentAuthorityRegistry: trustRegistryRaw.trustedEnrollmentAuthorityRegistry,
  });
  assert.equal(missingDeviceRegistrySnapshot.valid, false);
  assert.ok(missingDeviceRegistrySnapshot.errors.length > 0);

  // JSON semantics and registryId remain the same, but a trailing newline
  // changes the exact external registry bytes and must invalidate schema 1.7.
  const whitespaceChangedSurveyorRegistry = trustRegistryRaw.trustedSurveyorRegistry + "\n";
  const changedRegistrySnapshot = verifyBuildingReviewPackage({
    packageManifest: snapshotPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(snapshotPackageManifest)),
    ...trustRegistryRaw,
    trustedSurveyorRegistry: whitespaceChangedSurveyorRegistry,
  });
  assert.equal(changedRegistrySnapshot.valid, false);
  assert.ok(changedRegistrySnapshot.errors.some((item) =>
    item.message.includes("trust-registry-snapshot-verification-failed")));

  const forgedSnapshotDigestManifest = {
    ...snapshotPackageManifest,
    singleImageEvidence: {
      ...snapshotPackageManifest.singleImageEvidence,
      trustRegistrySnapshotsSha256: "f".repeat(64),
    },
  };
  const forgedSnapshotDigest = verifyBuildingReviewPackage({
    packageManifest: forgedSnapshotDigestManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(forgedSnapshotDigestManifest)),
    ...trustRegistryRaw,
  });
  assert.equal(forgedSnapshotDigest.valid, false);

  const forgedSnapshotBytesManifest = {
    ...snapshotPackageManifest,
    singleImageEvidence: {
      ...snapshotPackageManifest.singleImageEvidence,
      trustRegistrySnapshotBytes: snapshotPackageManifest.singleImageEvidence.trustRegistrySnapshotBytes + 1,
    },
  };
  const forgedSnapshotBytes = verifyBuildingReviewPackage({
    packageManifest: forgedSnapshotBytesManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(forgedSnapshotBytesManifest)),
    ...trustRegistryRaw,
  });
  assert.equal(forgedSnapshotBytes.valid, false);

  const missingSnapshotEntryManifest = {
    ...snapshotPackageManifest,
    singleImageEvidence: {
      ...snapshotPackageManifest.singleImageEvidence,
      trustRegistrySnapshots: snapshotPackageManifest.singleImageEvidence.trustRegistrySnapshots.slice(1),
    },
  };
  const missingSnapshotEntry = verifyBuildingReviewPackage({
    packageManifest: missingSnapshotEntryManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(missingSnapshotEntryManifest)),
    ...trustRegistryRaw,
  });
  assert.equal(missingSnapshotEntry.valid, false);

  // D3M-21: sign and independently verify governance approval for the exact
  // D3M-20 inventory, using an external pinned key and a persisted sequence floor.
  const governancePair = generateKeyPairSync("ed25519");
  const governancePublicKeyPem = governancePair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const governanceExpiresAt = new Date(registryNow.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
  const governanceAttestation = signTrustRegistryGovernanceAttestation({
    snapshotInventory: trustRegistryInventory,
    registrySetId: "survey-trust-q4-2026",
    sequence: 41,
    issuedAtUtc: registryNow.toISOString(),
    expiresAtUtc: governanceExpiresAt,
    governanceKeyId: "synthetic-trust-governance-root-01",
    privateKey: governancePair.privateKey,
  });
  const governanceResult = verifyTrustRegistryGovernanceAttestation({
    attestation: governanceAttestation,
    governancePublicKeyPem,
    minimumSequence: 41,
    snapshotInventory: trustRegistryInventory,
    now: registryNow,
  });
  assert.equal(governanceResult.valid, true, JSON.stringify(governanceResult.errors));

  const governedEvidence = {
    ...snapshotEvidence,
    schemaVersion: "1.8.0",
    trustRegistryGovernance: governanceResult.metadata,
  };
  const governedPackageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: enrolledPackageManifest.artifacts,
    singleImageEvidence: governedEvidence,
    generatedAt: registryNow.toISOString(),
  });
  const governedReport = verifyBuildingReviewPackage({
    packageManifest: governedPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(governedPackageManifest)),
    ...trustRegistryRaw,
    trustRegistryGovernanceAttestation: governanceAttestation,
    trustRegistryGovernancePublicKeyPem: governancePublicKeyPem,
    minimumTrustRegistrySequence: 41,
    trustRegistryGovernanceNow: registryNow,
  });
  assert.equal(governedReport.valid, true, JSON.stringify(governedReport.errors));
  assert.equal(governedPackageManifest.singleImageEvidence.schemaVersion, "1.8.0");
  assert.equal(governedReport.publicationEligible, false);
  assert.doesNotMatch(JSON.stringify(governedPackageManifest), /BEGIN PRIVATE KEY|BEGIN PUBLIC KEY/);

  const missingGovernanceTrust = verifyBuildingReviewPackage({
    packageManifest: governedPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(governedPackageManifest)),
    ...trustRegistryRaw,
    trustRegistryGovernanceNow: registryNow,
  });
  assert.equal(missingGovernanceTrust.valid, false);

  const rollbackReport = verifyBuildingReviewPackage({
    packageManifest: governedPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(governedPackageManifest)),
    ...trustRegistryRaw,
    trustRegistryGovernanceAttestation: governanceAttestation,
    trustRegistryGovernancePublicKeyPem: governancePublicKeyPem,
    minimumTrustRegistrySequence: 42,
    trustRegistryGovernanceNow: registryNow,
  });
  assert.equal(rollbackReport.valid, false);
  assert.ok(rollbackReport.errors.some((item) =>
    item.message.includes("trust-registry-governance-verification-failed")));

  const tamperedGovernanceEnvelope = JSON.parse(governanceAttestation);
  tamperedGovernanceEnvelope.sequence = 42;
  const tamperedGovernanceAttestation = JSON.stringify(tamperedGovernanceEnvelope);
  const tamperedGovernanceReport = verifyBuildingReviewPackage({
    packageManifest: governedPackageManifest,
    actualFiles: enrolledActualFiles,
    packageManifestSha256: hash(JSON_BYTES(governedPackageManifest)),
    ...trustRegistryRaw,
    trustRegistryGovernanceAttestation: tamperedGovernanceAttestation,
    trustRegistryGovernancePublicKeyPem: governancePublicKeyPem,
    minimumTrustRegistrySequence: 41,
    trustRegistryGovernanceNow: registryNow,
  });
  assert.equal(tamperedGovernanceReport.valid, false);

  // D3M-22: persist the accepted governance floor across offline verifier restarts.
  const governedDirectory = path.join(root, "governed-review-package");
  await mkdir(governedDirectory, { recursive: true });
  for (const file of enrolledActualFiles) {
    const destination = path.join(governedDirectory, ...file.relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: "wx" });
  }
  const directoryManifestPath = path.join(governedDirectory, "package-manifest.json");
  await writeFile(directoryManifestPath, JSON_BYTES(governedPackageManifest), { flag: "wx" });
  const stateFilePath = path.join(root, "operator-trust", "governance-state.json");
  const directoryVerifyArgs = {
    ...trustRegistryRaw,
    trustRegistryGovernanceAttestation: governanceAttestation,
    trustRegistryGovernancePublicKeyPem: governancePublicKeyPem,
    minimumTrustRegistrySequence: 40,
    trustRegistryGovernanceStateFilePath: stateFilePath,
    trustRegistryGovernanceNow: registryNow,
  };
  const firstDirectoryVerification = await verifyBuildingReviewPackageDirectory(
    governedDirectory,
    directoryVerifyArgs,
  );
  assert.equal(firstDirectoryVerification.integrity.valid, true,
    JSON.stringify(firstDirectoryVerification.integrity.errors));
  assert.equal(firstDirectoryVerification.governanceState.minimumAcceptedSequence, 41);
  assert.equal(firstDirectoryVerification.governanceState.revision, 1);

  const restartedDirectoryVerification = await verifyBuildingReviewPackageDirectory(
    governedDirectory,
    directoryVerifyArgs,
  );
  assert.equal(restartedDirectoryVerification.integrity.valid, true,
    JSON.stringify(restartedDirectoryVerification.integrity.errors));
  assert.equal(restartedDirectoryVerification.governanceState.minimumAcceptedSequence, 41);
  assert.equal(restartedDirectoryVerification.governanceState.revision, 1);


  // D3M-23: the package verifier can use an injected external store whose
  // monotonic anchor is maintained separately from its state document.
  let remoteRecord = null;
  let remoteVersion = 0;
  const clone = (value) => structuredClone(value);
  const anchorFor = (state) => ({
    revision: state.revision,
    minimumAcceptedSequence: state.minimumAcceptedSequence,
    stateSha256: state.stateSha256,
  });
  const remoteProvider = {
    providerId: "test-only-memory-anchor",
    async readState(identity) {
      if (!remoteRecord) return null;
      assert.equal(remoteRecord.state.registrySetId, identity.registrySetId);
      assert.equal(remoteRecord.state.governanceKeyFingerprintSha256,
        identity.governanceKeyFingerprintSha256);
      return clone(remoteRecord);
    },
    async initializeStateIfAbsent({ identity, state }) {
      if (remoteRecord) {
        assert.equal(remoteRecord.state.registrySetId, identity.registrySetId);
        return { created: false, ...clone(remoteRecord) };
      }
      remoteVersion += 1;
      remoteRecord = {
        version: "remote-v" + remoteVersion,
        state: clone(state),
        anchor: anchorFor(state),
      };
      return { created: true, ...clone(remoteRecord) };
    },
    async compareAndSetState({ expectedVersion, expectedStateSha256, nextState }) {
      if (!remoteRecord || remoteRecord.version !== expectedVersion ||
          remoteRecord.state.stateSha256 !== expectedStateSha256) {
        return { updated: false, ...clone(remoteRecord) };
      }
      remoteVersion += 1;
      remoteRecord = {
        version: "remote-v" + remoteVersion,
        state: clone(nextState),
        anchor: anchorFor(nextState),
      };
      return { updated: true, ...clone(remoteRecord) };
    },
  };
  const externalStore = createExternalTrustRegistryGovernanceStateStore({ provider: remoteProvider });
  const externalStoreVerifyArgs = {
    ...directoryVerifyArgs,
    trustRegistryGovernanceStateFilePath: null,
    trustRegistryGovernanceStateStore: externalStore,
  };
  const externalStoreVerification = await verifyBuildingReviewPackageDirectory(
    governedDirectory,
    externalStoreVerifyArgs,
  );
  assert.equal(externalStoreVerification.integrity.valid, true,
    JSON.stringify(externalStoreVerification.integrity.errors));
  assert.equal(externalStoreVerification.governanceState.storeType, "external");
  assert.equal(externalStoreVerification.governanceState.providerId, "test-only-memory-anchor");
  assert.equal(externalStoreVerification.governanceState.minimumAcceptedSequence, 41);
  assert.equal(externalStoreVerification.governanceState.revision, 1);
  const externalStoreRestart = await verifyBuildingReviewPackageDirectory(
    governedDirectory,
    externalStoreVerifyArgs,
  );
  assert.equal(externalStoreRestart.integrity.valid, true,
    JSON.stringify(externalStoreRestart.integrity.errors));
  assert.equal(externalStoreRestart.governanceState.stateSha256,
    externalStoreVerification.governanceState.stateSha256);

  const staleGovernanceAttestation = signTrustRegistryGovernanceAttestation({
    snapshotInventory: trustRegistryInventory,
    registrySetId: "survey-trust-q4-2026",
    sequence: 40,
    issuedAtUtc: registryNow.toISOString(),
    expiresAtUtc: governanceExpiresAt,
    governanceKeyId: "synthetic-trust-governance-root-01",
    privateKey: governancePair.privateKey,
  });
  const staleGovernanceResult = verifyTrustRegistryGovernanceAttestation({
    attestation: staleGovernanceAttestation,
    governancePublicKeyPem,
    minimumSequence: 40,
    snapshotInventory: trustRegistryInventory,
    now: registryNow,
  });
  assert.equal(staleGovernanceResult.valid, true);
  const stalePackageManifest = buildBuildingReviewPackageManifest({
    buildingId,
    readinessReport: readiness,
    renderManifestViews: renderManifest.views,
    artifacts: enrolledPackageManifest.artifacts,
    singleImageEvidence: {
      ...snapshotEvidence,
      schemaVersion: "1.8.0",
      trustRegistryGovernance: staleGovernanceResult.metadata,
    },
    generatedAt: registryNow.toISOString(),
  });
  await writeFile(directoryManifestPath, JSON_BYTES(stalePackageManifest));
  const staleDirectoryVerification = await verifyBuildingReviewPackageDirectory(
    governedDirectory,
    {
      ...directoryVerifyArgs,
      trustRegistryGovernanceAttestation: staleGovernanceAttestation,
    },
  );
  assert.equal(staleDirectoryVerification.integrity.valid, false);
  assert.ok(staleDirectoryVerification.integrity.errors.some((item) =>
    item.message.includes("trust-registry-governance-verification-failed")));
  assert.equal(staleDirectoryVerification.governanceState.minimumAcceptedSequence, 41);
});


test("canonical survey observation inventory is deterministic, bounded and rejects unsafe records", () => {
  const records = Array.from({ length: 6 }, (_, index) => {
    const observationId = index === 1 ? "Obs-2" : "obs-" + (index + 1);
    return {
      observationId,
      relativePath: singleImageSurveyObservationRecordPath(observationId),
      sha256: String(index + 1).repeat(64),
      bytes: 128 + index,
    };
  });
  const first = buildSingleImageSurveyObservationRecordInventory(records);
  const reversed = buildSingleImageSurveyObservationRecordInventory([...records].reverse());
  assert.equal(first.sha256, reversed.sha256);
  assert.equal(first.count, 6);
  assert.equal(first.totalBytes, records.reduce((sum, item) => sum + item.bytes, 0));
  assert.deepEqual(first.records.map((item) => item.observationId),
    ["Obs-2", "obs-1", "obs-3", "obs-4", "obs-5", "obs-6"]);

  assert.throws(() => singleImageSurveyObservationRecordPath("../outside"), /invalid/i);
  assert.throws(() => singleImageSurveyObservationRecordPath("CON"), /invalid/i);
  assert.throws(() => singleImageSurveyObservationRecordPath("trailing."), /invalid/i);
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory([
    ...records,
    { ...records[0] },
  ]), /invalid/i);
  const caseCollision = {
    ...records[0],
    observationId: records[0].observationId.toUpperCase(),
    relativePath: singleImageSurveyObservationRecordPath(records[0].observationId.toUpperCase()),
  };
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory([...records, caseCollision]), /invalid/i);
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory(
    records.map((item, index) => index === 0 ? { ...item, relativePath: "evidence/other.record" } : item),
  ), /invalid/i);
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory(
    records.map((item, index) => index === 0 ? { ...item, sha256: "z".repeat(64) } : item),
  ), /invalid/i);
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory(
    records.map((item, index) => index === 0 ? { ...item, bytes: MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES + 1 } : item),
  ), /invalid/i);
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory(
    Array.from({ length: 9 }, (_, index) => ({
      observationId: "large-" + (index + 1),
      relativePath: singleImageSurveyObservationRecordPath("large-" + (index + 1)),
      sha256: String(index + 1).repeat(64),
      bytes: MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
    })),
  ), /aggregate limit/i);
  assert.throws(() => buildSingleImageSurveyObservationRecordInventory(
    Array.from({ length: 101 }, (_, index) => ({
      observationId: "many-" + (index + 1),
      relativePath: singleImageSurveyObservationRecordPath("many-" + (index + 1)),
      sha256: "a".repeat(64),
      bytes: 1,
    })),
  ), /6–100/i);
});


test("stable survey record workspace reader preserves bytes and rejects missing, unsafe, symlink and oversized inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m15-survey-record-reader-"));
  const evidenceDir = path.join(root, "evidence", "survey-observations");
  await mkdir(evidenceDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const observationId = "stable-read-observation";
  const relativePath = singleImageSurveyObservationRecordPath(observationId);
  const filePath = path.join(root, ...relativePath.split("/"));
  const originalBytes = Buffer.from([0, 1, 2, 10, 13, 127, 128, 255]);
  await writeFile(filePath, originalBytes, { flag: "wx" });

  const result = await readStableSingleImageSurveyObservationRecord({
    workspaceRoot: root,
    observationId,
  });
  assert.equal(result.relativePath, relativePath);
  assert.equal(result.sha256, hash(originalBytes));
  assert.deepEqual(result.bytes, originalBytes);

  await assert.rejects(
    () => readStableSingleImageSurveyObservationRecord({ workspaceRoot: root, observationId: "missing-record" }),
  );
  await assert.rejects(
    () => readStableSingleImageSurveyObservationRecord({ workspaceRoot: root, observationId: "../outside" }),
    /invalid/i,
  );

  const symlinkId = "symlink-observation";
  const symlinkPath = path.join(root, ...singleImageSurveyObservationRecordPath(symlinkId).split("/"));
  const targetPath = path.join(evidenceDir, "target.record");
  await writeFile(targetPath, Buffer.from("target"), { flag: "wx" });
  await symlink(targetPath, symlinkPath);
  await assert.rejects(
    () => readStableSingleImageSurveyObservationRecord({ workspaceRoot: root, observationId: symlinkId }),
    /symbolic links/i,
  );

  const oversizedId = "oversized-observation";
  const oversizedPath = path.join(root, ...singleImageSurveyObservationRecordPath(oversizedId).split("/"));
  await writeFile(oversizedPath, Buffer.from("x"), { flag: "wx" });
  await truncate(oversizedPath, MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES + 1);
  await assert.rejects(
    () => readStableSingleImageSurveyObservationRecord({ workspaceRoot: root, observationId: oversizedId }),
    /size limit/i,
  );
});
