import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARCHITECTURAL_GEOMETRY_STAGE_IDS,
} from "../src/core/building-generation/reconstruction-job-state.mjs";
import { runArchitecturalGeometryWorkflow } from "../src/core/building-generation/architectural-geometry-workflow.mjs";

const confirmations = {
  confirmCameraCalibrationReviewed: true,
  confirmCorrespondencesReviewed: true,
  confirmFaceDefinitionsReviewed: true,
  confirmTextureEvidenceReviewed: true,
};

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngHeader(width, height) {
  const image = Buffer.alloc(40, 37);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image, 0);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

const cameras = [
  { id: "left", projection: [[1,0,0,0],[0,1,0,0],[0,0,1,0]] },
  { id: "right", projection: [[1,0,0,-1],[0,1,0,0],[0,0,1,0]] },
];

const features = [
  { id: "a", observations: [{cameraId:"left",x:0,y:0},{cameraId:"right",x:-0.2,y:0}] },
  { id: "b", observations: [{cameraId:"left",x:0.2,y:0},{cameraId:"right",x:0,y:0}] },
  { id: "c", observations: [{cameraId:"left",x:0,y:0.2},{cameraId:"right",x:-0.2,y:0.2}] },
  { id: "d", observations: [{cameraId:"left",x:0,y:0},{cameraId:"right",x:-1/6,y:0}] },
];

const edges = [
  ["a","b"],["a","c"],["a","d"],["b","c"],["b","d"],["c","d"],
];
const faces = [
  ["a","c","b"],["a","b","d"],["a","d","c"],["b","c","d"],
];

async function fixture(t, { textureStatus = "verified" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "architectural-geometry-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "uploads"), { recursive: true }));
  const imageBytes = pngHeader(640, 480);
  await writeFile(path.join(root, "uploads", "front.png"), imageBytes);
  const textureCandidate = {
    images: [{
      id: "front",
      path: "uploads/front.png",
      sha256: digest(imageBytes),
      width: 640,
      height: 480,
      verifiedSource: true,
      rightsReviewed: true,
      licence: "CC BY 4.0",
    }],
    cameraCalibrations: [{
      id: "left",
      status: textureStatus,
      reprojectionErrorPx: 0.2,
    }],
    faces: [{
      vertices: ["a","b","c"],
      uv: [[0,0],[1,0],[0.5,1]],
      sourceImageId: "front",
      cameraCalibrationId: "left",
    }],
  };
  const inputPath = path.join(root, "geometry-input.json");
  const input = {
    cameras, features, edges, faces, textureCandidate,
    options: {
      maxRmsReprojectionError: 0.01,
      maxRepairPasses: 3,
      maxBoundaryEdges: 0,
      minTriangleArea: 1e-8,
      maxTextureReprojectionErrorPx: 2,
    },
  };
  await writeFile(inputPath, JSON.stringify(input, null, 2));
  return { root, input, inputPath: "geometry-input.json" };
}

function workflowOptions(fixture, overrides = {}) {
  return {
    workspaceRoot: fixture.root,
    buildingId: "heritage-building",
    jobId: "geometry-evidence-001",
    inputPath: fixture.inputPath,
    ...confirmations,
    ...overrides,
  };
}

test("runs registration, wireframe QA, explicit-face meshing, surface review and texture evidence as resumable stages", async (t) => {
  const f = await fixture(t);
  const result = await runArchitecturalGeometryWorkflow(workflowOptions(f));
  assert.equal(result.state.status, "completed");
  assert.deepEqual(result.state.stageIds, ARCHITECTURAL_GEOMETRY_STAGE_IDS);
  assert.ok(result.state.stages.every(stage => stage.status === "completed" && stage.artifacts.length === 1));
  assert.equal(result.report.status, "technical-checks-passed-requires-human-review");
  assert.equal(result.report.checks.registrationStatus, "candidate-wireframe");
  assert.equal(result.report.checks.triangulatedVertexCount, 4);
  assert.equal(result.report.checks.acceptedMeshTriangleCount, 4);
  assert.equal(result.report.checks.boundaryEdgeCount, 0);
  assert.equal(result.report.checks.nonManifoldEdgeCount, 0);
  assert.equal(result.report.checks.textureProjectionEvidenceStatus, "evidence-validation-passed");
  assert.equal(result.report.checks.texturePixelProjectionPerformed, false);
  assert.equal(result.report.checks.textureAtlasBakingPerformed, false);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);

  const savedReport = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(savedReport.output.meshTriangleCount, 4);
  const savedState = JSON.parse(await readFile(result.statePath, "utf8"));
  assert.equal(savedState.mapReady, false);
  assert.equal(savedState.publicationEligible, false);
});

test("reuses every checksummed stage on a repeated run with unchanged evidence", async (t) => {
  const f = await fixture(t);
  const first = await runArchitecturalGeometryWorkflow(workflowOptions(f));
  const second = await runArchitecturalGeometryWorkflow(workflowOptions(f));
  assert.equal(first.resumed, false);
  assert.equal(second.resumed, true);
  assert.deepEqual(
    second.state.stages.map(stage => ({ id:stage.id, attempts:stage.attempts, artifacts:stage.artifacts.length })),
    ARCHITECTURAL_GEOMETRY_STAGE_IDS.map(id => ({ id, attempts:1, artifacts:1 })),
  );
  assert.equal(second.report.mapReady, false);
  assert.equal(second.report.publicationEligible, false);
});

test("rejects the same job ID when the input evidence changes", async (t) => {
  const f = await fixture(t);
  await runArchitecturalGeometryWorkflow(workflowOptions(f));
  f.input.features[0].observations[0].x = 0.001;
  await writeFile(path.join(f.root, f.inputPath), JSON.stringify(f.input));
  await assert.rejects(
    runArchitecturalGeometryWorkflow(workflowOptions(f)),
    /different source\/config inputs/,
  );
});

test("keeps blocked texture evidence in the final report rather than granting release eligibility", async (t) => {
  const f = await fixture(t, { textureStatus: "estimated" });
  const result = await runArchitecturalGeometryWorkflow(workflowOptions(f));
  assert.equal(result.report.status, "review-required");
  assert.ok(result.report.blockers.includes("texture-projection-evidence-needs-review"));
  assert.equal(result.report.checks.textureProjectionEvidenceStatus, "review-required");
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
});

test("requires explicit calibration, correspondence, face and texture-evidence review", async (t) => {
  const f = await fixture(t);
  const options = workflowOptions(f, { confirmFaceDefinitionsReviewed: false });
  await assert.rejects(
    runArchitecturalGeometryWorkflow(options),
    /confirmFaceDefinitionsReviewed must be true/,
  );
  await assert.rejects(
    readFile(path.join(f.root, ".building-engine", "reconstruction-jobs", "heritage-building", "geometry-evidence-001", "job-state.json")),
    /ENOENT/,
  );
});

test("rejects modified local texture source bytes even when the declared digest is unchanged", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "uploads", "front.png"), pngHeader(640, 480).fill(0));
  await assert.rejects(
    runArchitecturalGeometryWorkflow(workflowOptions(f)),
    /SHA-256 mismatch/,
  );
});
