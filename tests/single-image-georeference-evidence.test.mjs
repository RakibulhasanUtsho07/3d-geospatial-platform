import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSingleImageGeoreferenceEvidence,
  loadSingleImageControlPointManifest,
  verifySingleImageGeoreferenceEvidence,
  verifySingleImageGeoreferenceEvidenceBytes,
} from "../src/core/building-generation/single-image-georeference-evidence.mjs";

const EARTH_RADIUS_M = 6378137;
const BUILDING = "demo-building";
const SOURCE = "facade-photo";
const SOURCE_HASH = "a".repeat(64);
const MODEL_HASH = "b".repeat(64);

function lonLat(east, north, longitude, latitude) {
  const lat0 = latitude * Math.PI / 180;
  return {
    longitude: (longitude + east / (EARTH_RADIUS_M * Math.cos(lat0)) * 180 / Math.PI + 540) % 360 - 180,
    latitude: latitude + north / EARTH_RADIUS_M * 180 / Math.PI,
  };
}

function manifest() {
  const theta = 30 * Math.PI / 180;
  const scale = 2.5;
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  return {
    schemaVersion: "1.0.0",
    kind: "single-image-control-point-manifest",
    buildingId: BUILDING,
    source: { sourceId: SOURCE, sha256: SOURCE_HASH },
    horizontalCrs: "EPSG:4326",
    horizontalDatum: "WGS84",
    verticalDatum: "not-provided",
    survey: {
      method: "RTK GNSS",
      reference: "survey-run-2026-11-04",
      observedAtUtc: "2026-11-04T10:00:00.000Z",
      horizontalAccuracyM: 0.03,
    },
    controlPoints: [[-10, -8], [10, -8], [10, 8], [-10, 8]].map(([modelX, modelZ], index) => ({
      id: "gcp-" + (index + 1),
      modelX,
      modelZ,
      ...lonLat(
        scale * (cosine * modelX - sine * modelZ) + 100,
        scale * (sine * modelX + cosine * modelZ) + 200,
        90.4,
        23.7,
      ),
      evidenceSourceId: SOURCE,
    })),
  };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m08-gcp-"));
  await mkdir(path.join(root, "survey"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeManifest(root, value = manifest()) {
  await writeFile(path.join(root, "survey", "controls.json"), JSON.stringify(value, null, 2) + "\n");
}

async function load(root, overrides = {}) {
  return loadSingleImageControlPointManifest({
    workspaceRoot: root,
    relativePath: "survey/controls.json",
    buildingId: BUILDING,
    sourceId: SOURCE,
    sourceSha256: SOURCE_HASH,
    ...overrides,
  });
}

test("loads source/building-bound WGS84 controls and creates a human-review horizontal registration", async (t) => {
  const root = await workspace(t);
  await writeManifest(root);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded,
    modelSha256: MODEL_HASH,
  });
  assert.equal(evidence.status, "calibrated-needs-human-review");
  assert.equal(evidence.manifest.pointCount, 4);
  assert.equal(evidence.manifest.horizontalCrs, "EPSG:4326");
  assert.equal(evidence.manifest.horizontalDatum, "WGS84");
  assert.equal(evidence.registration.vertical.status, "not-solved");
  assert.equal(evidence.registration.mapReady, false);
  assert.equal(evidence.registration.publicationEligible, false);

  const verified = await verifySingleImageGeoreferenceEvidence({
    workspaceRoot: root,
    evidence,
    buildingId: BUILDING,
    sourceId: SOURCE,
    sourceSha256: SOURCE_HASH,
    modelSha256: MODEL_HASH,
  });
  assert.deepEqual(verified, evidence);

  const exactManifestBytes = await readFile(path.join(root, "survey", "controls.json"));
  const offlineVerified = verifySingleImageGeoreferenceEvidenceBytes({
    evidence,
    manifestBytes: exactManifestBytes,
    buildingId: BUILDING,
    sourceId: SOURCE,
    sourceSha256: SOURCE_HASH,
    modelSha256: MODEL_HASH,
  });
  assert.deepEqual(offlineVerified, evidence);
  assert.throws(
    () => verifySingleImageGeoreferenceEvidenceBytes({
      evidence,
      manifestBytes: Buffer.concat([exactManifestBytes, Buffer.from(" ")]),
      buildingId: BUILDING,
      sourceId: SOURCE,
      sourceSha256: SOURCE_HASH,
      modelSha256: MODEL_HASH,
    }),
    /bytes or identity/i,
  );
  assert.throws(
    () => verifySingleImageGeoreferenceEvidenceBytes({
      evidence,
      manifestBytes: exactManifestBytes,
      buildingId: "substituted-building",
      sourceId: SOURCE,
      sourceSha256: SOURCE_HASH,
      modelSha256: MODEL_HASH,
    }),
    /building identity/i,
  );
});

test("rejects a changed control-point manifest after evidence was recorded", async (t) => {
  const root = await workspace(t);
  await writeManifest(root);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({ loadedManifest: loaded, modelSha256: MODEL_HASH });
  const altered = manifest();
  altered.survey.reference = "different-survey";
  await writeManifest(root, altered);
  await assert.rejects(
    verifySingleImageGeoreferenceEvidence({
      workspaceRoot: root,
      evidence,
      buildingId: BUILDING,
      sourceId: SOURCE,
      sourceSha256: SOURCE_HASH,
      modelSha256: MODEL_HASH,
    }),
    /bytes or identity/i,
  );
});

test("rejects building/source substitution and controls detached from the selected image", async (t) => {
  const root = await workspace(t);
  await writeManifest(root);
  await assert.rejects(load(root, { buildingId: "another-building" }), /building identity/i);
  await assert.rejects(load(root, { sourceSha256: "c".repeat(64) }), /exact selected source image/i);

  const altered = manifest();
  altered.controlPoints[0].evidenceSourceId = "another-image";
  await writeManifest(root, altered);
  await assert.rejects(load(root), /selected source/i);
});

test("fails closed for invalid CRS, duplicate IDs, malformed survey data and path traversal", async (t) => {
  const root = await workspace(t);
  const wrongCrs = manifest();
  wrongCrs.horizontalCrs = "EPSG:3857";
  await writeManifest(root, wrongCrs);
  await assert.rejects(load(root), /coordinate reference/i);

  const duplicate = manifest();
  duplicate.controlPoints[1].id = duplicate.controlPoints[0].id;
  await writeManifest(root, duplicate);
  await assert.rejects(load(root), /valid and unique/i);

  const invalidSurvey = manifest();
  invalidSurvey.survey.observedAtUtc = "yesterday";
  await writeManifest(root, invalidSurvey);
  await assert.rejects(load(root), /canonical UTC ISO timestamp/i);

  await assert.rejects(
    load(root, { relativePath: "../controls.json" }),
    /workspace-relative|unsafe path/i,
  );
});

test("requires non-collinear ground-control points and explicit no-control mode", async (t) => {
  const root = await workspace(t);
  const collinear = manifest();
  collinear.controlPoints = [[-2, 0], [0, 0], [2, 0]].map(([modelX, modelZ], index) => ({
    id: "line-" + index,
    modelX,
    modelZ,
    longitude: 90.4 + index * 0.00001,
    latitude: 23.7,
    evidenceSourceId: SOURCE,
  }));
  await writeManifest(root, collinear);
  const loaded = await load(root);
  assert.throws(
    () => createSingleImageGeoreferenceEvidence({ loadedManifest: loaded, modelSha256: MODEL_HASH }),
    /non-collinear/i,
  );

  const noControls = createSingleImageGeoreferenceEvidence({ modelSha256: MODEL_HASH });
  assert.equal(noControls.status, "not-requested");
  assert.equal(noControls.manifest, null);
  assert.equal(noControls.registration, null);
  assert.equal(noControls.maxGcpRmsErrorM, null);
  assert.equal(noControls.maxGcpResidualM, null);
});


function manifestWithVertical() {
  const value = manifest();
  value.schemaVersion = "1.1.0";
  value.verticalDatum = "EPSG:4979-ellipsoidal";
  value.vertical = {
    crs: "EPSG:4979",
    heightType: "ellipsoidal",
    unit: "metre",
    referenceFrame: "WGS 84 (G2139)",
    coordinateEpoch: 2022.25,
    survey: {
      method: "RTK GNSS ellipsoidal-height observation",
      reference: "vertical-survey-run-2026-11-04",
      observedAtUtc: "2026-11-04T10:30:00.000Z",
      verticalAccuracyM: 0.04,
    },
    controlPoints: value.controlPoints.map((point, index) => ({
      horizontalControlPointId: point.id,
      modelY: index * 1.5,
      ellipsoidalHeightM: 135 + index * 3.75,
      evidenceSourceId: SOURCE,
    })),
  };
  return value;
}

test("binds surveyed EPSG:4979 ellipsoidal heights to the exact horizontal fit without fitting a second scale", async (t) => {
  const root = await workspace(t);
  const sourceManifest = manifestWithVertical();
  await writeManifest(root, sourceManifest);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded,
    modelSha256: MODEL_HASH,
  });

  assert.equal(evidence.schemaVersion, "1.1.0");
  assert.equal(evidence.verticalEvidence.status, "calibrated-needs-human-review");
  assert.equal(evidence.verticalEvidence.verticalCrs, "EPSG:4979");
  assert.equal(evidence.verticalEvidence.heightType, "ellipsoidal");
  assert.equal(evidence.verticalEvidence.referenceFrame, "WGS 84 (G2139)");
  assert.equal(evidence.verticalEvidence.coordinateEpoch, 2022.25);
  assert.equal(evidence.verticalEvidence.horizontalMetresPerModelUnit,
    evidence.registration.transform.metresPerModelUnit);
  assert.equal(evidence.verticalEvidence.verticalScalePolicy,
    "reuses-exact-horizontal-scale-no-independent-y-scale");
  assert.equal(evidence.verticalEvidence.heightOffsetM, 135);
  assert.equal(evidence.verticalEvidence.controls.thresholdPass, true);
  assert.equal(evidence.verticalEvidence.mapReady, false);
  assert.equal(evidence.verticalEvidence.publicationEligible, false);
  assert.equal(evidence.verticalEvidence.automaticApproval, false);

  const exactBytes = await readFile(path.join(root, "survey", "controls.json"));
  const offline = verifySingleImageGeoreferenceEvidenceBytes({
    evidence, manifestBytes: exactBytes, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  });
  assert.deepEqual(offline, evidence);
  const online = await verifySingleImageGeoreferenceEvidence({
    workspaceRoot: root, evidence, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  });
  assert.deepEqual(online, evidence);

  assert.throws(() => verifySingleImageGeoreferenceEvidenceBytes({
    evidence: { ...evidence, verticalEvidence: {
      ...evidence.verticalEvidence, horizontalMetresPerModelUnit: 9,
    } },
    manifestBytes: exactBytes, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  }), /independently recomputed/i);
});

test("fails vertical calibration when independent height residuals exceed tolerance", async (t) => {
  const root = await workspace(t);
  const value = manifestWithVertical();
  value.vertical.controlPoints[3].ellipsoidalHeightM += 2;
  await writeManifest(root, value);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded, modelSha256: MODEL_HASH,
    maxVerticalGcpRmsErrorM: 0.5, maxVerticalGcpResidualM: 1,
  });
  assert.equal(evidence.status, "calibrated-needs-human-review");
  assert.equal(evidence.verticalEvidence.status, "calibration-failed-review-required");
  assert.equal(evidence.verticalEvidence.controls.thresholdPass, false);
  assert.ok(evidence.verticalEvidence.controls.rmsErrorM > 0.5);
  assert.ok(evidence.verticalEvidence.controls.maxResidualM > 1);
});

test("rejects non-ellipsoidal heights, CRS substitution, and an unnamed realization", async (t) => {
  const root = await workspace(t);
  const wrongHeightType = manifestWithVertical();
  wrongHeightType.vertical.heightType = "orthometric";
  await writeManifest(root, wrongHeightType);
  await assert.rejects(load(root), /ellipsoidal|orthometric/i);

  const wrongCrs = manifestWithVertical();
  wrongCrs.vertical.crs = "EPSG:3855";
  await writeManifest(root, wrongCrs);
  await assert.rejects(load(root), /EPSG:4979/i);

  const unnamedFrame = manifestWithVertical();
  unnamedFrame.vertical.referenceFrame = "WGS84";
  await writeManifest(root, unnamedFrame);
  await assert.rejects(load(root), /named WGS 84 realization/i);
});

test("rejects vertical controls that do not map one-to-one to horizontal control IDs", async (t) => {
  const root = await workspace(t);
  const duplicate = manifestWithVertical();
  duplicate.vertical.controlPoints[1].horizontalControlPointId =
    duplicate.vertical.controlPoints[0].horizontalControlPointId;
  await writeManifest(root, duplicate);
  await assert.rejects(load(root), /one-to-one/i);

  const missing = manifestWithVertical();
  missing.vertical.controlPoints.pop();
  await writeManifest(root, missing);
  await assert.rejects(load(root), /exactly one measurement/i);

  const substituted = manifestWithVertical();
  substituted.vertical.controlPoints[0].evidenceSourceId = "another-image";
  await writeManifest(root, substituted);
  await assert.rejects(load(root), /selected source/i);
});

test("rejects insufficient vertical spread and non-finite/out-of-range vertical measurements", async (t) => {
  const root = await workspace(t);
  const narrow = manifestWithVertical();
  narrow.vertical.controlPoints.forEach((point, index) => {
    point.modelY = index * 0.1;
    point.ellipsoidalHeightM = 135 + index * 0.25;
  });
  await writeManifest(root, narrow);
  const narrowLoaded = await load(root);
  assert.throws(() => createSingleImageGeoreferenceEvidence({
    loadedManifest: narrowLoaded, modelSha256: MODEL_HASH,
  }), /span at least 1 metre/i);

  const nonFinite = manifestWithVertical();
  nonFinite.vertical.controlPoints[0].ellipsoidalHeightM = Number.NaN;
  await writeManifest(root, nonFinite);
  await assert.rejects(load(root), /ellipsoidal height must be finite/i);

  const outside = manifestWithVertical();
  outside.vertical.controlPoints[0].ellipsoidalHeightM = 120000;
  await writeManifest(root, outside);
  await assert.rejects(load(root), /physical range/i);
});

test("rejects a vertical manifest that drifts after the evidence snapshot", async (t) => {
  const root = await workspace(t);
  await writeManifest(root, manifestWithVertical());
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded, modelSha256: MODEL_HASH,
  });
  const altered = manifestWithVertical();
  altered.vertical.coordinateEpoch = 2023.0;
  await writeManifest(root, altered);
  await assert.rejects(verifySingleImageGeoreferenceEvidence({
    workspaceRoot: root, evidence, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  }), /bytes or identity/i);
});


function manifestWithHeldOutCheckpoints() {
  const value = manifestWithVertical();
  value.schemaVersion = "1.2.0";
  value.controlPoints.forEach((point, index) => {
    point.observationId = "fit-observation-" + (index + 1);
  });
  value.vertical.controlPoints.forEach((point, index) => {
    point.observationId = "fit-observation-" + (index + 1);
  });
  const theta = 30 * Math.PI / 180;
  const scale = 2.5;
  const model = [
    [-8, 0.25, -6],
    [-4, 0.75, 5],
    [0, 1.5, -2],
    [4, 2.25, 7],
    [8, 3.25, -5],
    [12, 4, 3],
  ];
  value.heldOutCheckpoints = {
    crs: "EPSG:4979",
    heightType: "ellipsoidal",
    unit: "metre",
    referenceFrame: "WGS 84 (G2139)",
    coordinateEpoch: 2022.25,
    survey: {
      method: "independent RTK GNSS checkpoint survey",
      reference: "held-out-survey-run-2026-11-04",
      observedAtUtc: "2026-11-04T11:00:00.000Z",
      horizontalAccuracyM: 0.03,
      verticalAccuracyM: 0.04,
    },
    points: model.map(([modelX, modelY, modelZ], index) => {
      const east = scale * (Math.cos(theta) * modelX - Math.sin(theta) * modelZ) + 100;
      const north = scale * (Math.sin(theta) * modelX + Math.cos(theta) * modelZ) + 200;
      return {
        id: "checkpoint-" + (index + 1),
        observationId: "heldout-observation-" + (index + 1),
        observationRecordSha256: String(index + 1).padStart(2, "0").repeat(32),
        modelX,
        modelY,
        modelZ,
        ...lonLat(east, north, 90.4, 23.7),
        ellipsoidalHeightM: 135 + scale * modelY,
      };
    }),
  };
  return value;
}

test("validates six held-out 3D checkpoints without refitting horizontal or vertical transforms", async (t) => {
  const root = await workspace(t);
  await writeManifest(root, manifestWithHeldOutCheckpoints());
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded,
    modelSha256: MODEL_HASH,
  });

  assert.equal(evidence.schemaVersion, "1.2.0");
  assert.equal(evidence.independentCheckpointEvidence.status, "validated-needs-human-review");
  assert.equal(evidence.independentCheckpointEvidence.controls.count, 6);
  assert.equal(evidence.independentCheckpointEvidence.fittingControlsExcluded, true);
  assert.equal(
    evidence.independentCheckpointEvidence.horizontalTransform.horizontalMetresPerModelUnit,
    evidence.registration.transform.metresPerModelUnit,
  );
  assert.equal(
    evidence.independentCheckpointEvidence.verticalTransform.horizontalMetresPerModelUnit,
    evidence.registration.transform.metresPerModelUnit,
  );
  assert.deepEqual(
    evidence.independentCheckpointEvidence.controls.observationIds,
    loaded.manifest.heldOutCheckpoints.points.map((point) => point.observationId),
  );
  assert.equal(evidence.independentCheckpointEvidence.controls.thresholdPass, true);
  assert.equal(evidence.independentCheckpointEvidence.mapReady, false);
  assert.equal(evidence.independentCheckpointEvidence.publicationEligible, false);
  assert.equal(evidence.independentCheckpointEvidence.automaticApproval, false);

  const bytes = await readFile(path.join(root, "survey", "controls.json"));
  const offline = verifySingleImageGeoreferenceEvidenceBytes({
    evidence, manifestBytes: bytes, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  });
  assert.deepEqual(offline, evidence);
  const online = await verifySingleImageGeoreferenceEvidence({
    workspaceRoot: root, evidence, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  });
  assert.deepEqual(online, evidence);
  assert.throws(() => verifySingleImageGeoreferenceEvidenceBytes({
    evidence: {
      ...evidence,
      independentCheckpointEvidence: {
        ...evidence.independentCheckpointEvidence,
        modelSha256: "c".repeat(64),
      },
    },
    manifestBytes: bytes, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  }), /independently recomputed/i);
});

test("fails held-out 3D checkpoint validation when an independent point exceeds residual limits", async (t) => {
  const root = await workspace(t);
  const value = manifestWithHeldOutCheckpoints();
  value.heldOutCheckpoints.points[5].ellipsoidalHeightM += 2;
  await writeManifest(root, value);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded,
    modelSha256: MODEL_HASH,
  });
  assert.equal(evidence.status, "calibrated-needs-human-review");
  assert.equal(evidence.independentCheckpointEvidence.status, "validation-failed-review-required");
  assert.equal(evidence.independentCheckpointEvidence.controls.thresholdPass, false);
  assert.ok(evidence.independentCheckpointEvidence.controls.verticalRmsErrorM > 0.5);
  assert.ok(evidence.independentCheckpointEvidence.controls.verticalMaxResidualM > 1);
  assert.equal(evidence.independentCheckpointEvidence.mapReady, false);
});

test("rejects fewer than six, duplicated, or fitting-overlapping held-out checkpoint IDs", async (t) => {
  const root = await workspace(t);
  const tooFew = manifestWithHeldOutCheckpoints();
  tooFew.heldOutCheckpoints.points.pop();
  await writeManifest(root, tooFew);
  await assert.rejects(load(root), /6–100 held-out checkpoints/i);

  const duplicate = manifestWithHeldOutCheckpoints();
  duplicate.heldOutCheckpoints.points[1].id = duplicate.heldOutCheckpoints.points[0].id;
  await writeManifest(root, duplicate);
  await assert.rejects(load(root), /checkpoint IDs.*unique/i);

  const overlap = manifestWithHeldOutCheckpoints();
  overlap.heldOutCheckpoints.points[0].id = overlap.controlPoints[0].id;
  await writeManifest(root, overlap);
  await assert.rejects(load(root), /disjoint.*fitting control IDs/i);
});

test("rejects held-out observation reuse, malformed hashes, and vertical fit-observation mismatch", async (t) => {
  const root = await workspace(t);
  const duplicateObservation = manifestWithHeldOutCheckpoints();
  duplicateObservation.heldOutCheckpoints.points[1].observationId =
    duplicateObservation.heldOutCheckpoints.points[0].observationId;
  await writeManifest(root, duplicateObservation);
  await assert.rejects(load(root), /observation IDs.*unique/i);

  const overlapObservation = manifestWithHeldOutCheckpoints();
  overlapObservation.heldOutCheckpoints.points[0].observationId =
    overlapObservation.controlPoints[0].observationId;
  await writeManifest(root, overlapObservation);
  await assert.rejects(load(root), /disjoint from fitting observation IDs/i);

  const invalidHash = manifestWithHeldOutCheckpoints();
  invalidHash.heldOutCheckpoints.points[0].observationRecordSha256 = "not-a-sha";
  await writeManifest(root, invalidHash);
  await assert.rejects(load(root), /observation-record SHA-256/i);

  const mismatchedFitObservation = manifestWithHeldOutCheckpoints();
  mismatchedFitObservation.vertical.controlPoints[0].observationId = "different-fit-record";
  await writeManifest(root, mismatchedFitObservation);
  await assert.rejects(load(root), /exact horizontal fit observation ID/i);
});

test("requires held-out checkpoints to use the identical ellipsoidal frame and epoch", async (t) => {
  const root = await workspace(t);
  const wrongFrame = manifestWithHeldOutCheckpoints();
  wrongFrame.heldOutCheckpoints.referenceFrame = "WGS 84 (G1762)";
  await writeManifest(root, wrongFrame);
  await assert.rejects(load(root), /exact D3M-13.*frame and coordinate epoch/i);

  const wrongEpoch = manifestWithHeldOutCheckpoints();
  wrongEpoch.heldOutCheckpoints.coordinateEpoch = 2023.0;
  await writeManifest(root, wrongEpoch);
  await assert.rejects(load(root), /exact D3M-13.*frame and coordinate epoch/i);
});

test("requires independent checkpoints to cover a 2D footprint and at least one metre vertically", async (t) => {
  const root = await workspace(t);
  const collinear = manifestWithHeldOutCheckpoints();
  collinear.heldOutCheckpoints.points.forEach((point, index) => {
    point.modelX = index * 2;
    point.modelZ = 0;
  });
  await writeManifest(root, collinear);
  const collinearLoaded = await load(root);
  assert.throws(() => createSingleImageGeoreferenceEvidence({
    loadedManifest: collinearLoaded, modelSha256: MODEL_HASH,
  }), /two-dimensional, non-collinear/i);

  const noVerticalSpread = manifestWithHeldOutCheckpoints();
  noVerticalSpread.heldOutCheckpoints.points.forEach((point) => {
    point.modelY = 2;
    point.ellipsoidalHeightM = 140;
  });
  await writeManifest(root, noVerticalSpread);
  const noVerticalSpreadLoaded = await load(root);
  assert.throws(() => createSingleImageGeoreferenceEvidence({
    loadedManifest: noVerticalSpreadLoaded, modelSha256: MODEL_HASH,
  }), /span at least 1 metre/i);
});

test("rejects a schema 1.2 checkpoint manifest that drifts after its evidence snapshot", async (t) => {
  const root = await workspace(t);
  const original = manifestWithHeldOutCheckpoints();
  await writeManifest(root, original);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({ loadedManifest: loaded, modelSha256: MODEL_HASH });
  original.heldOutCheckpoints.points[0].longitude += 0.0001;
  await writeManifest(root, original);
  await assert.rejects(verifySingleImageGeoreferenceEvidence({
    workspaceRoot: root, evidence, buildingId: BUILDING, sourceId: SOURCE,
    sourceSha256: SOURCE_HASH, modelSha256: MODEL_HASH,
  }), /bytes or identity/i);
});


test("fails held-out validation when horizontal checkpoint placement exceeds its independent limit", async (t) => {
  const root = await workspace(t);
  const value = manifestWithHeldOutCheckpoints();
  value.heldOutCheckpoints.points[4].longitude += 0.0001;
  await writeManifest(root, value);
  const loaded = await load(root);
  const evidence = createSingleImageGeoreferenceEvidence({
    loadedManifest: loaded,
    modelSha256: MODEL_HASH,
  });
  const heldOut = evidence.independentCheckpointEvidence;
  assert.equal(evidence.verticalEvidence.status, "calibrated-needs-human-review");
  assert.equal(heldOut.status, "validation-failed-review-required");
  assert.equal(heldOut.controls.thresholdPass, false);
  assert.ok(heldOut.controls.horizontalRmsErrorM > heldOut.controls.maxHorizontalRmsErrorM);
  assert.ok(heldOut.controls.horizontalMaxResidualM > heldOut.controls.maxHorizontalResidualM);
  assert.equal(heldOut.mapReady, false);
});
