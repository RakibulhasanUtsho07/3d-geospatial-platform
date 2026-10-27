import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../scripts/verify-building-benchmark-asset-bytes.mjs", import.meta.url));
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf10-asset-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = "trusted only after local hash matches";
  await writeFile(path.join(root, "front.jpg"), bytes);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = {
    schemaVersion: "1.0.0",
    assets: [{
      id: "front-image",
      sourceUrl: "https://data.example.invalid/front.jpg",
      filename: "front.jpg",
      localPath: "front.jpg",
      byteSize: Buffer.byteLength(bytes),
      sha256: hash(bytes),
    }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, manifest };
}

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("CLI help states that verification is local-byte only", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /actual file byte size/i);
  assert.match(result.stdout, /does not download files/i);
});

test("CLI returns verified report for matching local bytes", async (t) => {
  const { root, manifestPath } = await setup(t);
  const result = run([manifestPath, "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "verified");
  assert.equal(report.assets[0].status, "verified");
  assert.equal(report.automaticApproval, false);
});

test("CLI exits 2 on hash mismatch and does not print verified status", async (t) => {
  const { root, manifestPath, manifest } = await setup(t);
  manifest.assets[0].sha256 = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = run([manifestPath, "--root", root]);
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.doesNotMatch(result.stdout, /"status": "verified"/);
  assert.match(result.stdout, /sha256-mismatch/);
});

test("CLI exits 2 when the explicit root is omitted", async (t) => {
  const { manifestPath } = await setup(t);
  const result = run([manifestPath]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--root/);
});

test("CLI reports malformed JSON as an input error", async (t) => {
  const { root, manifestPath } = await setup(t);
  await writeFile(manifestPath, "{bad-json");
  const result = run([manifestPath, "--root", root]);
  assert.equal(result.status, 1);
  assert.notEqual(result.stderr.trim(), "");
  assert.doesNotMatch(result.stdout, /"status": "verified"/);
});
