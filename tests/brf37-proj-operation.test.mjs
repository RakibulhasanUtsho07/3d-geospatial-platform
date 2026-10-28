import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeBrf37PinnedProjOperation } from "../src/core/building-generation/brf37-proj-operation-executor.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const definitionText = "+proj=pipeline +step +proj=affine +xoff=0 +yoff=0\n";
const databaseBytes = Buffer.from("synthetic proj.db fixture; not a real coordinate database\n");

async function writePinnedFile(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, value);
  const bytes = await readFile(absolute);
  return { path: relativePath, sha256: sha256(bytes), byteSize: bytes.length };
}

async function createApprovedFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf37-proj-"));
  const definition = options.definition ?? definitionText;
  const operationPin = await writePinnedFile(root, "operation.txt", definition);
  const databasePin = await writePinnedFile(root, "proj-data/proj.db", databaseBytes);
  const gridPins = [];
  for (const grid of options.grids ?? []) {
    gridPins.push(await writePinnedFile(root, "proj-data/" + grid.name, grid.bytes));
  }
  const controlVectors = (options.controlVectors ?? [
    { id: "control-1", input: [100, 200], expectedOutput: [100, 200], toleranceMeters: 0.001 },
    { id: "control-2", input: [389813, 5330000], expectedOutput: [389813, 5330000], toleranceMeters: 0.001 },
  ]).map((vector) => ({ areaCheckLonLat: [11.5, 48], ...vector }));
  const manifest = {
    schemaVersion: "1.0.0",
    evaluationId: "BRF37-UNIT-TEST",
    operation: {
      id: "synthetic-affine-identity",
      registryOperationId: "custom-pipeline-no-authority-id",
      reviewStatus: "approved-for-execution",
      reviewRecord: {
        id: "TEST-ONLY-REVIEW-RECORD",
        reviewer: "synthetic unit-test fixture",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      },
      sourceCrs: "EPSG:25832",
      targetCrs: "EPSG:25832",
      inputAxisOrder: ["easting", "northing"],
      outputAxisOrder: ["easting", "northing"],
      unit: "metre",
      areaOfUse: { west: 5, south: 45, east: 15, north: 55 },
      nominalAccuracyMeters: 0,
      horizontalOnly: true,
      verticalFrameStatus: "unresolved",
      projVersion: options.expectedVersion ?? "9.9.0",
      dataDirectory: "proj-data",
      projDatabase: {
        ...databasePin,
        version: "synthetic-fixture-version-label; exact bytes pinned",
      },
      definition: operationPin,
      grids: gridPins.map((pin, index) => ({
        id: "grid-" + index,
        ...pin,
      })),
    },
    controlVectors,
    releaseFlags: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
  return { root, manifest };
}

function fakeCct(options = {}) {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.args.includes("--version")) {
      return {
        exitCode: 0,
        stdout: "cct: Rel. " + (options.observedVersion ?? "9.9.0") + ", synthetic test build\n",
        stderr: "",
      };
    }
    const lines = request.input.trim().split(/\r?\n/).map((line) => {
      const parts = line.trim().split(/\s+/).map(Number);
      const pair = options.outputTransform
        ? options.outputTransform(parts[0], parts[1])
        : [parts[0], parts[1]];
      return String(pair[0]) + " " + String(pair[1]) + " 0 0";
    });
    return { exitCode: options.exitCode ?? 0, stdout: lines.join("\n") + "\n", stderr: options.stderr ?? "" };
  };
  return { calls, runner };
}

test("approved pinned operation produces deterministic provenance while release flags stay false", async () => {
  const fixture = await createApprovedFixture();
  try {
    const fake = fakeCct();
    const first = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    const second = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(first.status, "executed-within-tolerance");
    assert.equal(first.reportSha256, second.reportSha256);
    assert.equal(first.provenance.networkAccess, "disabled");
    assert.equal(first.provenance.commandShell, "not-used");
    assert.equal(first.interpretation.accuracyPassed, false);
    assert.deepEqual(first.interpretation.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
    assert.equal(fake.calls.filter((call) => call.args.includes("--version")).length, 2);
    const execution = fake.calls.find((call) => call.args.includes("-c"));
    assert.ok(execution.args.at(-1).startsWith("@"));
    assert.equal(execution.env.PROJ_NETWORK, "OFF");
    assert.equal(execution.env.PROJ_DATA, path.join(fixture.root, "proj-data"));
    assert.match(execution.input, /^100 200/m);
    assert.equal(first.controlVectors.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pending or unreviewed operation is rejected before executing cct", async () => {
  const fixture = await createApprovedFixture();
  try {
    fixture.manifest.operation.reviewStatus = "pending-review";
    fixture.manifest.operation.reviewRecord = null;
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("operation-review"));
    assert.equal(fake.calls.length, 0);
    assert.equal(report.interpretation.candidateSelected, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("changed operation bytes fail the SHA-256 pin before cct is called", async () => {
  const fixture = await createApprovedFixture();
  try {
    await writeFile(path.join(fixture.root, "operation.txt"),
      "+proj=pipeline +step +proj=affine +xoff=1 +yoff=0\n");
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("operation-definition-bytes"));
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a missing grid referenced by the operation definition fails closed", async () => {
  const fixture = await createApprovedFixture({
    definition: "+proj=pipeline +step +proj=hgridshift +grids=missing.gsb\n",
  });
  try {
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("grid-reference-coverage"));
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing grid bytes fail closed even when the grid is declared", async () => {
  const fixture = await createApprovedFixture({
    definition: "+proj=pipeline +step +proj=hgridshift +grids=absent.gsb\n",
    grids: [{ name: "expected.gsb", bytes: Buffer.from("grid fixture") }],
  });
  try {
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("grid-reference-coverage"));
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("PROJ version mismatch blocks the transform", async () => {
  const fixture = await createApprovedFixture({ expectedVersion: "9.9.0" });
  try {
    const fake = fakeCct({ observedVersion: "9.8.0" });
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("proj-version"));
    assert.equal(fake.calls.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("vertical-grid transformations are refused by the 2D horizontal executor", async () => {
  const fixture = await createApprovedFixture({
    definition: "+proj=pipeline +step +proj=vgridshift +grids=height.gtx\n",
    grids: [{ name: "height.gtx", bytes: Buffer.from("test grid") }],
  });
  try {
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("definition-horizontal-only"));
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("numeric control-vector regression failure blocks report", async () => {
  const fixture = await createApprovedFixture({
    controlVectors: [
      { id: "shifted-control", input: [100, 200], expectedOutput: [101, 200], toleranceMeters: 0.001 },
    ],
  });
  try {
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("control-vector-shifted-control"));
    assert.equal(report.interpretation.accuracyPassed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("wrong axis order and attempted release flag promotion fail closed", async () => {
  const fixture = await createApprovedFixture();
  try {
    fixture.manifest.operation.inputAxisOrder = ["northing", "easting"];
    fixture.manifest.releaseFlags.publicationEligible = true;
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("axis-order"));
    assert.ok(report.blockers.includes("release-flags-false"));
    assert.deepEqual(report.interpretation.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("path traversal in an operation pin is rejected", async () => {
  const fixture = await createApprovedFixture();
  try {
    fixture.manifest.operation.definition.path = "../outside.txt";
    const fake = fakeCct();
    const traversal = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(traversal.status, "blocked");
    assert.ok(traversal.blockers.includes("operation-definition-pin"));
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("out-of-area control vector fails before the coordinate operation runs", async () => {
  const fixture = await createApprovedFixture({
    controlVectors: [
      { id: "outside-area", input: [100, 200], areaCheckLonLat: [150, 48], expectedOutput: [100, 200], toleranceMeters: 0.001 },
    ],
  });
  try {
    const fake = fakeCct();
    const report = await executeBrf37PinnedProjOperation(fixture.manifest, {
      assetRoot: fixture.root,
      runCct: fake.runner,
    });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.includes("control-vectors-within-area-of-use"));
    assert.equal(fake.calls.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
