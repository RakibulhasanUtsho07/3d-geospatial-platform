import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../scripts/verify-building-benchmark-assets.mjs", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf11-asset-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceFiles = [
    ["images/front.jpg", "front-image-bytes"],
    ["reference/model.gml", "reference-model-bytes"],
    ["reference/surface.laz", "independent-surface-bytes"],
    ["candidate/candidate.glb", "platform-candidate-glb-bytes"],
  ];
  for (const [relativePath, content] of sourceFiles) {
    const filePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  const asset = (id, role, localPath, content) => ({
    id, role, localPath, filename: path.basename(localPath),
    byteSize: Buffer.byteLength(content), sha256: sha256(content),
    sourceUrl: "https://data.example.org/" + localPath,
  });
  const manifest = {
    schemaVersion: "1.0.0",
    evaluationId: "brf11-cli-test-01",
    assets: [
      asset("image-front", "candidate-image", "images/front.jpg", "front-image-bytes"),
      asset("reference-model", "reference-model", "reference/model.gml", "reference-model-bytes"),
      asset("independent-surface", "independent-surface", "reference/surface.laz", "independent-surface-bytes"),
    ],
    candidate: {
      glbPath: "candidate/candidate.glb",
      glbByteSize: Buffer.byteLength("platform-candidate-glb-bytes"),
      glbSha256: sha256("platform-candidate-glb-bytes"),
      sourceAssetIds: ["image-front"],
      generatedByPlatform: true,
      groundTruthModelImported: false,
    },
    reference: { sourceAssetIds: ["reference-model", "independent-surface"] },
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, manifestPath };
}

function run(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("asset-byte verifier CLI help is successful and states its limits", () => {
  const result = run(["--help"], process.cwd());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /actual local file byte sizes and SHA-256/i);
  assert.match(result.stdout, /does not download assets/i);
});

test("CLI exits zero only when all local bytes verify", async (t) => {
  const { root, manifestPath } = await withFixture(t);
  const result = run([manifestPath], root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "verified");
  assert.equal(report.candidate.verified, true);
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.mapReady, false);
});

test("CLI exits two when a source file differs from declared hash", async (t) => {
  const { root, manifestPath } = await withFixture(t);
  await writeFile(path.join(root, "images/front.jpg"), "corrupt-image-bytes");
  const result = run([manifestPath], root);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-image-front-sha256"));
});

test("CLI exits one for malformed or missing manifest files", async (t) => {
  const { root, manifestPath } = await withFixture(t);
  const malformed = path.join(root, "malformed.json");
  await writeFile(malformed, "{bad-json");
  assert.equal(run([malformed], root).status, 1);
  assert.equal(run([path.join(root, "missing.json")], root).status, 1);
});
