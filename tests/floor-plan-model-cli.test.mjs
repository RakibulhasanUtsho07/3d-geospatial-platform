import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-floor-plan-geometry.json", import.meta.url), "utf8"));
const cliPath = path.resolve("scripts/generate-floor-plan-model.mjs");

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "floor-plan-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

test("CLI writes a GLB and report and marks original-source hash as verified only when bytes match", async (t) => {
  const directory = await tempDirectory(t);
  const sourceBytes = Buffer.from("%PDF-1.7\nmeasured source fixture\n", "utf8");
  const sourcePath = path.join(directory, "original-plan.pdf");
  const inputPath = path.join(directory, "geometry.json");
  const outputPath = path.join(directory, "ground-floor.glb");
  await writeFile(sourcePath, sourceBytes);
  await writeFile(inputPath, JSON.stringify({
    ...fixture,
    source: {
      sourceId: "measured-plan-pdf",
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    },
  }));

  const result = runCli([inputPath, outputPath, sourcePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const glb = await readFile(outputPath);
  const report = JSON.parse(await readFile(outputPath + ".report.json", "utf8"));
  assert.equal(glb.readUInt32LE(0), 0x46546c67);
  assert.equal(report.input.sourceEvidenceVerified, true);
  assert.equal(report.input.verifiedSourceSha256, createHash("sha256").update(sourceBytes).digest("hex"));
  assert.ok(!report.warnings.some((warning) => warning.startsWith("A source SHA-256 is metadata")));
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
});

test("CLI refuses a mismatched original source hash and does not write a candidate", async (t) => {
  const directory = await tempDirectory(t);
  const sourcePath = path.join(directory, "original-plan.pdf");
  const inputPath = path.join(directory, "geometry.json");
  const outputPath = path.join(directory, "ground-floor.glb");
  await writeFile(sourcePath, Buffer.from("%PDF-1.7\ntampered source\n", "utf8"));
  await writeFile(inputPath, JSON.stringify(fixture));

  const result = runCli([inputPath, outputPath, sourcePath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 does not match/);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  await assert.rejects(readFile(outputPath + ".report.json"), { code: "ENOENT" });
});

test("CLI rejects output paths that overwrite the geometry input", async (t) => {
  const directory = await tempDirectory(t);
  const inputPath = path.join(directory, "geometry.json");
  await writeFile(inputPath, JSON.stringify(fixture));
  const result = runCli([inputPath, inputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use distinct paths/);
});
