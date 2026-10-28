import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../scripts/verify-brf36-source-assets.mjs", import.meta.url));
const hash = (v) => createHash("sha256").update(v).digest("hex");
async function rootFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf36-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function run(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8", timeout: 10_000 });
}

test("CLI help documents the non-approval scope", () => {
  const result = run(["--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /does not verify rights\/identity\/CRS/i);
  assert.match(result.stdout, /no network calls/i);
});

test("CLI exits 0 only for byte-verified input and writes the report once", async (t) => {
  const root = await rootFixture(t);
  await mkdir(path.join(root, "inputs"));
  const content = "exact source bytes";
  await writeFile(path.join(root, "inputs", "source.txt"), content);
  const manifestPath = path.join(root, "manifest.json");
  const reportPath = path.join(root, "report.json");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: "1.0.0", evaluationId: "brf36-cli-01", assets: [
    { id: "source-one", role: "survey-control", status: "pinned", localPath: "inputs/source.txt",
      byteSize: Buffer.byteLength(content), sha256: hash(content), rightsStatus: "pending" }
  ] }));
  const result = run([manifestPath, "--asset-root", root, "--report", reportPath], root);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "source-bytes-verified-review-required");
  assert.equal(JSON.parse(await (await import("node:fs/promises")).readFile(reportPath, "utf8")).byteStatus, "verified");
  assert.equal(run([manifestPath, "--asset-root", root, "--report", reportPath], root).status, 1);
});

test("CLI returns status 2 and retains blockers if pinned source bytes are absent", async (t) => {
  const root = await rootFixture(t);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: "1.0.0", evaluationId: "brf36-cli-02", assets: [
    { id: "missing-image", role: "image-frame", status: "pinned", localPath: "missing/image.jpg", byteSize: 5, sha256: hash("hello") }
  ] }));
  const result = run([manifestPath, "--asset-root", root], root);
  assert.equal(result.status, 2);
  assert.ok(JSON.parse(result.stdout).blockers.includes("asset-missing-image-file"));
});
