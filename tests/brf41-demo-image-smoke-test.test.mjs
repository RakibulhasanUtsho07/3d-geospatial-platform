import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runBrf41DemoImageSmokeTest } from "../scripts/run-brf41-demo-image-smoke-test.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = path.join(root, "benchmarks/building-reconstruction/brf-13-drone-image-source.json");
const policyManifestPath = path.join(root, "benchmarks/building-reconstruction/brf-41-interim-dataset-policy.json");
const cliPath = path.join(root, "scripts/run-brf41-demo-image-smoke-test.mjs");
const baseSourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
const basePolicyManifest = JSON.parse(await readFile(policyManifestPath, "utf8"));

// Minimal JPEG SOF header with declared 1024×768 dimensions. FFmpeg is stubbed;
// this fixture tests policy, actual-byte binding and media-intake integration without network.
const jpegFixture = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08,
  0x03, 0x00, 0x04, 0x00, 0x03,
]);

async function makeFixture(t, bytes = jpegFixture) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "brf41-demo-image-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(path.join(workspaceRoot, "input"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "input", "sample.jpg"), bytes);
  const sourceManifest = structuredClone(baseSourceManifest);
  sourceManifest.asset.filename = "DJI_20260822183442_0005_D.JPG";
  sourceManifest.asset.sourceUrl = "https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/images/DJI_20260822183442_0005_D.JPG";
  sourceManifest.asset.expectedByteSize = bytes.length;
  sourceManifest.asset.expectedSha256 = createHashHex(bytes);
  sourceManifest.asset.width = 1024;
  sourceManifest.asset.height = 768;
  const policyManifest = structuredClone(basePolicyManifest);
  const asset = policyManifest.assets.find(item => item.id === "brf13-flat-roof-image-0005");
  asset.source.byteSize = bytes.length;
  asset.source.sha256 = sourceManifest.asset.expectedSha256;
  asset.actualByteVerification.actualByteSize = bytes.length;
  asset.actualByteVerification.actualSha256 = sourceManifest.asset.expectedSha256;
  return { workspaceRoot, sourceManifest, policyManifest };
}
function createHashHex(bytes) {
  return requireSha256(bytes);
}
function requireSha256(bytes) {
  // Keep the fixture hash calculation local and deterministic.
  return createHash("sha256").update(bytes).digest("hex");
}
function fakeFfmpeg() {
  return (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      assert.ok(args.includes("-vf"), "image quality preflight should use a bounded FFmpeg filter");
      child.stdout.end(Buffer.alloc(64 * 64, 80));
      child.emit("close", 0, null);
    });
    return child;
  };
}
test("verified demo image is privately ingested and decoded, never accepted as reconstruction truth", async t => {
  const fixture = await makeFixture(t);
  const report = await runBrf41DemoImageSmokeTest({
    ...fixture,
    sourceRelativePath: "input/sample.jpg",
    spawnImpl: fakeFfmpeg(),
    timeoutMs: 10000,
  });
  assert.equal(report.status, "demo-smoke-tested-not-accuracy-validated");
  assert.equal(report.byteVerification.status, "bytes-verified");
  assert.equal(report.mediaIntake.status, "ingested-private");
  assert.equal(report.mediaIntake.kind, "image");
  assert.equal(report.mediaIntake.mimeType, "image/jpeg");
  assert.equal(report.mediaIntake.usageStatus, "unreviewed");
  assert.match(report.mediaIntake.licence, /CC BY 4\.0/i);
  assert.equal(report.mediaIntake.sha256, fixture.sourceManifest.asset.expectedSha256);
  assert.equal(report.imageQualityPreflight.status, "decoded-and-measured");
  assert.equal(report.imageQualityPreflight.width, 1024);
  assert.equal(report.imageQualityPreflight.height, 768);
  assert.equal(report.imageQualityPreflight.reconstructionCandidate, false);
  assert.equal(report.imageQualityPreflight.safeToSubmitToColmap, false);
  assert.equal(report.imageQualityPreflight.rightsApproved, false);
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
  const stored = JSON.parse(await readFile(path.join(fixture.workspaceRoot, ".building-engine", "media", "brf41-demo-commercial-building", "sources", "brf41-demo-image-0005.json"), "utf8"));
  assert.equal(stored.usageStatus, "unreviewed");
  assert.equal(stored.sha256, report.byteVerification.actualSha256);
  assert.equal(report.privateWorkspaceOnly, true);
});

test("wrong source bytes block before private media ingestion", async t => {
  const fixture = await makeFixture(t, Buffer.from([...jpegFixture, 0x01]));
  fixture.sourceManifest.asset.expectedByteSize = jpegFixture.length;
  fixture.sourceManifest.asset.expectedSha256 = createHashHex(jpegFixture);
  const asset = fixture.policyManifest.assets.find(item => item.id === "brf13-flat-roof-image-0005");
  asset.source.byteSize = jpegFixture.length;
  asset.source.sha256 = createHashHex(jpegFixture);
  asset.actualByteVerification.actualByteSize = jpegFixture.length;
  asset.actualByteVerification.actualSha256 = createHashHex(jpegFixture);
  await assert.rejects(
    runBrf41DemoImageSmokeTest({ ...fixture, sourceRelativePath: "input/sample.jpg", spawnImpl: fakeFfmpeg() }),
    /byte verification failed/i,
  );
  await assert.rejects(access(path.join(fixture.workspaceRoot, ".building-engine", "media", "brf41-demo-commercial-building")));
});

test("policy must explicitly allow private image quality preflight", async t => {
  const fixture = await makeFixture(t);
  const asset = fixture.policyManifest.assets.find(item => item.id === "brf13-flat-roof-image-0005");
  asset.allowedUses = asset.allowedUses.filter(use => use !== "private-image-quality-preflight");
  await assert.rejects(
    runBrf41DemoImageSmokeTest({ ...fixture, sourceRelativePath: "input/sample.jpg", spawnImpl: fakeFfmpeg() }),
    /not explicitly admitted/i,
  );
});

test("demo image cannot be promoted to approved rights or a release flag", async t => {
  const fixture = await makeFixture(t);
  fixture.policyManifest.releaseFlags.mapReady = true;
  await assert.rejects(
    runBrf41DemoImageSmokeTest({ ...fixture, sourceRelativePath: "input/sample.jpg", spawnImpl: fakeFfmpeg() }),
    /admission policy is blocked/i,
  );
});

test("source manifest must match the exact BRF-41 asset URL and digest", async t => {
  const fixture = await makeFixture(t);
  fixture.sourceManifest.asset.expectedSha256 = "0".repeat(64);
  await assert.rejects(
    runBrf41DemoImageSmokeTest({ ...fixture, sourceRelativePath: "input/sample.jpg", spawnImpl: fakeFfmpeg() }),
    /does not match the exact BRF-41 admission pin/i,
  );
});

test("CLI help documents bounded use and the no-accuracy claim boundary", () => {
  const run = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /one-image quality preflight/i);
  assert.match(run.stdout, /not 3D reconstruction or accuracy validation/i);
});
