import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertStableBuildingReviewPackageVerificationWindow,
  readBuildingReviewPackageDirectory,
  readBuildingReviewPackageControlFile,
  sameBuildingReviewPackageControlFile,
  sameBuildingReviewPackageSnapshot,
} from "../src/core/building-generation/building-review-package-directory.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function tempPackage(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "d3m11-package-directory-"));
  const packageDir = path.join(parent, "review-package");
  await mkdir(packageDir);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: "1.0.0",
    engine: "building-review-package-v1",
    buildingId: "directory-test-building",
    artifacts: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(packageDir, "package-manifest.json"), manifestBytes);
  return { parent, packageDir, manifestBytes };
}

test("reads one stable package snapshot and excludes only root control files", async (t) => {
  const { packageDir, manifestBytes } = await tempPackage(t);
  const artifactBytes = Buffer.from("candidate-bytes");
  await mkdir(path.join(packageDir, "model"));
  await writeFile(path.join(packageDir, "model", "candidate.glb"), artifactBytes);
  await writeFile(path.join(packageDir, "package-manifest.sig.json"), "{}");

  const first = await readBuildingReviewPackageDirectory(packageDir);
  const second = await readBuildingReviewPackageDirectory(packageDir);
  assert.equal(first.packageManifestSha256, sha256(manifestBytes));
  assert.equal(first.packageManifest.buildingId, "directory-test-building");
  assert.deepEqual(first.actualFiles.map((item) => item.relativePath), ["model/candidate.glb"]);
  assert.equal(first.actualFiles[0].sha256, sha256(artifactBytes));
  assert.equal(first.actualFiles[0].bytes, artifactBytes.length);
  assert.equal(sameBuildingReviewPackageSnapshot(first, second), true);
});

test("changes in package bytes produce a different inventory snapshot token", async (t) => {
  const { packageDir } = await tempPackage(t);
  const artifactPath = path.join(packageDir, "artifact.bin");
  await writeFile(artifactPath, "first revision");
  const first = await readBuildingReviewPackageDirectory(packageDir);
  await writeFile(artifactPath, "second revision");
  const second = await readBuildingReviewPackageDirectory(packageDir);
  assert.equal(sameBuildingReviewPackageSnapshot(first, second), false);
});

test("rejects a symlinked artifact before treating it as a package file", async (t) => {
  const { parent, packageDir } = await tempPackage(t);
  const outside = path.join(parent, "outside.bin");
  await writeFile(outside, "outside bytes");
  await symlink(outside, path.join(packageDir, "linked.bin"));

  await assert.rejects(
    readBuildingReviewPackageDirectory(packageDir),
    /review-package-symlink-not-allowed/,
  );
});

test("rejects a symlinked package manifest and a non-directory package root", async (t) => {
  const { parent, packageDir } = await tempPackage(t);
  const manifestPath = path.join(packageDir, "package-manifest.json");
  const bytes = await readFile(manifestPath);
  await rm(manifestPath);
  const outsideManifest = path.join(parent, "outside-manifest.json");
  await writeFile(outsideManifest, bytes);
  await symlink(outsideManifest, manifestPath);
  await assert.rejects(readBuildingReviewPackageDirectory(packageDir), /review-package-symlink-not-allowed/);

  const nonDirectory = path.join(parent, "plain-file");
  await writeFile(nonDirectory, "not a directory");
  await assert.rejects(readBuildingReviewPackageDirectory(nonDirectory), /review-package-root-must-be-a-directory/);
});

test("rejects unsafe package filenames instead of normalizing them", async (t) => {
  const { packageDir } = await tempPackage(t);
  await writeFile(path.join(packageDir, "bad name.bin"), "unsafe");
  await assert.rejects(readBuildingReviewPackageDirectory(packageDir), /review-package-unsafe-relative-path/);
});

test("does not silently accept a directory swapped or mutated during inventory", async (t) => {
  const { packageDir } = await tempPackage(t);
  await mkdir(path.join(packageDir, "nested"));
  await writeFile(path.join(packageDir, "nested", "one.bin"), "one");
  const before = await readBuildingReviewPackageDirectory(packageDir);
  await writeFile(path.join(packageDir, "nested", "two.bin"), "two");
  const after = await readBuildingReviewPackageDirectory(packageDir);
  assert.equal(sameBuildingReviewPackageSnapshot(before, after), false);
});


test("reads detached signature control file through the stable no-follow reader", async (t) => {
  const { packageDir, parent } = await tempPackage(t);
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  await writeFile(signaturePath, JSON.stringify({ schemaVersion: "2.0.0" }));
  const first = await (await import("../src/core/building-generation/building-review-package-directory.mjs"))
    .readBuildingReviewPackageControlFile(packageDir, "package-manifest.sig.json");
  assert.equal(first.bytes.toString("utf8"), JSON.stringify({ schemaVersion: "2.0.0" }));
  assert.equal(first.stat.isFile(), true);

  const outside = path.join(parent, "external-signature.json");
  await writeFile(outside, "{}");
  await rm(signaturePath);
  await symlink(outside, signaturePath);
  await assert.rejects(
    (await import("../src/core/building-generation/building-review-package-directory.mjs"))
      .readBuildingReviewPackageControlFile(packageDir, "package-manifest.sig.json"),
    /review-package-symlink-not-allowed/,
  );
});

test("control-file reader refuses arbitrary names and paths", async (t) => {
  const { packageDir } = await tempPackage(t);
  const { readBuildingReviewPackageControlFile } = await import("../src/core/building-generation/building-review-package-directory.mjs");
  await assert.rejects(readBuildingReviewPackageControlFile(packageDir, "../outside"), /Only the detached signature/);
});


test("stable control-file comparison binds bytes and the full file identity", async (t) => {
  const { packageDir } = await tempPackage(t);
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: "2.0.0" }));
  await writeFile(signaturePath, signatureBytes);
  const first = await readBuildingReviewPackageControlFile(packageDir, "package-manifest.sig.json");
  const second = await readBuildingReviewPackageControlFile(packageDir, "package-manifest.sig.json");
  assert.equal(sameBuildingReviewPackageControlFile(first, second), true);
  assert.equal(sameBuildingReviewPackageControlFile(first, { ...second, bytes: Buffer.from("{}") }), false);
  assert.equal(sameBuildingReviewPackageControlFile(first, {
    ...second,
    stat: { ...second.stat, ctimeNs: second.stat.ctimeNs + 1n },
  }), false);
  assert.equal(sameBuildingReviewPackageControlFile(first, {
    ...second,
    stat: { ...second.stat, mode: second.stat.mode ^ 0o100n },
  }), false);
});

test("rejects oversized signature control files and arbitrary control-file names", async (t) => {
  const { packageDir } = await tempPackage(t);
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  await writeFile(signaturePath, Buffer.alloc(64 * 1024 + 1, 0x20));
  await assert.rejects(
    readBuildingReviewPackageControlFile(packageDir, "package-manifest.sig.json"),
    /exceeds-64-KiB/,
  );
  await assert.rejects(
    readBuildingReviewPackageControlFile(packageDir, "package-manifest.json"),
    /Only the detached signature/,
  );
});


test("verification-window guard accepts stable serial package and signature observations", async () => {
  const packageSnapshot = { snapshotToken: "a".repeat(64) };
  const signatureSnapshot = {
    bytes: Buffer.from("signature-envelope"),
    stat: { dev: 1n, ino: 2n, size: 18n, mtimeNs: 3n, ctimeNs: 4n, mode: 0o100600n },
  };
  await assertStableBuildingReviewPackageVerificationWindow({
    initialPackageSnapshot: packageSnapshot,
    initialSignatureSnapshot: signatureSnapshot,
    readPackageSnapshot: async () => ({ snapshotToken: "a".repeat(64) }),
    readSignatureSnapshot: async () => ({
      bytes: Buffer.from(signatureSnapshot.bytes),
      stat: { ...signatureSnapshot.stat },
    }),
  });
});

test("verification-window guard rejects package mutation between post-crypto observations", async () => {
  const packageSnapshot = { snapshotToken: "a".repeat(64) };
  const signatureSnapshot = {
    bytes: Buffer.from("signature-envelope"),
    stat: { dev: 1n, ino: 2n, size: 18n, mtimeNs: 3n, ctimeNs: 4n, mode: 0o100600n },
  };
  let reads = 0;
  await assert.rejects(
    assertStableBuildingReviewPackageVerificationWindow({
      initialPackageSnapshot: packageSnapshot,
      initialSignatureSnapshot: signatureSnapshot,
      readPackageSnapshot: async () => ({
        snapshotToken: ++reads === 1 ? "a".repeat(64) : "b".repeat(64),
      }),
      readSignatureSnapshot: async () => ({
        bytes: Buffer.from(signatureSnapshot.bytes),
        stat: { ...signatureSnapshot.stat },
      }),
    }),
    /review-package-changed-during-signature-verification/,
  );
});

test("verification-window guard rejects signature content or metadata mutation", async () => {
  const packageSnapshot = { snapshotToken: "a".repeat(64) };
  const signatureSnapshot = {
    bytes: Buffer.from("signature-envelope"),
    stat: { dev: 1n, ino: 2n, size: 18n, mtimeNs: 3n, ctimeNs: 4n, mode: 0o100600n },
  };
  let reads = 0;
  await assert.rejects(
    assertStableBuildingReviewPackageVerificationWindow({
      initialPackageSnapshot: packageSnapshot,
      initialSignatureSnapshot: signatureSnapshot,
      readPackageSnapshot: async () => ({ snapshotToken: "a".repeat(64) }),
      readSignatureSnapshot: async () => ({
        bytes: Buffer.from(signatureSnapshot.bytes),
        stat: {
          ...signatureSnapshot.stat,
          ...(++reads === 1 ? {} : { ctimeNs: 9n }),
        },
      }),
    }),
    /review-package-signature-envelope-changed-during-verification/,
  );
});
