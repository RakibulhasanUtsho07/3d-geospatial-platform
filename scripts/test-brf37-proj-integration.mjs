import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeBrf37PinnedProjOperation } from "../src/core/building-generation/brf37-proj-operation-executor.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function findProjDataDirectory() {
  const candidates = [
    process.env.PROJ_DATA_PATH,
    process.env.PROJ_DATA,
    process.env.PROJ_LIB,
    "/usr/share/proj",
    "/usr/local/share/proj",
    "/usr/local/lib/proj",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const info = await import("node:fs/promises").then((fs) => fs.stat(path.join(candidate, "proj.db")));
      if (info.isFile() && info.size > 0) return candidate;
    } catch {}
  }
  throw new Error("A local proj.db is required for the real cct integration test.");
}

function findCctVersion() {
  const result = spawnSync("cct", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("The cct executable is unavailable.");
  const output = String(result.stdout || "") + "\n" + String(result.stderr || "");
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\b/i);
  if (!match) throw new Error("The installed cct version could not be parsed.");
  return match[0];
}

async function pinned(relativePath, root) {
  const fullPath = path.join(root, relativePath);
  const bytes = await readFile(fullPath);
  return { path: relativePath, byteSize: bytes.length, sha256: sha256(bytes) };
}

const systemDataDirectory = await findProjDataDirectory();
const cctVersion = findCctVersion();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "brf37-real-proj-"));
try {
  const dataDirectory = path.join(temporaryRoot, "proj-data");
  await mkdir(dataDirectory, { recursive: true });
  await copyFile(path.join(systemDataDirectory, "proj.db"), path.join(dataDirectory, "proj.db"));
  const definition = "+proj=pipeline +step +proj=affine +xoff=0 +yoff=0\n";
  await writeFile(path.join(temporaryRoot, "identity-test.pipeline"), definition, "utf8");

  const definitionPin = await pinned("identity-test.pipeline", temporaryRoot);
  const databasePin = await pinned("proj-data/proj.db", temporaryRoot);
  const manifest = {
    schemaVersion: "1.0.0",
    evaluationId: "BRF37-CI-SYNTHETIC-CCT-INTEGRATION",
    operation: {
      id: "ci-synthetic-affine-identity",
      registryOperationId: "custom-pipeline-no-authority-id",
      reviewStatus: "approved-for-execution",
      reviewRecord: {
        id: "CI-ONLY-SYNTHETIC-OPERATION",
        reviewer: "CI synthetic fixture; not a production review",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      },
      sourceCrs: "EPSG:25832",
      targetCrs: "EPSG:25832",
      inputAxisOrder: ["easting", "northing"],
      outputAxisOrder: ["easting", "northing"],
      unit: "metre",
      areaOfUse: { west: -180, south: -90, east: 180, north: 90 },
      nominalAccuracyMeters: 0,
      horizontalOnly: true,
      verticalFrameStatus: "unresolved",
      projVersion: cctVersion,
      dataDirectory: "proj-data",
      projDatabase: {
        ...databasePin,
        version: "CI fixture: exact proj.db bytes pinned; internal metadata not interpreted",
      },
      definition: definitionPin,
      grids: [],
    },
    controlVectors: [
      { id: "ci-identity-vector", input: [389813, 5330000], areaCheckLonLat: [11.5, 48], expectedOutput: [389813, 5330000], toleranceMeters: 0.001 },
    ],
    releaseFlags: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
  const first = await executeBrf37PinnedProjOperation(manifest, { assetRoot: temporaryRoot });
  const second = await executeBrf37PinnedProjOperation(manifest, { assetRoot: temporaryRoot });
  assert.equal(first.status, "executed-within-tolerance", JSON.stringify(first.blockers));
  assert.equal(second.status, "executed-within-tolerance", JSON.stringify(second.blockers));
  assert.equal(first.reportSha256, second.reportSha256, "Repeated runs must produce a stable report hash.");
  assert.equal(first.provenance.observedProjVersion, cctVersion);
  assert.equal(first.provenance.networkAccess, "disabled");
  assert.equal(first.interpretation.accuracyPassed, false);
  assert.ok(Object.values(first.interpretation.releaseFlags).every((value) => value === false));
  process.stdout.write("BRF-37 real cct synthetic integration passed; production operation and accuracy remain unapproved.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
