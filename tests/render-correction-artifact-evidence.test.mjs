import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { inspectRenderCorrectionArtifactEvidence } from "../src/core/building-generation/render-correction-artifact-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "render-correction-artifacts-"));
  const spec = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
  const { glb } = generateProceduralGlb(spec);
  const candidatePath = path.join(dir, "candidate.glb");
  const manifestPath = path.join(dir, "render-review-manifest.json");
  const geometryPath = path.join(dir, "geometry-qa.json");
  const texturePath = path.join(dir, "texture-qa.json");
  const modelSha = hash(glb);
  const manifest = {
    schemaVersion: "1.0.0",
    engine: "building-render-review-manifest-v1",
    valid: true,
    status: "render-set-ready-for-human-review",
    modelSha256: modelSha,
    views: [],
    errors: [],
    warnings: [],
    publicationEligible: false,
  };
  const manifestBytes = jsonBytes(manifest);
  const geometryQa = analyzeGlbQuality(glb);
  const textureQa = reviewGlbTextureBindings(glb);
  const geometryBytes = jsonBytes(geometryQa);
  const textureBytes = jsonBytes(textureQa);
  await Promise.all([
    writeFile(candidatePath, glb, { flag: "wx" }),
    writeFile(manifestPath, manifestBytes, { flag: "wx" }),
    writeFile(geometryPath, geometryBytes, { flag: "wx" }),
    writeFile(texturePath, textureBytes, { flag: "wx" }),
  ]);
  const reviewReport = {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: "artifact-test-building",
    valid: true,
    reviewStatus: "reviewer-reported-matches",
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: hash(manifestBytes) },
    comparisons: [],
  };
  return {
    dir, candidatePath, manifestPath, geometryPath, texturePath, reviewReport,
    modelSha, manifestSha: hash(manifestBytes), geometrySha: hash(geometryBytes), textureSha: hash(textureBytes),
  };
}

test("validates on-disk candidate, manifest, and QA report files against recomputed candidate-bound evidence", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const evidence = await inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: f.candidatePath,
    renderManifestPath: f.manifestPath,
    geometryQaReportPath: f.geometryPath,
    textureQaReportPath: f.texturePath,
    reviewReport: f.reviewReport,
  });
  assert.equal(evidence.artifactEvidence.validated, true);
  assert.equal(evidence.artifactEvidence.qaReportsRecomputedFromCandidateModel, true);
  assert.equal(evidence.artifactEvidence.candidateGlbSha256, f.modelSha);
  assert.equal(evidence.artifactEvidence.renderManifestSha256, f.manifestSha);
  assert.equal(evidence.artifactEvidence.geometryQaReportSha256, f.geometrySha);
  assert.equal(evidence.artifactEvidence.textureQaReportSha256, f.textureSha);
});

test("rejects a candidate GLB whose bytes do not match the review provenance", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await writeFile(f.candidatePath + ".other", Buffer.from("not the candidate GLB"), { flag: "wx" });
  await assert.rejects(inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: f.candidatePath + ".other",
    renderManifestPath: f.manifestPath,
    geometryQaReportPath: f.geometryPath,
    textureQaReportPath: f.texturePath,
    reviewReport: f.reviewReport,
  }), /candidate-model-hash-does-not-match/);
});

test("rejects a manifest whose bytes are not the manifest pinned by the fresh review", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const alteredPath = path.join(f.dir, "altered-manifest.json");
  await writeFile(alteredPath, jsonBytes({
    ...JSON.parse(await readFile(f.manifestPath, "utf8")),
    warnings: ["modified-after-review"],
  }), { flag: "wx" });
  await assert.rejects(inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: f.candidatePath,
    renderManifestPath: alteredPath,
    geometryQaReportPath: f.geometryPath,
    textureQaReportPath: f.texturePath,
    reviewReport: f.reviewReport,
  }), /render-manifest-hash-does-not-match/);
});

test("rejects a forged QA report even when its own file hash can be computed", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const qa = JSON.parse(await readFile(f.geometryPath, "utf8"));
  qa.counts.triangleCount += 1;
  const forgedPath = path.join(f.dir, "forged-geometry-qa.json");
  await writeFile(forgedPath, jsonBytes(qa), { flag: "wx" });
  await assert.rejects(inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: f.candidatePath,
    renderManifestPath: f.manifestPath,
    geometryQaReportPath: forgedPath,
    textureQaReportPath: f.texturePath,
    reviewReport: f.reviewReport,
  }), /geometry-qa-does-not-match-recomputed/);
});

test("rejects a QA report symlink instead of following it", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const symlinkPath = path.join(f.dir, "linked-geometry-qa.json");
  await symlink(f.geometryPath, symlinkPath);
  await assert.rejects(inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: f.candidatePath,
    renderManifestPath: f.manifestPath,
    geometryQaReportPath: symlinkPath,
    textureQaReportPath: f.texturePath,
    reviewReport: f.reviewReport,
  }), /regular file, not a symlink/);
});
