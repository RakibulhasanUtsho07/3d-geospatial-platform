import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { buildRenderCorrectionTasks } from "../src/core/building-generation/render-correction-tasks.mjs";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";
import { buildBuildingReviewPackageManifest } from "../src/core/building-generation/building-review-package.mjs";
import { verifyBuildingReviewPackage } from "../src/core/building-generation/building-review-package-integrity.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const semanticDigest = (value) => hash(Buffer.from(JSON.stringify(value)));
const JSON_BYTES = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

async function createFixture() {
  const spec = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
  const { glb } = generateProceduralGlb(spec);
  const candidateHash = hash(glb);
  const geometryQa = analyzeGlbQuality(glb);
  const textureQa = reviewGlbTextureBindings(glb);
  const referenceBuffers = new Map();
  const renderBuffers = new Map();
  const views = REQUIRED_REVIEW_VIEWS.map((id) => {
    const filename = id + ".png";
    const bytes = Buffer.from("fake-render-payload:" + id);
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
    const bytes = Buffer.from("fake-reference-payload:" + viewId);
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
  // Exercise the public workflow functions as the CLI does rather than invent a
  // hand-written verification result.
  const correctionTasks = buildRenderCorrectionTasks({
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: review.buildingId,
    reviewStatus: "needs-model-or-reference-correction",
    valid: true,
    publicationEligible: false,
    provenance: { sourceModelSha256: "a".repeat(64), renderManifestSha256: "b".repeat(64) },
    comparisons: [],
    viewsWithoutComparisons: [],
  });
  // The package test uses an empty backlog on purpose; any non-empty backlog
  // must have verification results before the release readiness gate can pass.
  assert.equal(correctionTasks.tasks.length, 0);
  const verification = verifyRenderCorrectionTasks(backlog, review);
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
  assert.throws(() => verifyBuildingReviewPackage({
    packageManifest: unsafe.packageManifest,
    actualFiles: unsafe.actualFiles,
    packageManifestSha256: hash(JSON_BYTES(unsafe.packageManifest)),
  }), /artifact-invalid/);
});
