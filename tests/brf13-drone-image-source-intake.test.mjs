import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyBrf13DroneImageSource } from "../scripts/verify-brf13-drone-image-source.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/verify-brf13-drone-image-source.mjs", import.meta.url));
const repositoryManifestPath = fileURLToPath(new URL("../benchmarks/building-reconstruction/brf-13-drone-image-source.json", import.meta.url));

async function fixture(t, bytes = Buffer.from("deterministic-small-jpeg-fixture")) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brf13-drone-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "sample.jpg");
  await writeFile(filePath, bytes);
  const manifest = {
    schemaVersion: "1.0.0",
    sampleId: "brf13-test-image",
    evaluationStage: "source-byte-intake-only",
    dataset: {
      title: "Fixture Dataset",
      version: "1.0.0",
      datasetUrl: "https://huggingface.co/datasets/Matt1up/drone-building-scans",
      sourceRepository: "https://github.com/Matt1Up/drone-building-scans-dataset",
      sourceRepositoryCommit: "19b3ce9cccf3e8fd414ff705f75d0f2105846fc1",
      license: "CC-BY-4.0",
      licenseScope: "Images only; separate reference models are not assumed licensed.",
      attribution: "Fixture author, 2026. CC BY 4.0.",
      rightsStatus: "declared-by-source-not-independently-authenticated"
    },
    asset: {
      role: "candidate-image",
      buildingId: "flat-roof-commercial-building",
      filename: "sample.jpg",
      mediaType: "image/jpeg",
      sourceUrl: "https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/images/sample.jpg",
      expectedByteSize: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      width: 4096,
      height: 3072,
      upstreamManifestUrl: "https://github.com/Matt1Up/drone-building-scans-dataset"
    },
    knownLimitations: ["Fixture does not establish a real-building accuracy result."],
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false
  };
  return { directory, filePath, manifest };
}

test("verifies matching bytes and keeps all release gates disabled", async (t) => {
  const { filePath, manifest } = await fixture(t);
  const report = await verifyBrf13DroneImageSource(manifest, filePath);
  assert.equal(report.status, "bytes-verified");
  assert.equal(report.asset.actualByteSize, manifest.asset.expectedByteSize);
  assert.equal(report.asset.actualSha256, manifest.asset.expectedSha256);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.automaticApproval, false);
});

test("blocks a same-size byte change through SHA-256 mismatch", async (t) => {
  const { filePath, manifest } = await fixture(t, Buffer.from("same-size-fixture"));
  await writeFile(filePath, Buffer.from("SAME-size-fixture"));
  manifest.asset.expectedByteSize = Buffer.byteLength("same-size-fixture");
  manifest.asset.expectedSha256 = createHash("sha256").update("same-size-fixture").digest("hex");
  const report = await verifyBrf13DroneImageSource(manifest, filePath);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, ["local-image-sha256"]);
  assert.equal(report.checks[0].status, "passed");
  assert.equal(report.checks[1].status, "blocked");
  assert.equal(report.acceptanceEligible, false);
});

test("blocks a downloaded file whose actual size differs from manifest", async (t) => {
  const { filePath, manifest } = await fixture(t, Buffer.from("actual-byte-count"));
  manifest.asset.expectedByteSize += 1;
  const report = await verifyBrf13DroneImageSource(manifest, filePath);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("local-image-byte-size"));
});

test("refuses a source URL outside the allowlisted Hugging Face dataset path", async (t) => {
  const { filePath, manifest } = await fixture(t);
  manifest.asset.sourceUrl = "https://example.org/" + manifest.asset.filename;
  await assert.rejects(
    verifyBrf13DroneImageSource(manifest, filePath),
    /allowlisted|Hugging Face dataset path/i
  );
});

test("refuses symlinked downloaded files", async (t) => {
  const { directory, filePath, manifest } = await fixture(t);
  const linkPath = path.join(directory, "sample-link.jpg");
  await symlink(filePath, linkPath);
  await assert.rejects(verifyBrf13DroneImageSource(manifest, linkPath), /non-symlink/i);
});

test("repository source manifest records attribution and never declares model acceptance", async () => {
  const manifest = JSON.parse(await readFile(repositoryManifestPath, "utf8"));
  assert.equal(manifest.asset.filename, "DJI_20260822183442_0005_D.JPG");
  assert.equal(manifest.asset.expectedByteSize, 8343552);
  assert.match(manifest.asset.expectedSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.dataset.license, "CC-BY-4.0");
  assert.match(manifest.dataset.licenseScope, /imagery/i);
  assert.equal(manifest.acceptanceEligible, false);
  assert.equal(manifest.publicationEligible, false);
  assert.equal(manifest.mapReady, false);
  assert.equal(manifest.automaticApproval, false);
});

test("CLI help is explicit and successful", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source image/i);
  assert.match(result.stdout, /not model accuracy/i);
});

test("CLI writes a byte-verification report for a matching input file", async (t) => {
  const { directory, filePath, manifest } = await fixture(t);
  const manifestPath = path.join(directory, "manifest.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [
    scriptPath, "--manifest", manifestPath, "--file", filePath, "--report", reportPath
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "bytes-verified");
  assert.equal(report.automaticApproval, false);
});

test("CLI exits blocked for a byte mismatch", async (t) => {
  const { directory, filePath, manifest } = await fixture(t);
  manifest.asset.expectedSha256 = "0".repeat(64);
  const manifestPath = path.join(directory, "manifest.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [
    scriptPath, "--manifest", manifestPath, "--file", filePath, "--report", reportPath
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.acceptanceEligible, false);
});
