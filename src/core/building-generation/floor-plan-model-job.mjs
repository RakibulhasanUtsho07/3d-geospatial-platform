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
    mapReady: false,
    publicationEligible: false,
    report: generated.report,
  };
}
