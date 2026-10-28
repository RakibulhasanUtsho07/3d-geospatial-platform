import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyBrf14MultiviewSource } from "../scripts/verify-brf14-multiview-source.mjs";
import { runBrf42MultiviewPrivateIntake } from "../scripts/run-brf42-multiview-private-intake.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = path.join(repoRoot, "benchmarks/building-reconstruction/brf-14-multiview-source.json");
const cliPath = path.join(repoRoot, "scripts/run-brf42-multiview-private-intake.mjs");
const originalManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
const SOURCE_PREFIX = "https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/images/";
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x0c, 0x00, 0x10, 0x00, 0x30]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeFixture(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "brf42-multiview-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const assetRoot = path.join(workspaceRoot, "images");
  await mkdir(assetRoot);
  const manifest = structuredClone(originalManifest);
  const payloads = manifest.views.map((_view, index) => Buffer.concat([jpegHeader, Buffer.from([index + 1, 0x5a])]));
  manifest.views = manifest.views.map((sourceView, index) => {
    const filename = "fixture-view-" + String(index + 1).padStart(2, "0") + ".JPG";
    const bytes = payloads[index];
    return {
      ...sourceView,
      id: "fixture-view-" + String(index + 1).padStart(2, "0"),
      filename,
      localPath: filename,
      sourceUrl: SOURCE_PREFIX + filename,
      expectedByteSize: bytes.length,
      expectedSha256: hash(bytes),
    };
  });
  manifest.selectionMethod.expectedViewCount = manifest.views.length;
  manifest.expectedTotalBytes = payloads.reduce((sum, bytes) => sum + bytes.length, 0);
  manifest.maximumImageBytes = 1024;
  manifest.maximumTotalBytes = 4096;

  for (let index = 0; index < manifest.views.length; index += 1) {
    await writeFile(path.join(assetRoot, manifest.views[index].filename), payloads[index]);
  }
  const verificationReport = await verifyBrf14MultiviewSource(manifest, assetRoot);
  return { workspaceRoot, assetRoot, manifest, verificationReport, payloads };
}
function fakeFfmpeg() {
  let sampleIndex = 0;
  return (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      assert.ok(args.includes("-vf"), "quality preflight should run the bounded FFmpeg filter");
      const seed = sampleIndex++;
      const gray = Buffer.alloc(64 * 64);
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          const block = Math.floor(y / 8) * 8 + Math.floor(x / 8);
          gray[y * 64 + x] = ((seed >> (block % 4)) & 1) ? 230 : 20;
        }
      }
      child.stdout.end(gray);
      child.emit("close", 0, null);
    });
    return child;
  };
}
function runOptions(fixture, extras = {}) {
  return {
    workspaceRoot: fixture.workspaceRoot,
    assetRoot: fixture.assetRoot,
    manifest: fixture.manifest,
    verificationReport: fixture.verificationReport,
    spawnImpl: fakeFfmpeg(),
    timeoutMs: 10000,
    ...extras,
  };
}

test("ingests all 16 verified views privately and completes image-quality preflight without approval", async (t) => {
  const fixture = await makeFixture(t);
  const report = await runBrf42MultiviewPrivateIntake(runOptions(fixture));

  assert.equal(report.status, "private-multiview-preflight-complete-not-reconstruction-approved");
  assert.equal(report.byteVerification.status, "views-byte-verified");
  assert.equal(report.byteVerification.selectedViewCount, 16);
  assert.equal(report.byteVerification.verifiedViewCount, 16);
  assert.equal(report.privateMediaIntake.status, "all-views-ingested-private");
  assert.equal(report.privateMediaIntake.ingestedCount, 16);
  assert.equal(report.privateMediaIntake.records.length, 16);
  assert.ok(report.privateMediaIntake.records.every(record => record.usageStatus === "unreviewed"));
  assert.ok(report.privateMediaIntake.records.every(record => /^([a-f0-9]{64})$/.test(record.sha256)));
  assert.equal(report.imageQualityPreflight.status, "all-images-decoded-and-measured");
  assert.equal(report.imageQualityPreflight.qualityAnalysisComplete, true);
  assert.equal(report.imageQualityPreflight.sourceCount, 16);
  assert.equal(report.imageQualityPreflight.uniqueContentCount, 16);
  assert.equal(report.imageQualityPreflight.rightsApproved, false);
  assert.equal(report.imageQualityPreflight.safeToSubmitToColmap, false);
  assert.equal(report.reviewAndRelease.visualOverlap, "pending-human-review");
  assert.equal(report.reviewAndRelease.sameBuildingIdentity, "source-declared-not-independently-confirmed");
  assert.equal(report.reviewAndRelease.candidateGlbGenerated, false);
  assert.equal(report.reviewAndRelease.reconstructionExecuted, false);
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });

  const sourceRecordPath = path.join(
    fixture.workspaceRoot, ".building-engine", "media", "brf42-flat-roof-demo", "sources", "fixture-view-01.json",
  );
  const stored = JSON.parse(await readFile(sourceRecordPath, "utf8"));
  assert.equal(stored.sha256, fixture.manifest.views[0].expectedSha256);
  assert.equal(stored.usageStatus, "unreviewed");
  assert.equal(stored.capturedAt, fixture.manifest.views[0].capturedAt);
  assert.equal(stored.location.latitude, fixture.manifest.views[0].gps.latitude);
  assert.equal(stored.location.longitude, fixture.manifest.views[0].gps.longitude);
});

test("blocks a changed image before creating any private intake records", async (t) => {
  const fixture = await makeFixture(t);
  const target = fixture.manifest.views[3];
  await writeFile(path.join(fixture.assetRoot, target.filename), Buffer.concat([jpegHeader, Buffer.from([0xff, 0x5a])]));
  await assert.rejects(
    runBrf42MultiviewPrivateIntake(runOptions(fixture)),
    /Fresh source-byte revalidation/i,
  );
  await assert.rejects(
    access(path.join(fixture.workspaceRoot, ".building-engine", "media", "brf42-flat-roof-demo")),
  );
});

test("blocks an earlier report that does not prove all 16 pinned source hashes", async (t) => {
  const fixture = await makeFixture(t);
  fixture.verificationReport.views[6].actualSha256 = "0".repeat(64);
  await assert.rejects(
    runBrf42MultiviewPrivateIntake(runOptions(fixture)),
    /does not prove the exact pinned bytes/i,
  );
});

test("blocks a manifest/source URL mismatch instead of trusting a report from another asset", async (t) => {
  const fixture = await makeFixture(t);
  fixture.manifest.views[0].sourceUrl = "https://example.org/another-image.jpg";
  await assert.rejects(
    runBrf42MultiviewPrivateIntake(runOptions(fixture)),
    /does not prove the exact pinned bytes/i,
  );
});

test("blocks missing images before any private intake", async (t) => {
  const fixture = await makeFixture(t);
  await rm(path.join(fixture.assetRoot, fixture.manifest.views[2].filename));
  await assert.rejects(
    runBrf42MultiviewPrivateIntake(runOptions(fixture)),
    /Fresh source-byte revalidation/i,
  );
  await assert.rejects(
    access(path.join(fixture.workspaceRoot, ".building-engine", "media", "brf42-flat-roof-demo")),
  );
});

test("rejects an asset directory outside the temporary workspace", async (t) => {
  const fixture = await makeFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "brf42-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(
    runBrf42MultiviewPrivateIntake({ ...runOptions(fixture), assetRoot: outside }),
    /assetRoot must be a child directory/i,
  );
});

test("CLI help documents the no-reconstruction and no-accuracy boundary", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ingests them privately/i);
  assert.match(result.stdout, /does not run COLMAP or validate real-building accuracy/i);
});
