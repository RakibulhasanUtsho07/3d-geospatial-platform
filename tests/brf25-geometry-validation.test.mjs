import assert from "node:assert/strict";
import test from "node:test";
import { assessBrf25CandidateBinding } from "../src/core/building-generation/brf25-geometry-validation.mjs";

const hash = (char) => char.repeat(64);
function authorization(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    recordType: "brf-24-colmap-execution-authorization",
    status: "candidate-generated-requires-review",
    candidateGlbGenerated: true,
    candidateGlb: { sha256: hash("a"), relativePath: "outputs/candidate.glb", byteSize: 1024 },
    humanDecision: { overallDisposition: "continue-to-reconstruction-preflight", reviewer: "reviewer-1", sha256: hash("b") },
    preflightReport: { sha256: hash("c") },
    profile: { sha256: hash("d") },
    toolchain: { name: "COLMAP", version: "4.2.1", versionRecheckedImmediatelyBeforeRun: true },
    coordinateFrame: { policy: "local-only-unscaled-not-georeferenced", registrationToGps: false },
    scaleCalibration: { status: "not-calibrated" },
    selectedSourceImages: [{ sha256: hash("1") }, { sha256: hash("2") }, { sha256: hash("3") }],
    candidateGeometryValidated: false,
    independentReferenceVerified: false,
    heldOutCheckpointAccuracyVerified: false,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
    ...overrides,
  };
}
function assess(record = authorization(), overrides = {}) {
  return assessBrf25CandidateBinding({
    authorization: record,
    candidateSha256: hash("a"),
    candidateByteSize: 1024,
    workspaceRoot: "/project/workspace",
    configuredCandidatePath: "/project/workspace/outputs/candidate.glb",
    expectedGlbSha256: hash("a"),
    ...overrides,
  });
}

test("binds one worker-generated GLB to the exact truth config without granting approval", () => {
  const result = assess();
  assert.equal(result.ready, true);
  assert.equal(result.status, "candidate-bound-review-only");
  assert.equal(result.binding.candidateGlbSha256, hash("a"));
  assert.equal(result.binding.colmapVersion, "4.2.1");
});

test("blocks a pending or missing candidate before any geometry evaluation", () => {
  const pending = assess(authorization({ status: "authorized-for-local-reconstruction-attempt", candidateGlbGenerated: false }));
  assert.equal(pending.ready, false);
  assert.ok(pending.blockers.some((item) => item.id === "candidate-generated"));
});

test("blocks when GLB bytes do not match the authorized candidate hash", () => {
  const result = assess(authorization(), { candidateSha256: hash("e") });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((item) => item.id === "actual-candidate-sha256"));
});

test("blocks a stale expected hash in the truth config", () => {
  const result = assess(authorization(), { expectedGlbSha256: hash("f") });
  assert.ok(result.blockers.some((item) => item.id === "config-candidate-sha256"));
});

test("blocks candidate path substitution between the authorization and truth config", () => {
  const result = assess(authorization(), { configuredCandidatePath: "/project/workspace/outputs/other.glb" });
  assert.ok(result.blockers.some((item) => item.id === "configured-candidate-path"));
});

test("blocks path traversal, reviewer disposition drift, and insufficient source views", () => {
  const traversal = assess(authorization({ candidateGlb: { sha256: hash("a"), relativePath: "../outside.glb", byteSize: 1024 } }));
  assert.ok(traversal.blockers.some((item) => item.id === "candidate-relative-path"));
  const decision = assess(authorization({ humanDecision: { overallDisposition: "pending", reviewer: "reviewer-1", sha256: hash("b") } }));
  assert.ok(decision.blockers.some((item) => item.id === "reviewer-disposition"));
  const views = assess(authorization({ selectedSourceImages: [{ sha256: hash("1") }, { sha256: hash("2") }] }));
  assert.ok(views.blockers.some((item) => item.id === "selected-source-hashes"));
});

test("blocks if any review-only or release gate was pre-set true", () => {
  for (const key of ["candidateGeometryValidated", "independentReferenceVerified", "heldOutCheckpointAccuracyVerified",
    "acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"]) {
    const result = assess(authorization({ [key]: true }));
    assert.ok(result.blockers.some((item) => item.id === "review-only-invariants"), key);
  }
});

test("blocks if COLMAP was not rechecked directly before execution or GPS registration is claimed", () => {
  const version = assess(authorization({ toolchain: { name: "COLMAP", version: "4.2.1", versionRecheckedImmediatelyBeforeRun: false } }));
  assert.ok(version.blockers.some((item) => item.id === "toolchain-rechecked"));
  const gps = assess(authorization({ coordinateFrame: { policy: "local", registrationToGps: true } }));
  assert.ok(gps.blockers.some((item) => item.id === "local-frame-policy"));
});
