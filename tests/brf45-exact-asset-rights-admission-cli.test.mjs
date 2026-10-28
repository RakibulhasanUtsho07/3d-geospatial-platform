import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../scripts/validate-brf45-exact-asset-rights-admission.mjs", import.meta.url).pathname;
const manifestPath = new URL("../benchmarks/building-reconstruction/brf-45-exact-asset-rights-admission.json", import.meta.url).pathname;
const sourceManifestPath = new URL("../benchmarks/building-reconstruction/brf-14-multiview-source.json", import.meta.url).pathname;

test("CLI help describes the bounded rights use and exit codes", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /private local reconstruction and validation/i);
  assert.match(result.stdout, /Exit code 2: blocked\/incomplete/);
});

test("the real 16-view sample remains blocked with absent exact-asset evidence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf45-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot);
  const result = spawnSync(process.execPath, [
    cli, manifestPath, "--source-manifest", sourceManifestPath,
    "--evidence-root", evidenceRoot, "--report", "rights-report.json",
  ], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "blocked");
  assert.equal(summary.sourceViewCount, 16);
  assert.equal(summary.rightsApprovedAssetCount, 0);
  assert.ok(summary.blockerCount >= 16);
  assert.ok(Object.values(summary.releaseFlags).every(value => value === false));
  const report = JSON.parse(await readFile(path.join(root, "rights-report.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.rightsApprovedAssetCount, 0);
});

test("CLI refuses report paths that traverse outside the working directory", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf45-cli-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    cli, manifestPath, "--source-manifest", sourceManifestPath,
    "--evidence-root", root, "--report", "../outside.json",
  ], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /safe relative path/);
});
