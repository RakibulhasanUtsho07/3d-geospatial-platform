import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../scripts/validate-building-benchmark-readiness.mjs", import.meta.url));

async function withTempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brf10-readiness-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("benchmark-readiness CLI help is successful and explicitly metadata-only", () => {
  const result = run(["--help"], process.cwd());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /metadata preflight only/i);
  assert.match(result.stdout, /does not download\/hash files/i);
});

test("CLI exits non-zero and prints all blockers for an incomplete manifest", async (t) => {
  const directory = await withTempDir(t);
  const manifestPath = path.join(directory, "incomplete.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: "1.0.0",
    evaluationId: "blocked-eval-01",
    building: { id: "building-01", name: "Building 01", identityEvidence: "" },
    evaluation: { coordinateFrameId: "site-enu-v1", units: "m" },
    assets: [],
  }));

  const result = run([manifestPath], directory);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("building-identity"));
  assert.ok(report.blockers.includes("asset-manifest-present"));
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.automaticApproval, false);
});

test("CLI returns an explicit error for malformed JSON without claiming readiness", async (t) => {
  const directory = await withTempDir(t);
  const manifestPath = path.join(directory, "malformed.json");
  await writeFile(manifestPath, "{not-json");
  const result = run([manifestPath], directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON|Unexpected|Expected/i);
  assert.doesNotMatch(result.stdout, /manifest-complete/);
});

test("CLI returns an explicit error for a missing manifest", async (t) => {
  const directory = await withTempDir(t);
  const result = run([path.join(directory, "missing.json")], directory);
  assert.equal(result.status, 1);
  assert.notEqual(result.stderr.trim(), "");
});
