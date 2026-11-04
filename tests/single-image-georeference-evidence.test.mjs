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
