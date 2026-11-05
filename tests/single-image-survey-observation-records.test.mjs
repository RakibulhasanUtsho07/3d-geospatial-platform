import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectSingleImageSurveyObservationRecords,
  verifyPackagedSingleImageSurveyObservationRecords,
  SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE,
  MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
} from "../src/core/building-generation/single-image-survey-observation-records.mjs";
import { canonicalJson } from "../src/core/building-generation/generation-artifact-receipt.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, count = 6) {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m15-survey-records-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "evidence", "survey-observations");
  await mkdir(directory, { recursive: true });
  const checkpoints = [];
  const payloads = [];
  for (let index = 0; index < count; index++) {
    const observationId = "observation-" + (index + 1);
    const bytes = Buffer.concat([
      Buffer.from("opaque-field-export:" + observationId),
      Buffer.from([0x00, 0xff, index]),
    ]);
    checkpoints.push({
      id: "checkpoint-" + (index + 1), observationId, observationRecordSha256: hash(bytes),
    });
    payloads.push({ observationId, relativePath: "evidence/survey-observations/" + observationId + ".record", bytes });
    await writeFile(path.join(directory, observationId + ".record"), bytes, { flag: "wx" });
  }
  return { root, checkpoints, payloads };
}

test("collects opaque original survey record bytes in deterministic observation-ID order", async (t) => {
  const { root, checkpoints, payloads } = await fixture(t);
  const result = await collectSingleImageSurveyObservationRecords({ workspaceRoot: root, checkpoints });
  assert.equal(result.count, 6);
  assert.equal(result.totalBytes, payloads.reduce((sum, item) => sum + item.bytes.length, 0));
  assert.deepEqual(result.files.map((item) => item.artifactType),
    Array(6).fill(SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE));
  assert.deepEqual(result.files.map((item) => item.bytes), payloads.map((item) => item.bytes));
  assert.deepEqual(result.inventory.map((item) => item.observationId),
    checkpoints.map((item) => item.observationId));
  assert.equal(result.inventorySha256, hash(Buffer.from(canonicalJson(result.inventory), "utf8")));
});

test("rejects missing records and bytes that differ from the checkpoint-declared digest", async (t) => {
  const missing = await fixture(t);
  await rm(path.join(missing.root, missing.payloads[0].relativePath));
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: missing.root, checkpoints: missing.checkpoints,
  }));

  const mismatch = await fixture(t);
  await writeFile(path.join(mismatch.root, mismatch.payloads[0].relativePath), Buffer.from("substituted"), { flag: "w" });
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: mismatch.root, checkpoints: mismatch.checkpoints,
  }), /SHA-256 does not match/);
});

test("rejects unsafe, duplicate and under-count checkpoint identities", async (t) => {
  const { root, checkpoints } = await fixture(t);
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: root, checkpoints: checkpoints.map((item, index) =>
      index === 0 ? { ...item, observationId: "../outside" } : item),
  }), /valid and unique/);
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: root, checkpoints: checkpoints.map((item, index) =>
      index === 1 ? { ...item, observationId: checkpoints[0].observationId } : item),
  }), /valid and unique/);
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: root, checkpoints: checkpoints.slice(0, 5),
  }), /6–100/);
});

test("rejects symlinked record paths and oversized individual record files", async (t) => {
  const linked = await fixture(t);
  const source = path.join(linked.root, linked.payloads[0].relativePath);
  const replacement = source + ".original";
  await writeFile(replacement, await readFile(source), { flag: "wx" });
  await rm(source);
  await symlink(replacement, source);
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: linked.root, checkpoints: linked.checkpoints,
  }), /symbolic links/);

  const large = await fixture(t);
  await writeFile(path.join(large.root, large.payloads[0].relativePath),
    Buffer.alloc(MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES + 1), { flag: "w" });
  await assert.rejects(() => collectSingleImageSurveyObservationRecords({
    workspaceRoot: large.root, checkpoints: large.checkpoints,
  }), /8 MiB/);
});

test("offline verifier rejects missing, orphaned, tampered and wrong-inventory records", async (t) => {
  const { root, checkpoints } = await fixture(t);
  const collected = await collectSingleImageSurveyObservationRecords({ workspaceRoot: root, checkpoints });
  const artifacts = collected.files.map((item) => ({
    artifactType: item.artifactType, relativePath: item.relativePath,
    bytes: item.bytes.length, sha256: hash(item.bytes),
  }));
  const actualFiles = collected.files.map((item) => ({
    relativePath: item.relativePath, bytes: item.bytes.length,
    content: item.bytes, isRegularFile: true,
  }));
  const expected = {
    checkpoints, packageArtifacts: artifacts, actualFiles,
    expectedCount: collected.count, expectedTotalBytes: collected.totalBytes,
    expectedInventorySha256: collected.inventorySha256,
  };
  assert.deepEqual(verifyPackagedSingleImageSurveyObservationRecords(expected), {
    count: 6, totalBytes: collected.totalBytes, inventorySha256: collected.inventorySha256,
  });
  assert.throws(() => verifyPackagedSingleImageSurveyObservationRecords({
    ...expected, actualFiles: actualFiles.slice(1),
  }), /missing/);
  assert.throws(() => verifyPackagedSingleImageSurveyObservationRecords({
    ...expected, actualFiles: actualFiles.map((file, index) => {
      if (index !== 0) return file;
      const content = Buffer.from(file.content); content[0] ^= 0xff;
      return { ...file, content };
    }),
  }), /SHA-256/);
  const orphan = Buffer.from("orphan");
  assert.throws(() => verifyPackagedSingleImageSurveyObservationRecords({
    ...expected,
    packageArtifacts: [...artifacts, {
      artifactType: SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE,
      relativePath: "evidence/survey-observations/orphan.record",
      bytes: orphan.length, sha256: hash(orphan),
    }],
  }), /count/);
  assert.throws(() => verifyPackagedSingleImageSurveyObservationRecords({
    ...expected, expectedInventorySha256: hash("forged"),
  }), /inventory metadata/);
});
