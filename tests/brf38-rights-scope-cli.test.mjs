import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/validate-brf38-rights-scope.mjs", import.meta.url));
const realManifest = fileURLToPath(new URL("../benchmarks/building-reconstruction/brf-38-rights-scope.json", import.meta.url));

test("CLI help describes fail-closed rights evidence and exit codes", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /exact-asset rights-scope completeness/);
  assert.match(result.stdout, /Exit code 2: blocked/);
});

test("real TUM2TWIN manifest exits blocked and writes a deterministic report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf38-cli-"));
  try {
    const args = [script, realManifest, "--asset-root", root];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 2);
    assert.equal(second.status, 2);
    const a = JSON.parse(first.stdout);
    const b = JSON.parse(second.stdout);
    assert.equal(a.status, "blocked");
    assert.equal(a.sourceRightsStatus, "incomplete-or-invalid");
    assert.equal(a.reportSha256, b.reportSha256);
    assert.ok(Object.values(a.releaseFlags).every((value) => value === false));
    assert.ok(a.blockers.includes("rights-evidence-assets-present"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI refuses a report path that escapes the asset root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf38-output-path-"));
  try {
    const result = spawnSync(process.execPath, [
      script, realManifest, "--asset-root", root, "--report", "../outside-report.json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /safe project-relative path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
