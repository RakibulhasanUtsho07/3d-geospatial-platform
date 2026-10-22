import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { loadVerifiedSource } from "./source-workflow.mjs";
import { generateFloorPlanGlb } from "./floor-plan-model.mjs";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function assertApiGeometryBudget(floorPlan) {
  if (!Array.isArray(floorPlan.rooms) || floorPlan.rooms.length > 100) {
    throw new RangeError("API floor plans may contain at most 100 rooms.");
  }
  if (!Array.isArray(floorPlan.walls) || floorPlan.walls.length > 500) {
    throw new RangeError("API floor plans may contain at most 500 walls.");
  }
  let vertexCount = 0;
  for (const room of floorPlan.rooms) {
    if (!room || !Array.isArray(room.polygon) || room.polygon.length > 64) {
      throw new RangeError("Each API room polygon may contain at most 64 vertices.");
    }
    vertexCount += room.polygon.length;
  }
  if (vertexCount > 4000) throw new RangeError("API floor plans may contain at most 4000 room vertices in total.");
  let openingCount = 0;
  for (const wall of floorPlan.walls) {
    if (!wall || !Array.isArray(wall.openings)) {
      throw new TypeError("Every API wall must provide an openings array.");
    }
    openingCount += wall.openings.length;
  }
  if (openingCount > 1000) throw new RangeError("API floor plans may contain at most 1000 openings.");
}

async function ensurePrivateDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Refusing an unsafe floor-plan candidate directory.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Floor-plan candidate directory must be a real, private directory.");
      }
    }
    const actual = await realpath(current);
    if (!inside(root, actual)) {
      throw new TypeError("Floor-plan candidate directory resolves outside workspaceRoot.");
    }
    current = actual;
  }
  return current;
}

async function writeAtomically(filePath, bytes) {
  const temporaryPath = filePath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Create a private review candidate from a measured vector trace whose original
 * source was already ingested through the protected media-intake pipeline.
 * This does not publish the result or assert that its geometry is accurate.
 */
export async function createFloorPlanModelCandidate({ workspaceRoot, floorPlan }) {
  if (!floorPlan || typeof floorPlan !== "object" || Array.isArray(floorPlan)) {
    throw new TypeError("floorPlan must be a JSON object.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const buildingId = safeId(floorPlan.buildingId, "floorPlan.buildingId");
  const source = floorPlan.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("API floor-plan generation requires source.sourceId and source.sha256 from an uploaded source.");
  }
  const sourceId = safeId(source.sourceId, "source.sourceId");
  if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)) {
    throw new TypeError("source.sha256 must be a 64-character SHA-256 hash.");
  }

  assertApiGeometryBudget(floorPlan);
  const loadedSource = await loadVerifiedSource(root, buildingId, sourceId);
  if (loadedSource.record.kind !== "floor-plan") {
    const error = new Error("The referenced source must have been uploaded with kind=floor-plan.");
    error.code = "SOURCE_KIND_MISMATCH";
    throw error;
  }
  if (loadedSource.sha256 !== source.sha256.toLowerCase()) {
    const error = new Error("The supplied source SHA-256 does not match the verified uploaded source bytes.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }

  const generated = generateFloorPlanGlb(floorPlan);
  const normalizedPlanBytes = Buffer.from(JSON.stringify(generated.plan, null, 2) + "\n", "utf8");
  const geometrySha256 = sha256(normalizedPlanBytes);
  generated.report.input.sourceEvidenceVerified = true;
  generated.report.input.verifiedSourceSha256 = loadedSource.sha256;
  generated.report.input.sourceUsageStatus = loadedSource.record.usageStatus ?? "unreviewed";
  generated.report.input.sourceLicence = loadedSource.record.licence ?? "unknown";
  generated.report.input.normalizedGeometrySha256 = geometrySha256;
  generated.report.warnings = generated.report.warnings.filter(
    (warning) => !warning.startsWith("A source SHA-256 is metadata"),
  );
  generated.report.warnings.push(
    "The original uploaded source bytes were verified against the private media-intake record; this does not verify the vector trace, measurements, reuse rights, or geospatial accuracy.",
  );
  if (loadedSource.record.usageStatus !== "approved" ||
      !loadedSource.record.licence ||
      ["unknown", "n/a", "none"].includes(String(loadedSource.record.licence).trim().toLowerCase())) {
    generated.report.warnings.push(
      "Source reuse rights are not marked approved in media intake; resolve permission and attribution before sharing or publishing this candidate.",
    );
  }

  const candidateId = "floorplan-" + randomUUID();
  const buildingDirectory = await ensurePrivateDirectory(
    root,
    [".building-engine", "floor-plan-candidates", buildingId],
  );
  const candidateDirectory = path.join(buildingDirectory, candidateId);
  await mkdir(candidateDirectory, { recursive: false, mode: 0o700 });
  const directoryEntry = await lstat(candidateDirectory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new TypeError("Candidate output must be stored in a private regular directory.");
  }
  const realCandidateDirectory = await realpath(candidateDirectory);
  if (!inside(buildingDirectory, realCandidateDirectory)) {
    throw new TypeError("Candidate output directory resolves outside its private building directory.");
  }

  const reportBytes = Buffer.from(JSON.stringify(generated.report, null, 2) + "\n", "utf8");
  try {
    await writeAtomically(path.join(realCandidateDirectory, "floor-plan.json"), normalizedPlanBytes);
    await writeAtomically(path.join(realCandidateDirectory, "model.glb"), generated.glb);
    await writeAtomically(path.join(realCandidateDirectory, "report.json"), reportBytes);
  } catch (error) {
    await rm(realCandidateDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    candidateId,
    buildingId,
    floorPlanId: generated.plan.id,
    sourceId,
    status: generated.report.status,
    modelSha256: generated.report.output.sha256,
    modelBytes: generated.report.output.byteSize,
    geometrySha256,
    sourceSha256: loadedSource.sha256,
    sourceUsageStatus: generated.report.input.sourceUsageStatus,
    candidateUrl: "/api/building-generation/floor-plan-models/" + buildingId + "/" + candidateId,
    modelUrl: "/api/building-generation/floor-plan-models/" + buildingId + "/" + candidateId + "/model",
    mapReady: false,
    publicationEligible: false,
    report: generated.report,
  };
}

async function resolveCandidateDirectory(root, buildingId, candidateId) {
  let current = root;
  for (const segment of [".building-engine", "floor-plan-candidates", buildingId, candidateId]) {
    const next = path.join(current, segment);
    const entry = await lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("Floor-plan candidate path must contain only regular directories.");
    }
    const actual = await realpath(next);
    if (!inside(root, actual)) throw new TypeError("Floor-plan candidate resolves outside workspaceRoot.");
    current = actual;
  }
  return current;
}

async function readCandidateFile(candidateDirectory, name, maximumBytes) {
  const filePath = path.join(candidateDirectory, name);
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError("Floor-plan candidate artifact must be a regular file.");
  }
  if (entry.size <= 0 || entry.size > maximumBytes) {
    throw new RangeError("Floor-plan candidate artifact size is invalid.");
  }
  const actual = await realpath(filePath);
  if (!inside(candidateDirectory, actual)) {
    throw new TypeError("Floor-plan candidate artifact resolves outside its candidate directory.");
  }
  return readFile(actual);
}

/** Load a private candidate and verify its GLB bytes against the saved report before serving it. */
export async function loadFloorPlanModelCandidate({ workspaceRoot, buildingId, candidateId }) {
  const root = await realpath(path.resolve(workspaceRoot));
  const bid = safeId(buildingId, "buildingId");
  const cid = safeId(candidateId, "candidateId");
  const directory = await resolveCandidateDirectory(root, bid, cid);
  const reportBytes = await readCandidateFile(directory, "report.json", 2 * 1024 * 1024);
  const report = JSON.parse(reportBytes.toString("utf8"));
  if (!report || typeof report !== "object" ||
      report.input?.buildingId !== bid ||
      report.input?.floorPlanId === undefined ||
      report.output?.format !== "glb" ||
      typeof report.output?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(report.output.sha256) ||
      typeof report.input?.verifiedSourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(report.input.verifiedSourceSha256) ||
      typeof report.input?.normalizedGeometrySha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(report.input.normalizedGeometrySha256)) {
    throw new TypeError("Floor-plan candidate report is invalid.");
  }
  const planBytes = await readCandidateFile(directory, "floor-plan.json", 2 * 1024 * 1024);
  const plan = JSON.parse(planBytes.toString("utf8"));
  if (!plan || typeof plan !== "object" || plan.id !== report.input.floorPlanId ||
      plan.buildingId !== bid || plan.evidence?.sha256 !== report.input.verifiedSourceSha256 ||
      sha256(planBytes) !== report.input.normalizedGeometrySha256) {
    throw new TypeError("Floor-plan candidate geometry checksum or identity does not match its report.");
  }
  const modelBytes = await readCandidateFile(directory, "model.glb", 200 * 1024 * 1024);
  const actualSha256 = sha256(modelBytes);
  if (actualSha256 !== report.output.sha256) {
    const error = new Error("Stored floor-plan candidate GLB checksum does not match its report.");
    error.code = "CANDIDATE_CHECKSUM_MISMATCH";
    throw error;
  }
  return {
    candidateId: cid,
    buildingId: bid,
    plan,
    report,
    reportSha256: sha256(reportBytes),
    geometrySha256: report.input.normalizedGeometrySha256,
    modelBytes,
    modelSha256: actualSha256,
    mapReady: false,
    publicationEligible: false,
  };
}
