import assert from "node:assert/strict";
import test from "node:test";
import { combineCaptureManifestEvidenceStatus, evaluateCaptureManifestBindings } from "../scripts/build-building-accuracy-evidence-pack.mjs";

const reviewedAt = "2026-10-24T10:00:00.000Z";
const hash = (seed) => seed.toString(16).padStart(64, "0").slice(-64);
function fixture() {
  const sides = ["front", "back", "left", "right"];
  const sources = sides.flatMap((side, index) => {
    const id = "capture-" + side;
    return [{ id, purpose: "capture", kind: "photo", side, path: "evidence/" + id + ".jpg",
      sha256: hash(index + 1), bytes: 1000 + index, sourceId: "source-record-" + id,
      rights: { status: "verified", evidenceId: "rights-" + id, reviewedBy: "reviewer-a", reviewedAt } },
    { id: "reference-" + side, purpose: "reference", kind: "photo", side, path: "evidence/reference-" + side + ".jpg",
      sha256: hash(index + 10), bytes: 2000 + index, sourceId: "source-record-reference-" + side,
      rights: { status: "verified", evidenceId: "rights-reference-" + side, reviewedBy: "reviewer-a", reviewedAt } }];
  });
  sources.push({ id: "survey-record", purpose: "measurement-evidence", kind: "document", side: "other",
    path: "evidence/survey.pdf", sha256: hash(30), bytes: 9000, sourceId: "survey-record",
    rights: { status: "verified", evidenceId: "rights-survey", reviewedBy: "reviewer-a", reviewedAt } });
  const controls = [
    { id: "gcp-1", longitude: 90.4000, latitude: 23.7000 },
    { id: "gcp-2", longitude: 90.4010, latitude: 23.7000 },
    { id: "gcp-3", longitude: 90.4000, latitude: 23.7010 },
  ].map((point) => ({ ...point, sourceId: "survey-record", evidenceId: "survey-book-2026", status: "verified" }));
  const media = (purpose) => sources.filter((item) => item.purpose === purpose).map((source) => ({
    id: source.id, kind: source.kind === "video-frame" ? "photo" : source.kind, side: source.side,
    path: source.path, sha256: source.sha256, bytes: source.bytes, sourceId: source.sourceId,
    rightsStatus: source.rights.status, rightsEvidenceId: source.rights.evidenceId,
    verifiedBy: source.rights.reviewedBy, verifiedAt: source.rights.reviewedAt,
  }));
  return {
    buildingId: "building-a",
    manifest: { schemaVersion: "1.0.0", manifestId: "capture-a", buildingId: "building-a", createdAt: reviewedAt,
      buildingIdentity: { status: "verified", sourceId: "building-register",
        evidenceDescription: "Identity linked to a reviewed register.", verifiedBy: "reviewer-a", verifiedAt: reviewedAt },
      sources,
      measurements: ["x", "y", "z"].map((axis, index) => ({ id: "dimension-" + axis, axis, valueM: [20, 12, 30][index],
        uncertaintyM: 0.1, basis: "surveyed", status: "verified", sourceId: "survey-record",
        evidenceId: "survey-book-2026", verifiedBy: "surveyor-a", verifiedAt: reviewedAt })),
      controlPoints: controls },
    captureReport: { status: "ready-for-review", buildingId: "building-a",
      input: { expectedSha256Pinned: true } },
    sourceMedia: media("capture"), referenceImages: media("reference"),
    dimensionReference: { referenceDimensionsM: { x: 20, y: 12, z: 30 },
      evidence: { basis: "surveyed", referenceId: "survey-record", sourceDescription: "Independent site survey." } },
    groundControl: { controlPoints: controls.map((point) => ({ id: point.id, longitude: point.longitude,
      latitude: point.latitude, evidenceSourceId: point.sourceId })) },
  };
}

test("accepts only a complete capture manifest with exact asset/dimension/control bindings", () => {
  const input = fixture();
  const report = evaluateCaptureManifestBindings(input);
  assert.equal(report.status, "ready-for-review");
  assert.equal(report.bindingsValid, true);
  assert.ok(report.checks.every((check) => check.status === "passed"));
});

test("fails when a source asset hash or independent measurement does not match the manifest", () => {
  const sourceChanged = fixture();
  sourceChanged.sourceMedia[0].sha256 = hash(999);
  assert.equal(evaluateCaptureManifestBindings(sourceChanged).status, "failed");
  const dimensionChanged = fixture();
  dimensionChanged.dimensionReference.referenceDimensionsM.x = 25;
  assert.equal(evaluateCaptureManifestBindings(dimensionChanged).status, "failed");
});

test("fails when ground-control coordinates do not match the documented survey points", () => {
  const input = fixture();
  input.groundControl.controlPoints[0].longitude += 0.001;
  assert.equal(evaluateCaptureManifestBindings(input).status, "failed");
});

test("keeps a missing capture manifest incomplete rather than treating legacy inputs as verified", () => {
  const report = evaluateCaptureManifestBindings({ buildingId: "building-a" });
  assert.equal(report.status, "incomplete");
  assert.equal(report.bindingsValid, false);
  assert.ok(report.checks.every((check) => check.status === "warning"));
});

test("does not accept estimates or duplicate axes as independent dimension evidence", () => {
  const estimated = fixture();
  estimated.manifest.measurements[0].basis = "operator-estimate";
  estimated.dimensionReference.evidence.basis = "operator-estimate";
  assert.equal(evaluateCaptureManifestBindings(estimated).status, "incomplete");

  const duplicateAxis = fixture();
  duplicateAxis.manifest.measurements[1].axis = "x";
  assert.equal(evaluateCaptureManifestBindings(duplicateAxis).status, "failed");
});

test("rejects duplicated source/reference declarations and repeated control-point IDs", () => {
  const duplicateAsset = fixture();
  duplicateAsset.referenceImages[1].id = duplicateAsset.referenceImages[0].id;
  assert.equal(evaluateCaptureManifestBindings(duplicateAsset).status, "failed");

  const duplicateControl = fixture();
  duplicateControl.groundControl.controlPoints[1].id = duplicateControl.groundControl.controlPoints[0].id;
  assert.equal(evaluateCaptureManifestBindings(duplicateControl).status, "failed");
});

test("preserves a failed capture-manifest validation instead of downgrading it to incomplete", () => {
  assert.equal(combineCaptureManifestEvidenceStatus("failed", "incomplete"), "failed");
  assert.equal(combineCaptureManifestEvidenceStatus("ready-for-review", "failed"), "failed");
  assert.equal(combineCaptureManifestEvidenceStatus("incomplete", "ready-for-review"), "incomplete");
  assert.equal(combineCaptureManifestEvidenceStatus("ready-for-review", "ready-for-review"), "ready-for-review");
});
