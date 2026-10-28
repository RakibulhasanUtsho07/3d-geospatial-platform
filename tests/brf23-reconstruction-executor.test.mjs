import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBrf23AuthorizedColmapReconstruction, validateBrf23ExecutionReport } from "../src/core/building-generation/brf23-reconstruction-executor.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const artifacts = {
  sourceManifest: "brf-14-multiview-source.json",
  byteVerificationReport: "multiview-source-byte-verification.json",
  reviewManifest: "multiview-review-manifest.json",
  overlapReport: "pairwise-overlap-report.json",
  contactSheet: "multiview-contact-sheet.png",
  cameraCoveragePlot: "camera-angle-coverage.png",
  overlapGraph: "pairwise-overlap-graph.png",
  privateMediaQualityReport: "private-multiview-media-intake-report.json",
};
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf24-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const artifactRoot = path.join(root, "artifacts");
  const imageRoot = path.join(root, "images");
  await Promise.all([mkdir(workspaceRoot), mkdir(artifactRoot), mkdir(imageRoot)]);
  const evidenceBindings = {};
  for (const [role, filename] of Object.entries(artifacts)) {
    let bytes;
    if (filename.endsWith(".png")) {
      bytes = Buffer.from([137,80,78,71,13,10,26,10,0,1,2]);
    } else if (["sourceManifest", "byteVerificationReport", "privateMediaQualityReport"].includes(role)) {
      bytes = Buffer.from("{}\n");
    } else {
      bytes = Buffer.from("synthetic-evidence-" + role);
    }
    await writeFile(path.join(artifactRoot, filename), bytes);
    evidenceBindings[role] = { filename, byteSize: bytes.length, sha256: sha(bytes) };
  }

  const mediaRoot = path.join(workspaceRoot, ".building-engine", "media", "building-one");
  const sourceRoot = path.join(mediaRoot, "sources");
  const assetRoot = path.join(mediaRoot, "assets");
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(assetRoot, { recursive: true })]);
  const sourceRecords = [];
  const sourceImages = [];
  const sourceViews = [];
  for (let i=1; i<=3; i++) {
    const bytes = Buffer.concat([Buffer.from([255,216,255]), Buffer.from("test-jpeg-" + i)]);
    const hash = sha(bytes);
    const filename = "candidate-" + i + ".jpg";
    await writeFile(path.join(imageRoot, filename), bytes);
    sourceImages.push({ filename, byteSize: bytes.length, sha256: hash, status: "verified" });
    sourceViews.push({
      id: "view-" + i,
      filename,
      expectedSha256: hash,
      expectedByteSize: bytes.length,
      sourceUrl: "https://example.test/synthetic/" + filename,
      declaredWidth: 100,
      declaredHeight: 100,
    });
    const relativePath = ".building-engine/media/building-one/assets/" + hash + ".jpg";
    await writeFile(path.join(workspaceRoot, relativePath), bytes);
    const record = { id: "view-" + i, buildingId: "building-one", kind: "image", mimeType: "image/jpeg",
      usageStatus: "approved", licence: "Synthetic test rights; not real permission", sha256: hash, assetId: hash, relativePath };
    await writeFile(path.join(sourceRoot, record.id + ".json"), JSON.stringify(record, null, 2) + "\n");
    sourceRecords.push(record);
  }

  const totalBytes = sourceViews.reduce((sum, view) => sum + view.expectedByteSize, 0);
  const dataset = {
    sourceRepositoryCommit: "synthetic-source-commit",
    license: "CC BY 4.0",
    licenseScope: "Synthetic fixtures only; not a real rights decision.",
    rightsStatus: "source-declared-not-independently-authenticated",
    attribution: "Synthetic test attribution only.",
  };
  const sourceManifest = {
    schemaVersion: "1.0.0",
    evaluationStage: "multiview-source-byte-intake-only",
    sampleId: "test-sample",
    dataset,
    selectionMethod: { expectedViewCount: sourceViews.length },
    expectedTotalBytes: totalBytes,
    views: sourceViews,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  };
  const sourceManifestBytes = Buffer.from(JSON.stringify(sourceManifest, null, 2) + "\n");
  await writeFile(path.join(artifactRoot, artifacts.sourceManifest), sourceManifestBytes);
  evidenceBindings.sourceManifest = { filename: artifacts.sourceManifest, byteSize: sourceManifestBytes.length,
    sha256: sha(sourceManifestBytes) };

  const byteReport = {
    schemaVersion: "1.0.0",
    status: "views-byte-verified",
    sampleId: "test-sample",
    dataset: { sourceRepositoryCommit: dataset.sourceRepositoryCommit },
    selectedViewCount: sourceViews.length,
    declaredTotalBytes: totalBytes,
    actualTotalBytes: totalBytes,
    blockers: [],
    views: sourceViews.map(view => ({
      id: view.id, filename: view.filename, status: "passed",
      expectedSha256: view.expectedSha256, actualSha256: view.expectedSha256,
      expectedByteSize: view.expectedByteSize, actualByteSize: view.expectedByteSize,
      sizeMatches: true, hashMatches: true,
    })),
  };
  const byteReportBytes = Buffer.from(JSON.stringify(byteReport, null, 2) + "\n");
  await writeFile(path.join(artifactRoot, artifacts.byteVerificationReport), byteReportBytes);
  evidenceBindings.byteVerificationReport = { filename: artifacts.byteVerificationReport, byteSize: byteReportBytes.length,
    sha256: sha(byteReportBytes) };

  const qualitySummary = {
    status: "all-images-decoded-and-measured",
    qualityAnalysisComplete: true,
    sourceCount: sourceViews.length,
    uniqueContentCount: sourceViews.length,
    rightsApproved: false,
    safeToSubmitToColmap: false,
    sources: sourceViews.map(view => ({
      sourceId: view.id,
      sha256: view.expectedSha256,
      byteSize: view.expectedByteSize,
      width: view.declaredWidth,
      height: view.declaredHeight,
      usageStatus: "unreviewed",
      licence: "CC BY 4.0 (source-declared only; rights not independently authenticated)",
      quality: { decodeStatus: "decoded", fixtureOnly: true },
      error: null,
    })),
    limitations: ["Synthetic fixture only; no actual rights or accuracy decision."],
  };
  const qualityReport = {
    schemaVersion: "1.0.0",
    evaluationId: "BRF-42-PRIVATE-MULTIVIEW-INTAKE",
    status: "private-multiview-preflight-complete-not-reconstruction-approved",
    workspaceMode: "ephemeral-private",
    sourceManifest: {
      sourceCommit: dataset.sourceRepositoryCommit,
      declaredLicense: dataset.license,
      licenseScope: dataset.licenseScope,
      rightsStatus: dataset.rightsStatus,
      attribution: dataset.attribution,
      manifestSha256: sha(sourceManifestBytes),
      priorVerificationReportSha256: sha(byteReportBytes),
      freshVerificationReportSha256: sha(Buffer.from("synthetic-fresh-verification")),
    },
    byteVerification: {
      status: "views-byte-verified",
      selectedViewCount: sourceViews.length,
      verifiedViewCount: sourceViews.length,
      declaredTotalBytes: totalBytes,
      actualTotalBytes: totalBytes,
      blockers: [],
    },
    privateMediaIntake: {
      status: "all-views-ingested-private",
      buildingId: "brf42-synthetic-test",
      selectedViewCount: sourceViews.length,
      ingestedCount: sourceViews.length,
      records: sourceViews.map(view => ({
        sourceId: view.id,
        sha256: view.expectedSha256,
        byteSize: view.expectedByteSize,
        sourceUrl: view.sourceUrl,
        usageStatus: "unreviewed",
        licence: "CC BY 4.0 (source-declared only; rights not independently authenticated)",
      })),
    },
    imageQualityPreflight: qualitySummary,
    reviewAndRelease: {
      rightsReview: "pending-human-review",
      sameBuildingIdentity: "source-declared-not-independently-confirmed",
      visualOverlap: "pending-human-review",
      facadeRoofCoverage: "pending-human-review",
      sourceUpAxis: "pending-human-review",
      independentReferenceVerified: false,
      candidateGlbGenerated: false,
      reconstructionExecuted: false,
      realWorldAccuracyValidated: false,
      publicSourceRedistributionPermittedByThisGate: false,
      derivedModelPublicationPermittedByThisGate: false,
      productionMapPublicationPermitted: false,
    },
    releaseFlags: {
      acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false,
    },
    note: "Synthetic test evidence only; this report never authorizes reconstruction.",
  };
  const qualityReportBytes = Buffer.from(JSON.stringify(qualityReport, null, 2) + "\n");
  await writeFile(path.join(artifactRoot, artifacts.privateMediaQualityReport), qualityReportBytes);
  evidenceBindings.privateMediaQualityReport = { filename: artifacts.privateMediaQualityReport,
    byteSize: qualityReportBytes.length, sha256: sha(qualityReportBytes) };

  const decision = {
    schemaVersion: "1.0.0", recordType: "brf-21-human-review-decision", sampleId: "test-sample",
    evidenceBindings, reviewer: { name: "Synthetic Reviewer", identifier: "synthetic-reviewer" },
    reviewedAtUtc: "2026-10-27T10:00:00Z", overallDisposition: "continue-to-reconstruction-preflight",
    sameBuildingIdentity: { decision: "confirmed", rationale: "Synthetic test decision only." },
    coverageAssessment: { decision: "adequate", rationale: "Synthetic test decision only." },
    sourceUpAxis: { decision: "confirmed", axis: "Z", positiveDirection: "positive",
      interpretation: "Synthetic Z-up axis.", rationale: "Synthetic test decision only." },
    assetRights: { decision: "approved-for-this-use", termsSourceUrl: "https://example.org/terms",
      rationale: "Synthetic test decision only; BRF-42 status must still be respected." },
  };
  const decisionBytes = Buffer.from(JSON.stringify(decision, null, 2) + "\n");
  await writeFile(path.join(artifactRoot, "decision.json"), decisionBytes);
  const profile = {
    schemaVersion: "1.0.0", profileId: "test-profile",
    toolchain: { name: "COLMAP", executable: "/fake/colmap", expectedVersion: "4.2.1", versionCommand: ["version"] },
    coordinateFrame: { policy: "local-only-no-georeference", frameId: "test-local-frame",
      units: "unscaled-local", registrationToGps: "not-established" },
    execution: { preflightOnly: true, runReconstruction: false, generateCandidateGlb: false },
  };
  const profileBytes = Buffer.from(JSON.stringify(profile, null, 2) + "\n");
  await writeFile(path.join(artifactRoot, "profile.json"), profileBytes);

  const report = {
    schemaVersion: "1.0.0", recordType: "brf-23-reconstruction-preflight-report", sampleId: "test-sample",
    profileId: profile.profileId, status: "preflight-ready-for-local-reconstruction-attempt",
    assessedInputs: {
      evidenceBindings,
      imageQualityPreflight: qualitySummary,
      humanDecision: { filename: "decision.json", byteSize: decisionBytes.length, sha256: sha(decisionBytes),
        validationStatus: "valid", overallDisposition: decision.overallDisposition,
        reviewer: decision.reviewer, reviewedAtUtc: decision.reviewedAtUtc },
      profile: { filename: "profile.json", byteSize: profileBytes.length, sha256: sha(profileBytes) },
      sourceImages: { verifiedCount: 3, expectedCount: 3, records: sourceImages },
    },
    humanReview: { sameBuildingIdentity: "confirmed", coverageAssessment: "adequate",
      sourceUpAxis: "confirmed", assetRights: "approved-for-this-use" },
    reviewCounts: { includedViews: 3, humanConfirmedUsefulOverlapPairs: 2 },
    toolchain: { status: "verified", executable: "/fake/colmap", resolvedExecutable: "/fake/colmap",
      expectedVersion: "4.2.1", actualVersion: "4.2.1" },
    coordinateFrame: { policy: "local-only-no-georeference", frameId: "test-local-frame",
      units: "unscaled-local", registrationToGps: "not-established", reviewedSourceUpAxis: "Z",
      reviewedSourceUpAxisPositiveDirection: "positive" },
    blockers: [], reconstructionExecuted: false, candidateGlbGenerated: false,
    independentReferenceVerified: false, acceptanceEligible: false, publicationEligible: false,
    mapReady: false, automaticApproval: false,
  };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(artifactRoot, "preflight.json"), reportBytes);
  return { workspaceRoot, artifactRoot, imageRoot, report, reportBytes, sourceRecords, qualityReport };
}
function optionsFor(f, overrides = {}) {
  return {
    workspaceRoot: f.workspaceRoot, buildingId: "building-one", jobId: "unit-test-job",
    buildingSpec: { id: "building-one", sources: f.sourceRecords.map(row => ({
      id: row.id, assetId: row.assetId, usageStatus: "approved", licence: row.licence,
    })) },
    sourceIds: f.sourceRecords.map(row => row.id), artifactRoot: f.artifactRoot, imageRoot: f.imageRoot,
    decisionName: "decision.json", profilePath: path.join(f.artifactRoot, "profile.json"),
    preflightReportName: "preflight.json", expectedPreflightReportSha256: sha(f.reportBytes),
    confirmExecution: true,
    preflightRunner: async ({ outputPath }) => writeFile(outputPath, f.reportBytes),
    colmapVersionProbe: async () => "4.2.1",
    workerImpl: async args => ({
      jobDir: path.join(args.workspaceRoot, ".building-engine", "jobs", args.buildingId, args.jobId),
      modelPath: "mock.glb", reportPath: path.join(args.workspaceRoot, "mock-report.json"),
      report: { status: "completed-requires-review", outputs: { glb: {
        sha256: "b".repeat(64), relativePath: ".building-engine/jobs/building-one/unit-test-job/model.glb", bytes: 1234,
      } }, mapReady: false, publicationEligible: false },
    }),
    ...overrides,
  };
}
test("accepts only a complete pinned local-only preflight structure", async t => {
  const f = await setup(t);
  const result = validateBrf23ExecutionReport(f.report);
  assert.equal(result.tool.expectedVersion, "4.2.1");
  assert.equal(result.imageSet.records.length, 3);
  assert.equal(result.frame.registrationToGps, "not-established");
  assert.equal(f.report.publicationEligible, false);
});
test("blocks pending review, stale report hashes, or absent operator confirmation before worker", async t => {
  const f = await setup(t);
  const blocked = { ...f.report, status: "blocked", blockers: ["pending human decision"] };
  const bytes = Buffer.from(JSON.stringify(blocked, null, 2) + "\n");
  await writeFile(path.join(f.artifactRoot, "preflight.json"), bytes);
  let calls = 0;
  await assert.rejects(runBrf23AuthorizedColmapReconstruction(optionsFor(f, {
    expectedPreflightReportSha256: sha(bytes), workerImpl: async () => { calls++; throw Error("must not run"); },
  })), /preflight is blocked/);
  assert.equal(calls, 0);
  await assert.rejects(runBrf23AuthorizedColmapReconstruction(optionsFor(f, {
    expectedPreflightReportSha256: sha(f.reportBytes), confirmExecution: false,
  })), /Explicit operator confirmation/);
});
test("rejects modified report-bound evidence, decision, profile, and source bytes", async t => {
  for (const type of ["evidence", "quality", "decision", "profile", "image"]) {
    const f = await setup(t);
    const target = type === "evidence" ? path.join(f.artifactRoot, artifacts.overlapGraph)
      : type === "quality" ? path.join(f.artifactRoot, artifacts.privateMediaQualityReport)
      : type === "decision" ? path.join(f.artifactRoot, "decision.json")
      : type === "profile" ? path.join(f.artifactRoot, "profile.json")
      : path.join(f.imageRoot, f.report.assessedInputs.sourceImages.records[0].filename);
    await writeFile(target, Buffer.from("tampered"));
    await assert.rejects(runBrf23AuthorizedColmapReconstruction(optionsFor(f)), /changed|differ|hash|SHA-256/i);
  }
});
test("rejects selected media not in the reviewed source hashes", async t => {
  const f = await setup(t);
  const sourcePath = path.join(f.workspaceRoot, ".building-engine", "media", "building-one", "sources", "view-1.json");
  const record = JSON.parse(await readFile(sourcePath, "utf8"));
  record.sha256 = "c".repeat(64); record.assetId = record.sha256;
  await writeFile(sourcePath, JSON.stringify(record, null, 2) + "\n");
  await assert.rejects(runBrf23AuthorizedColmapReconstruction(optionsFor(f)), /not in the BRF-23|different from pinned|BuildingSpec/i);
});
test("rejects unsupported frame, negative up-axis, and COLMAP version drift", async t => {
  const f = await setup(t);
  assert.throws(() => validateBrf23ExecutionReport({ ...f.report, coordinateFrame: {
    ...f.report.coordinateFrame, policy: "georeferenced",
  } }), /local-only/);
  assert.throws(() => validateBrf23ExecutionReport({ ...f.report, coordinateFrame: {
    ...f.report.coordinateFrame, reviewedSourceUpAxisPositiveDirection: "negative",
  } }), /positive X\/Y\/Z/);
  await assert.rejects(runBrf23AuthorizedColmapReconstruction(optionsFor(f, {
    colmapVersionProbe: async () => "4.2.0",
  })), /COLMAP version changed/);
});
test("blocks COLMAP before authorization when BRF-42 rights remain unreviewed", async t => {
  const f = await setup(t);
  let workerCalls = 0;
  await assert.rejects(runBrf23AuthorizedColmapReconstruction(optionsFor(f, {
    workerImpl: async () => { workerCalls += 1; throw new Error("worker must not run"); },
  })), /BRF-42 evidence cannot authorize COLMAP.*rights remain unreviewed.*worker was not started/);
  assert.equal(workerCalls, 0);
  await assert.rejects(
    readFile(path.join(f.workspaceRoot, ".building-engine", "authorizations", "building-one", "unit-test-job.json")),
    { code: "ENOENT" },
    "No authorization record should be created for unreviewed source rights.",
  );
});
