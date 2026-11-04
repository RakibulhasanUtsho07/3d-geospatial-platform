import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runEvidenceBackedVerticalSlice } from "../src/core/building-generation/evidence-backed-vertical-slice.mjs";

const GLB_MAGIC = 0x46546c67;
const SCOPES = [
  "private-media-ingestion",
  "photogrammetry-reconstruction",
  "texture-baking",
];
const attestations = {
  confirmCameraCalibrationReviewed: true,
  confirmCorrespondencesReviewed: true,
  confirmFaceDefinitionsReviewed: true,
  confirmTextureEvidenceReviewed: true,
};
const mediaAttestations = {
  confirmRights: true,
  confirmSameBuilding: true,
  confirmOverlapReviewed: true,
  confirmUpAxisReviewed: true,
  upAxis: "Z",
  buildingSpec: { id: "demo-building", name: "Demo building" },
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function glbBytes(seed = 0) {
  const bytes = Buffer.alloc(20 + seed);
  bytes.writeUInt32LE(GLB_MAGIC, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(bytes.length - 20, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m-engine-03-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  const sources = [];
  const images = [];
  for (let index = 0; index < 3; index++) {
    const sourceId = "view-" + (index + 1);
    const relativePath = "uploads/" + sourceId + ".jpg";
    const bytes = Buffer.from("independent-image-bytes-" + index);
    await writeFile(path.join(root, relativePath), bytes);
    const digest = sha256(bytes);
    sources.push({
      sourceId,
      kind: "image",
      relativePath,
      licence: "CC BY 4.0",
      permittedOperations: [...SCOPES],
      author: "Test photographer " + (index + 1),
      attribution: "Test attribution " + (index + 1),
    });
    images.push({
      id: sourceId,
      cameraId: "camera-" + (index + 1),
      path: relativePath,
      sha256: digest,
      width: 640,
      height: 480,
      verifiedSource: true,
      rightsReviewed: true,
      licence: "CC BY 4.0",
    });
  }
  const geometryInput = {
    cameras: [{ id: "camera-1" }, { id: "camera-2" }, { id: "camera-3" }],
    features: [{ id: "feature-1" }],
    edges: [["a", "b"]],
    faces: [["a", "b", "c"]],
    textureCandidate: {
      images,
      cameraCalibrations: [],
      faces: [],
    },
  };
  await writeFile(path.join(root, "geometry-input.json"), JSON.stringify(geometryInput, null, 2));
  return {
    root,
    sources,
    images,
    geometryInput,
    options: {
      workspaceRoot: root,
      buildingId: "demo-building",
      jobId: "vertical-slice-001",
      media: {
        ...mediaAttestations,
        sources,
        strategy: "photogrammetry",
      },
      geometry: {
        ...attestations,
        inputPath: "geometry-input.json",
      },
    },
  };
}

function createWorkflowStubs(f, { geometryBlockers = [], geometryOutput = true } = {}) {
  const calls = { media: 0, geometry: 0, mediaOptions: null, geometryOptions: null };
  const mediaModel = glbBytes(3);
  const geometryModel = glbBytes(5);
  const mediaModelPath = path.join(f.root, "outputs", "media-candidate.glb");
  const geometryModelPath = path.join(f.root, "outputs", "textured-candidate.glb");
  return {
    calls,
    async runMediaToModelWorkflow(options) {
      calls.media++;
      calls.mediaOptions = options;
      await mkdir(path.dirname(mediaModelPath), { recursive: true });
      await writeFile(mediaModelPath, mediaModel);
      return {
        modelPath: mediaModelPath,
        reportPath: path.join(f.root, "outputs", "media-report.json"),
        report: {
          engine: "media-to-model-workflow-v1",
          buildingId: f.options.buildingId,
          jobId: options.jobId,
          strategy: options.strategy,
          status: "completed-requires-review",
          inputs: {
            mediaRecords: f.sources.map((source, index) => ({
              id: source.sourceId,
              kind: "image",
              sha256: f.images[index].sha256,
              licence: source.licence,
              usageStatus: "approved",
              permittedOperations: source.permittedOperations,
            })),
            selectedViewIds: f.sources.map((source) => source.sourceId),
          },
          output: {
            modelPath: "outputs/media-candidate.glb",
            modelSha256: sha256(mediaModel),
            mapReady: false,
          },
          mapReady: false,
          publicationEligible: false,
        },
      };
    },
    async runArchitecturalGeometryWorkflow(options) {
      calls.geometry++;
      calls.geometryOptions = options;
      let texturedModel = null;
      if (geometryOutput) {
        await writeFile(geometryModelPath, geometryModel);
        texturedModel = {
          path: "outputs/textured-candidate.glb",
          sha256: sha256(geometryModel),
          texturedTriangleCount: 12,
          untexturedTriangleCount: 0,
        };
      }
      return {
        reportPath: path.join(f.root, "outputs", "geometry-report.json"),
        report: {
          workflow: "architectural-geometry-correspondence-consensus-v6",
          buildingId: options.buildingId,
          jobId: options.jobId,
          status: geometryBlockers.length ? "review-required" : "technical-checks-passed-requires-human-review",
          input: {
            relativePath: options.inputPath,
            sha256: sha256(Buffer.from(JSON.stringify(f.geometryInput, null, 2))),
          },
          blockers: geometryBlockers,
          checks: { glbTextureBindingQaValid: geometryOutput && geometryBlockers.length === 0 },
          output: { texturedModel },
          mapReady: false,
          publicationEligible: false,
        },
      };
    },
  };
}

test("binds media intake and reviewed geometry workflow to the same exact source-image hashes", async (t) => {
  const f = await fixture(t);
  const stubs = createWorkflowStubs(f);
  const result = await runEvidenceBackedVerticalSlice(f.options, stubs);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));

  assert.equal(stubs.calls.media, 1);
  assert.equal(stubs.calls.geometry, 1);
  assert.equal(stubs.calls.mediaOptions.strategy, "photogrammetry");
  assert.equal(stubs.calls.mediaOptions.sources[0].author, "Test photographer 1");
  assert.equal(stubs.calls.mediaOptions.sources[0].attribution, "Test attribution 1");
  assert.deepEqual(stubs.calls.mediaOptions.viewSourceIds, f.sources.map((source) => source.sourceId));
  assert.equal(stubs.calls.mediaOptions.jobId, "vertical-slice-001-media");
  assert.equal(stubs.calls.geometryOptions.jobId, "vertical-slice-001-geometry");
  assert.equal(stubs.calls.geometryOptions.inputPath, "geometry-input.json");
  assert.equal(report.status, "completed-requires-human-review");
  assert.equal(report.childJobs.media.output.modelSha256, sha256(glbBytes(3)));
  assert.equal(report.childJobs.geometry.output.texturedModel.sha256, sha256(glbBytes(5)));
  assert.equal(report.sourceEvidence.sources.length, 3);
  assert.equal(report.acceptance.sourceEvidenceBound, true);
  assert.equal(report.acceptance.geometryWorkflowChecksPassed, true);
  assert.equal(report.acceptance.acceptanceEligible, false);
  assert.equal(report.acceptance.publicationEligible, false);
  assert.equal(report.acceptance.mapReady, false);
  assert.equal(report.acceptance.automaticApproval, false);
});

test("rejects a geometry texture hash mismatch before either child workflow runs", async (t) => {
  const f = await fixture(t);
  f.geometryInput.textureCandidate.images[0].sha256 = "0".repeat(64);
  await writeFile(path.join(f.root, "geometry-input.json"), JSON.stringify(f.geometryInput, null, 2));
  const stubs = createWorkflowStubs(f);
  await assert.rejects(
    runEvidenceBackedVerticalSlice(f.options, stubs),
    /SHA-256 does not match the exact media source bytes/,
  );
  assert.equal(stubs.calls.media, 0);
  assert.equal(stubs.calls.geometry, 0);
});

test("persists a blocked report when architectural geometry does not export a textured GLB", async (t) => {
  const f = await fixture(t);
  const stubs = createWorkflowStubs(f, { geometryOutput: false, geometryBlockers: ["texture-atlas-bake-blocked"] });
  const result = await runEvidenceBackedVerticalSlice(f.options, stubs);
  assert.equal(result.report.status, "blocked-geometry-workflow-did-not-export-a-textured-glb");
  assert.equal(result.report.acceptance.candidateGlbAvailable, true);
  assert.equal(result.report.acceptance.texturedGlbAvailable, false);
  assert.equal(result.report.acceptance.publicationEligible, false);
  assert.ok(result.report.blockers.includes("texture-atlas-bake-blocked"));
});

test("preserves media candidate provenance when the geometry child fails", async (t) => {
  const f = await fixture(t);
  const stubs = createWorkflowStubs(f);
  stubs.runArchitecturalGeometryWorkflow = async () => {
    stubs.calls.geometry++;
    throw new Error("camera correspondence review did not pass");
  };
  const result = await runEvidenceBackedVerticalSlice(f.options, stubs);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.childJobs.media.status, "completed-requires-review");
  assert.equal(result.report.childJobs.media.output.modelSha256, sha256(glbBytes(3)));
  assert.equal(result.report.childJobs.geometry.status, "failed");
  assert.equal(result.report.acceptance.publicationEligible, false);
  assert.match(result.report.failure.message, /camera correspondence review/);
});

test("requires each image to be explicitly bound to a permitted still-image intake", async (t) => {
  const f = await fixture(t);
  f.options.media.sources[1].permittedOperations = ["private-media-ingestion"];
  const stubs = createWorkflowStubs(f);
  await assert.rejects(
    runEvidenceBackedVerticalSlice(f.options, stubs),
    /lacks explicit private intake, photogrammetry and texture-baking scopes/,
  );
  assert.equal(stubs.calls.media, 0);
  assert.equal(stubs.calls.geometry, 0);
});
test("rejects a BuildingSpec identity mismatch before child workflow execution", async (t) => {
  const f = await fixture(t);
  f.options.media.buildingSpec.id = "different-building";
  const stubs = createWorkflowStubs(f);
  await assert.rejects(
    runEvidenceBackedVerticalSlice(f.options, stubs),
    /BuildingSpec.id must exactly match the parent buildingId/,
  );
  assert.equal(stubs.calls.media, 0);
  assert.equal(stubs.calls.geometry, 0);
});

