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
    const bytes = filename.endsWith(".png")
      ? Buffer.from([137,80,78,71,13,10,26,10,0,1,2])
      : Buffer.from("synthetic-evidence-" + role);
    await writeFile(path.join(artifactRoot, filename), bytes);
    evidenceBindings[role] = { filename, byteSize: bytes.length, sha256: sha(bytes) };
  }
  const decision = {
    schemaVersion: "1.0.0", recordType: "brf-21-human-review-decision", sampleId: "test-sample",
    evidenceBindings, reviewer: { name: "Synthetic Reviewer", identifier: "synthetic-reviewer" },
    reviewedAtUtc: "2026-10-27T10:00:00Z", overallDisposition: "continue-to-reconstruction-preflight",
    sameBuildingIdentity: { decision: "confirmed", rationale: "Synthetic test decision only." },
    coverageAssessment: { decision: "adequate", rationale: "Synthetic test decision only." },
    sourceUpAxis: { decision: "confirmed", axis: "Z", positiveDirection: "positive",
      interpretation: "Synthetic Z-up axis.", rationale: "Synthetic test decision only." },
    assetRights: { decision: "approved-for-this-use", termsSourceUrl: "https://example.org/terms",
      rationale: "Synthetic test decision only." },
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

  const mediaRoot = path.join(workspaceRoot, ".building-engine", "media", "building-one");
  const sourceRoot = path.join(mediaRoot, "sources");
  const assetRoot = path.join(mediaRoot, "assets");
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(assetRoot, { recursive: true })]);
  const sourceRecords = [];
  const sourceImages = [];
  for (let i=1; i<=3; i++) {
    const bytes = Buffer.concat([Buffer.from([255,216,255]), Buffer.from("test-jpeg-" + i)]);
    const hash = sha(bytes);
    const filename = "candidate-" + i + ".jpg";
    await writeFile(path.join(imageRoot, filename), bytes);
    sourceImages.push({ filename, byteSize: bytes.length, sha256: hash, status: "verified" });
    const relativePath = ".building-engine/media/building-one/assets/" + hash + ".jpg";
    await writeFile(path.join(workspaceRoot, relativePath), bytes);
    const record = { id: "view-" + i, buildingId: "building-one", kind: "image", mimeType: "image/jpeg",
      usageStatus: "approved", licence: "CC BY 4.0", sha256: hash, assetId: hash, relativePath };
    await writeFile(path.join(sourceRoot, record.id + ".json"), JSON.stringify(record, null, 2) + "\n");
    sourceRecords.push(record);
  }
  const report = {
    schemaVersion: "1.0.0", recordType: "brf-23-reconstruction-preflight-report", sampleId: "test-sample",
    profileId: profile.profileId, status: "preflight-ready-for-local-reconstruction-attempt",
    assessedInputs: {
      evidenceBindings,
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
  return { workspaceRoot, artifactRoot, imageRoot, report, reportBytes, sourceRecords };
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
  for (const type of ["evidence", "decision", "profile", "image"]) {
    const f = await setup(t);
    const target = type === "evidence" ? path.join(f.artifactRoot, artifacts.overlapGraph)
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
test("records authorization only after validated inputs and keeps all release gates closed", async t => {
  const f = await setup(t);
  let seen;
  const result = await runBrf23AuthorizedColmapReconstruction(optionsFor(f, {
    workerImpl: async args => {
      seen = args;
      return { jobDir: args.workspaceRoot, modelPath: "mock.glb",
        reportPath: path.join(args.workspaceRoot, "mock-report.json"),
        report: { status: "completed-requires-review", outputs: { glb: {
          sha256: "d".repeat(64), relativePath: "model.glb", bytes: 2048,
        } } } };
    },
  }));
  assert.equal(seen.matchConfirmed, true);
  assert.equal(seen.overlapReviewed, true);
  assert.equal(seen.upAxisReviewed, true);
  assert.equal(seen.upAxis, "Z");
  assert.deepEqual(seen.scaleCalibration, {});
  assert.equal(result.authorization.candidateGlbGenerated, true);
  assert.equal(result.report.candidateGeometryValidated, false);
  assert.equal(result.report.independentReferenceVerified, false);
  assert.equal(result.report.heldOutCheckpointAccuracyVerified, false);
  assert.equal(result.report.acceptanceEligible, false);
  assert.equal(result.report.publicationEligible, false);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.automaticApproval, false);
  const saved = JSON.parse(await readFile(result.authorizationPath, "utf8"));
  assert.equal(saved.preflightReport.sha256, sha(f.reportBytes));
});
