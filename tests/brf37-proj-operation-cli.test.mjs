import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/run-brf37-proj-operation.mjs", import.meta.url));

test("CLI help documents local offline execution and blocked exit code", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hash-pinned/);
  assert.match(result.stdout, /Exit code: 0/);
});

test("real benchmark manifest remains blocked while operation review and byte pins are pending", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brf37-cli-"));
  try {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = {
      schemaVersion: "1.0.0",
      evaluationId: "BRF37-PENDING-CLI",
      operation: {
        id: "tum-25832-to-32632",
        registryOperationId: null,
        reviewStatus: "pending-review",
        reviewRecord: null,
        sourceCrs: "EPSG:25832",
        targetCrs: "EPSG:32632",
        inputAxisOrder: ["easting", "northing"],
        outputAxisOrder: ["easting", "northing"],
        unit: "metre",
        areaOfUse: null,
        nominalAccuracyMeters: null,
        horizontalOnly: true,
        verticalFrameStatus: "unresolved",
        projVersion: null,
        dataDirectory: null,
        projDatabase: null,
        definition: null,
        grids: [],
      },
      controlVectors: [],
      releaseFlags: {
        acceptanceEligible: false,
        publicationEligible: false,
        mapReady: false,
        automaticApproval: false,
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const reportPath = path.join(directory, "report.json");
    const result = spawnSync(process.execPath, [
      script, manifestPath, "--asset-root", directory, "--report", reportPath,
    ], { encoding: "utf8" });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("operation-review"));
    assert.equal(report.operation.sourceCrs, "EPSG:25832");
    assert.equal(report.operation.targetCrs, "EPSG:32632");
    assert.equal(report.interpretation.verticalDatum, "unresolved");
    assert.ok(Object.values(report.interpretation.releaseFlags).every((value) => value === false));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
