import assert from "node:assert/strict";
import test from "node:test";
import { assessBuildingCaptureManifest, normalizeBuildingCaptureManifest } from "../src/core/building-generation/building-capture-manifest.mjs";

const reviewedAt = "2026-10-24T10:00:00Z";
const hash = (seed) => seed.toString(16).padStart(64, "0").slice(-64);
function source(id, purpose, side, index) {
  return {
    id, purpose, kind: purpose === "measurement-evidence" ? "document" : "photo", side,
    path: "evidence/" + id + ".bin", sha256: hash(index + 1), bytes: 1000 + index,
    sourceId: "source-record-" + id,
    rights: { status: "verified", evidenceId: "rights-" + id, reviewedBy: "reviewer-a", reviewedAt },
    camera: { status: purpose === "capture" ? "verified" : "unknown", headingDegrees: 90 },
    occlusion: { status: purpose === "capture" ? "partial" : "unknown", notes: "Visibility reviewed." },
  };
}
function fixture() {
  const sources = [
    source("capture-front", "capture", "front", 0),
    source("capture-back", "capture", "back", 1),
    source("capture-left", "capture", "left", 2),
    source("capture-right", "capture", "right", 3),
    source("reference-front", "reference", "front", 4),
    source("reference-back", "reference", "back", 5),
    source("reference-left", "reference", "left", 6),
    source("reference-right", "reference", "right", 7),
    source("survey-evidence", "measurement-evidence", "other", 8),
  ];
  const controls = [
    { longitude: 90.4000, latitude: 23.7000 },
    { longitude: 90.4010, latitude: 23.7000 },
    { longitude: 90.4000, latitude: 23.7010 },
    { longitude: 90.4010, latitude: 23.7010 },
  ].map((point, index) => ({ id: "gcp-" + index, status: "verified", ...point,
    sourceId: "survey-evidence", evidenceId: "survey-control-" + index, verifiedBy: "surveyor-a", verifiedAt: reviewedAt }));
  return {
    schemaVersion: "1.0.0", manifestId: "capture-pilot-a", buildingId: "pilot-building-a", createdAt: reviewedAt,
    buildingIdentity: { status: "verified", sourceId: "official-building-register",
      evidenceDescription: "Building identity cross-checked against a documented record.",
      verifiedBy: "reviewer-a", verifiedAt: reviewedAt },
    sources,
    measurements: ["x", "y", "z"].map((axis, index) => ({ id: "dimension-" + axis, axis, valueM: [20, 12, 30][index],
      uncertaintyM: 0.05, basis: "surveyed", status: "verified", sourceId: "survey-evidence",
      evidenceId: "survey-dimension-" + axis, verifiedBy: "surveyor-a", verifiedAt: reviewedAt })),
    controlPoints: controls,
  };
}
const fileIntegrity = (manifest) => manifest.sources.map((item) => ({
  sourceId: item.id, status: "passed", sha256: item.sha256, bytes: item.bytes,
}));

test("normalizes and reports a fully evidenced capture manifest as ready for review", () => {
  const manifest = fixture();
  const normalized = normalizeBuildingCaptureManifest(manifest);
  const report = assessBuildingCaptureManifest(normalized, { fileIntegrity: fileIntegrity(normalized) });
  assert.equal(report.status, "ready-for-review");
  assert.equal(report.readyForModelReview, true);
  assert.equal(report.counts.captures, 4);
  assert.equal(report.counts.references, 4);
  assert.equal(report.policy.mapReady, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.ok(report.checks.every((check) => check.status === "passed"));
});

test("missing side, hash pin, rights, dimensions, or camera metadata stays incomplete", () => {
  const manifest = fixture();
  manifest.sources = manifest.sources.filter((item) => item.id !== "capture-right");
  manifest.measurements = manifest.measurements.filter((item) => item.axis !== "z");
  manifest.sources[0].camera.status = "unknown";
  const report = assessBuildingCaptureManifest(manifest, { fileIntegrity: fileIntegrity(manifest) });
  assert.equal(report.status, "incomplete");
  assert.equal(report.readyForModelReview, false);
  assert.ok(report.checks.some((check) => check.id === "capture-source-coverage-and-rights" && check.status === "warning"));
  assert.ok(report.checks.some((check) => check.id === "independent-dimensions" && check.status === "warning"));
  assert.ok(report.checks.some((check) => check.id === "camera-and-occlusion-metadata" && check.status === "warning"));
});

test("rejects unsafe paths, duplicate IDs, unsupported axes and unknown evidence sources", () => {
  const unsafe = fixture();
  unsafe.sources[0].path = "../outside/photo.jpg";
  assert.throws(() => normalizeBuildingCaptureManifest(unsafe), /safe project-relative path/);
  const duplicate = fixture();
  duplicate.sources[1].id = duplicate.sources[0].id;
  assert.throws(() => normalizeBuildingCaptureManifest(duplicate), /duplicate id/);
  const badAxis = fixture();
  badAxis.measurements[0].axis = "height";
  assert.throws(() => normalizeBuildingCaptureManifest(badAxis), /axis must be x, y or z/);
  const unknownSource = fixture();
  unknownSource.measurements[0].sourceId = "missing-survey-source";
  assert.throws(() => normalizeBuildingCaptureManifest(unknownSource), /unknown sourceId/);
});

test("rejects byte-identical reference images reused from the capture input", () => {
  const manifest = fixture();
  manifest.sources.find((item) => item.id === "reference-front").sha256 =
    manifest.sources.find((item) => item.id === "capture-front").sha256;
  const report = assessBuildingCaptureManifest(manifest, { fileIntegrity: fileIntegrity(manifest) });
  assert.equal(report.status, "failed");
  assert.ok(report.checks.some((check) => check.id === "reference-bytes-independent-from-captures" && check.status === "failed"));
});

test("marks a declared asset hash mismatch as failed instead of accepting a good-looking manifest", () => {
  const manifest = fixture();
  const integrity = fileIntegrity(manifest);
  integrity[0] = { ...integrity[0], status: "failed", sha256: hash(1000), detail: "SHA-256 mismatch" };
  const report = assessBuildingCaptureManifest(manifest, { fileIntegrity: integrity });
  assert.equal(report.status, "failed");
  assert.ok(report.checks.some((check) => check.id === "on-disk-source-integrity" && check.status === "failed"));
});

test("requires verified independent dimension records and non-collinear reviewed control points", () => {
  const estimated = fixture();
  estimated.measurements[0].basis = "operator-estimate";
  assert.equal(assessBuildingCaptureManifest(estimated, { fileIntegrity: fileIntegrity(estimated) }).status, "incomplete");
  const collinear = fixture();
  collinear.controlPoints = collinear.controlPoints.map((point, index) => ({ ...point, longitude: 90.4 + index * 0.0001, latitude: 23.7 }));
  const report = assessBuildingCaptureManifest(collinear, { fileIntegrity: fileIntegrity(collinear) });
  assert.equal(report.status, "incomplete");
  assert.ok(report.checks.some((check) => check.id === "survey-control-evidence" && check.status === "warning"));
});
