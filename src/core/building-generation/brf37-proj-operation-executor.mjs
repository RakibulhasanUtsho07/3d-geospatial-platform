import { constants, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i;
const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_GRID_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_PINNED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CONTROL_VECTORS = 128;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const RELEASE_FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});

class Brf37VerificationError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = "Brf37VerificationError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeRelativePath(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-z]:/i.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validPair(value) {
  return Array.isArray(value) && value.length === 2 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function validArea(area) {
  return isRecord(area) &&
    ["west", "south", "east", "north"].every((key) =>
      typeof area[key] === "number" && Number.isFinite(area[key])) &&
    area.west >= -180 && area.west <= 180 &&
    area.east >= -180 && area.east <= 180 &&
    area.south >= -90 && area.south <= 90 &&
    area.north >= -90 && area.north <= 90 &&
    area.west < area.east && area.south < area.north;
}

function pointWithinArea(point, area) {
  return validPair(point) && validArea(area) &&
    point[0] >= area.west && point[0] <= area.east &&
    point[1] >= area.south && point[1] <= area.north;
}

function safeErrorCode(error) {
  if (error instanceof Brf37VerificationError) return error.code;
  if (error && error.code === "ENOENT") return "file-missing";
  if (error && error.code === "EACCES") return "file-not-readable";
  if (error && error.code === "ELOOP") return "symlink-not-allowed";
  return "asset-verification-failed";
}

function addCheck(checks, blockers, id, passed, detail) {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) blockers.push(id);
}

function normalizeUnique(values) {
  return [...new Set(values)];
}

function finalizeReport(manifest, checks, blockers, details = {}) {
  const operation = isRecord(manifest) && isRecord(manifest.operation) ? manifest.operation : {};
  const flagsFalse = { ...RELEASE_FLAGS };
  const report = {
    schemaVersion: "1.0.0",
    evaluationId: isRecord(manifest) && safeId(manifest.evaluationId)
      ? manifest.evaluationId
      : "invalid-manifest",
    status: blockers.length === 0 ? "executed-within-tolerance" : "blocked",
    executionMode: "offline horizontal 2D only",
    coordinateOperationStatus: blockers.length === 0 ? "executed-pinned-operation" : "blocked",
    operation: {
      id: typeof operation.id === "string" ? operation.id : null,
      registryOperationId: typeof operation.registryOperationId === "string" ? operation.registryOperationId : null,
      reviewStatus: typeof operation.reviewStatus === "string" ? operation.reviewStatus : "missing",
      sourceCrs: typeof operation.sourceCrs === "string" ? operation.sourceCrs : null,
      targetCrs: typeof operation.targetCrs === "string" ? operation.targetCrs : null,
      inputAxisOrder: Array.isArray(operation.inputAxisOrder) ? operation.inputAxisOrder : null,
      outputAxisOrder: Array.isArray(operation.outputAxisOrder) ? operation.outputAxisOrder : null,
      unit: typeof operation.unit === "string" ? operation.unit : null,
      areaOfUse: isRecord(operation.areaOfUse) ? operation.areaOfUse : null,
      nominalAccuracyMeters: typeof operation.nominalAccuracyMeters === "number"
        ? operation.nominalAccuracyMeters
        : null,
      verticalFrameStatus: typeof operation.verticalFrameStatus === "string"
        ? operation.verticalFrameStatus
        : "unresolved",
      definition: {
        path: isRecord(operation.definition) && typeof operation.definition.path === "string"
          ? operation.definition.path
          : null,
        expectedSha256: isRecord(operation.definition) && typeof operation.definition.sha256 === "string"
          ? operation.definition.sha256
          : null,
        verifiedSha256: details.definitionSha256 || null,
        actualByteSize: Number.isSafeInteger(details.definitionByteSize) ? details.definitionByteSize : null,
      },
    },
    provenance: {
      engine: "PROJ cct",
      expectedProjVersion: typeof operation.projVersion === "string" ? operation.projVersion : null,
      observedProjVersion: details.observedProjVersion || null,
      projDataDirectory: typeof operation.dataDirectory === "string" ? operation.dataDirectory : null,
      projDatabase: {
        path: isRecord(operation.projDatabase) && typeof operation.projDatabase.path === "string"
          ? operation.projDatabase.path
          : null,
        declaredVersion: isRecord(operation.projDatabase) && typeof operation.projDatabase.version === "string"
          ? operation.projDatabase.version
          : null,
        expectedSha256: isRecord(operation.projDatabase) && typeof operation.projDatabase.sha256 === "string"
          ? operation.projDatabase.sha256
          : null,
        verifiedSha256: details.databaseSha256 || null,
        actualByteSize: Number.isSafeInteger(details.databaseByteSize) ? details.databaseByteSize : null,
      },
      grids: Array.isArray(details.grids) ? details.grids : [],
      networkAccess: "disabled",
      commandShell: "not-used",
      commandExitCode: details.commandExitCode ?? null,
      stderrSha256: details.stderrSha256 || null,
    },
    controlVectors: Array.isArray(details.controlVectors) ? details.controlVectors : [],
    checks,
    blockers: normalizeUnique(blockers),
    interpretation: {
      nominalAccuracyIsNotCertification: true,
      transformationAccuracy: "not-certified-by-operation-execution",
      physicalBuildingIdentity: "not-verified-by-operation-execution",
      sourceRights: "not-adjudicated-by-operation-execution",
      verticalDatum: typeof operation.verticalFrameStatus === "string"
        ? operation.verticalFrameStatus
        : "unresolved",
      candidateSelected: false,
      accuracyPassed: false,
      releaseFlags: flagsFalse,
    },
  };
  report.reportSha256 = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  return report;
}

async function resolveAssetRoot(assetRoot) {
  if (typeof assetRoot !== "string" || assetRoot.trim().length === 0) {
    throw new Brf37VerificationError("asset-root-invalid", "A local asset root is required.");
  }
  const supplied = path.resolve(assetRoot);
  let initial;
  try {
    initial = await lstat(supplied);
  } catch {
    throw new Brf37VerificationError("asset-root-missing", "The local asset root is unavailable.");
  }
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    throw new Brf37VerificationError("asset-root-invalid", "The asset root must be a real local directory.");
  }
  return realpath(supplied);
}

async function resolveNoSymlink(root, relativePath, expectedKind) {
  if (!safeRelativePath(relativePath)) {
    throw new Brf37VerificationError("path-invalid", "Asset paths must be safe, relative and traversal-free.");
  }
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let entry;
    try {
      entry = await lstat(current);
    } catch {
      throw new Brf37VerificationError("file-missing", "A pinned local asset is unavailable.");
    }
    if (entry.isSymbolicLink()) {
      throw new Brf37VerificationError("symlink-not-allowed", "Symbolic links are not accepted in pinned operation assets.");
    }
    const final = index === parts.length - 1;
    if (!final && !entry.isDirectory()) {
      throw new Brf37VerificationError("path-component-invalid", "Every asset parent path component must be a directory.");
    }
    if (final && expectedKind === "file" && !entry.isFile()) {
      throw new Brf37VerificationError("file-not-regular", "A pinned asset must be a regular file.");
    }
    if (final && expectedKind === "directory" && !entry.isDirectory()) {
      throw new Brf37VerificationError("directory-invalid", "The PROJ data path must be a directory.");
    }
  }
  const relative = path.relative(root, current);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Brf37VerificationError("path-escape", "A pinned asset escaped the local asset root.");
  }
  return current;
}

async function hashFile(filePath, maxBytes) {
  const digest = createHash("sha256");
  let byteSize = 0;
  await new Promise((resolve, reject) => {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const stream = createReadStream(filePath, { flags: constants.O_RDONLY | noFollow });
    stream.on("data", (chunk) => {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        stream.destroy(new Brf37VerificationError("file-too-large", "A pinned file exceeded its allowed byte limit."));
        return;
      }
      digest.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { byteSize, sha256: digest.digest("hex") };
}

async function verifyPinnedFile(root, record, maxBytes) {
  if (!isRecord(record) ||
      !safeRelativePath(record.path) ||
      typeof record.sha256 !== "string" ||
      !SHA256.test(record.sha256) ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 1 ||
      record.byteSize > maxBytes) {
    throw new Brf37VerificationError("pin-metadata-invalid", "A file pin requires a safe path, SHA-256 and bounded byte size.");
  }
  const filePath = await resolveNoSymlink(root, record.path, "file");
  const before = await lstat(filePath);
  if (before.size > maxBytes) {
    throw new Brf37VerificationError("file-too-large", "A pinned file exceeded its allowed byte limit.");
  }
  if (before.size !== record.byteSize) {
    throw new Brf37VerificationError("byte-size-mismatch", "The local file byte size does not match its pinned value.");
  }
  const actual = await hashFile(filePath, maxBytes);
  const after = await lstat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      actual.byteSize !== after.size) {
    throw new Brf37VerificationError("file-changed-during-hash", "The source file changed while its bytes were being verified.");
  }
  if (actual.byteSize !== record.byteSize) {
    throw new Brf37VerificationError("byte-size-mismatch", "The local file byte size does not match its pinned value.");
  }
  if (actual.sha256.toLowerCase() !== record.sha256.toLowerCase()) {
    throw new Brf37VerificationError("sha256-mismatch", "The local file SHA-256 does not match its pinned value.");
  }
  return { path: record.path, absolutePath: filePath, byteSize: actual.byteSize, sha256: actual.sha256 };
}

function validateOperationMetadata(manifest, checks, blockers) {
  const op = manifest.operation;
  const validId = safeId(op.id);
  addCheck(checks, blockers, "operation-id", validId,
    validId ? "The operation has a stable identifier." : "A safe stable operation ID is required.");

  const validRegistryId = typeof op.registryOperationId === "string" &&
    op.registryOperationId.trim().length > 0 && op.registryOperationId.length <= 128;
  addCheck(checks, blockers, "registry-operation-id", validRegistryId,
    validRegistryId ? "The registry operation ID or explicit custom-pipeline marker is recorded."
      : "Record a registry operation ID or an explicit custom-pipeline marker.");

  const review = op.reviewRecord;
  const reviewOk = op.reviewStatus === "approved-for-execution" &&
    isRecord(review) &&
    typeof review.id === "string" && review.id.trim().length > 0 &&
    typeof review.reviewer === "string" && review.reviewer.trim().length > 0 &&
    typeof review.reviewedAt === "string" && Number.isFinite(Date.parse(review.reviewedAt));
  addCheck(checks, blockers, "operation-review", reviewOk,
    reviewOk ? "Explicit operation-review metadata is present; it is recorded, not cryptographically attested."
      : "The operation has not been explicitly reviewed for execution.");

  const frameOk = typeof op.sourceCrs === "string" && /^EPSG:\d+$/i.test(op.sourceCrs) &&
    typeof op.targetCrs === "string" && /^EPSG:\d+$/i.test(op.targetCrs);
  addCheck(checks, blockers, "source-target-crs", frameOk,
    frameOk ? "Source and target CRS identifiers are explicit." : "Explicit EPSG source and target CRS identifiers are required.");

  const axisOk = JSON.stringify(op.inputAxisOrder) === JSON.stringify(["easting", "northing"]) &&
    JSON.stringify(op.outputAxisOrder) === JSON.stringify(["easting", "northing"]);
  addCheck(checks, blockers, "axis-order", axisOk,
    axisOk ? "Input and output use explicit easting/northing order." : "This horizontal executor requires explicit easting/northing order on both sides.");

  const unitsOk = op.unit === "metre";
  addCheck(checks, blockers, "coordinate-units", unitsOk,
    unitsOk ? "Horizontal coordinates are declared in metres." : "Horizontal input and output units must be declared as metres.");

  const areaOk = validArea(op.areaOfUse);
  addCheck(checks, blockers, "area-of-use", areaOk,
    areaOk ? "A valid geographic area-of-use bounding box is recorded."
      : "The operation's geographic area of use must be explicitly bounded.");

  const accuracyOk = typeof op.nominalAccuracyMeters === "number" &&
    Number.isFinite(op.nominalAccuracyMeters) && op.nominalAccuracyMeters >= 0;
  addCheck(checks, blockers, "nominal-accuracy", accuracyOk,
    accuracyOk ? "The registry-declared nominal accuracy is recorded as metadata only."
      : "Record nominal accuracy as a non-negative number; it is not an accuracy pass.");

  const horizontalOk = op.horizontalOnly === true &&
    typeof op.verticalFrameStatus === "string" &&
    op.verticalFrameStatus.trim().length > 0;
  addCheck(checks, blockers, "horizontal-only-policy", horizontalOk,
    horizontalOk ? "Execution is explicitly horizontal-only; Z is not passed to cct."
      : "Only a horizontal-only operation is permitted; vertical semantics must remain separate.");

  const versionOk = typeof op.projVersion === "string" && SEMVER.test(op.projVersion);
  addCheck(checks, blockers, "proj-version-pin", versionOk,
    versionOk ? "An exact PROJ version is pinned." : "An exact PROJ semantic version is required.");

  const database = op.projDatabase;
  const databaseOk = isRecord(database) &&
    safeRelativePath(database.path) &&
    typeof database.version === "string" && database.version.trim().length > 0 &&
    typeof database.sha256 === "string" && SHA256.test(database.sha256) &&
    Number.isSafeInteger(database.byteSize) && database.byteSize > 0 &&
    database.byteSize <= MAX_DATABASE_BYTES;
  addCheck(checks, blockers, "proj-database-pin", databaseOk,
    databaseOk ? "The PROJ database has a version label and exact local byte pin."
      : "The PROJ database needs a relative path, declared version, SHA-256 and bounded byte size.");

  const definition = op.definition;
  const definitionOk = isRecord(definition) &&
    safeRelativePath(definition.path) &&
    typeof definition.sha256 === "string" && SHA256.test(definition.sha256) &&
    Number.isSafeInteger(definition.byteSize) && definition.byteSize > 0 &&
    definition.byteSize <= MAX_DEFINITION_BYTES;
  addCheck(checks, blockers, "operation-definition-pin", definitionOk,
    definitionOk ? "The full operation definition has a bounded path, size and SHA-256 pin."
      : "The operation definition must be a local hash-pinned file no larger than 1 MiB.");

  const dataDirOk = safeRelativePath(op.dataDirectory);
  addCheck(checks, blockers, "proj-data-directory", dataDirOk,
    dataDirOk ? "The PROJ data directory is explicitly asset-root-relative."
      : "A safe local PROJ data directory is required.");

  const grids = op.grids;
  let gridsOk = Array.isArray(grids) && grids.length <= 64;
  const ids = new Set();
  const paths = new Set();
  if (gridsOk) {
    for (const grid of grids) {
      const valid = isRecord(grid) && safeId(grid.id) && safeRelativePath(grid.path) &&
        typeof grid.sha256 === "string" && SHA256.test(grid.sha256) &&
        Number.isSafeInteger(grid.byteSize) && grid.byteSize > 0 && grid.byteSize <= MAX_GRID_BYTES;
      if (!valid || ids.has(grid.id) || paths.has(grid.path)) {
        gridsOk = false;
        break;
      }
      ids.add(grid.id);
      paths.add(grid.path);
    }
  }
  addCheck(checks, blockers, "grid-manifest", gridsOk,
    gridsOk ? "Required grid assets have unique IDs/paths and bounded byte pins."
      : "Grid entries must be unique local files with bounded size and SHA-256 pins.");

  const vectors = manifest.controlVectors;
  let vectorsOk = Array.isArray(vectors) && vectors.length > 0 && vectors.length <= MAX_CONTROL_VECTORS;
  const vectorIds = new Set();
  if (vectorsOk) {
    for (const vector of vectors) {
      const valid = isRecord(vector) && safeId(vector.id) &&
        validPair(vector.input) && validPair(vector.expectedOutput) &&
        validPair(vector.areaCheckLonLat) &&
        typeof vector.toleranceMeters === "number" &&
        Number.isFinite(vector.toleranceMeters) && vector.toleranceMeters > 0 &&
        vector.toleranceMeters <= 1000;
      if (!valid || vectorIds.has(vector.id)) {
        vectorsOk = false;
        break;
      }
      vectorIds.add(vector.id);
    }
  }
  addCheck(checks, blockers, "control-vector-contract", vectorsOk,
    vectorsOk ? "Finite 2D input/expected pairs, geographic area-check points and tolerances are present."
      : "Provide 1–128 unique finite 2D control vectors with geographic area-check points and positive tolerances in metres.");
  const vectorsWithinArea = vectorsOk && vectors.every((vector) => pointWithinArea(vector.areaCheckLonLat, op.areaOfUse));
  addCheck(checks, blockers, "control-vectors-within-area-of-use", vectorsWithinArea,
    vectorsWithinArea ? "Every reviewer-supplied geographic area-check point falls within the pinned operation area."
      : "At least one control vector lacks an in-area geographic check point or falls outside the pinned operation area.");

  const releaseFlagsOk = isRecord(manifest.releaseFlags) &&
    Object.keys(RELEASE_FLAGS).every((key) => manifest.releaseFlags[key] === false);
  addCheck(checks, blockers, "release-flags-false", releaseFlagsOk,
    releaseFlagsOk ? "All release flags are explicitly false." : "All release flags must be explicitly false.");
  return { valid: blockers.length === 0, operation: op };
}

function operationGridReferences(text) {
  const references = [];
  const expression = /\+grids=([^\s]+)/g;
  let match;
  while ((match = expression.exec(text)) !== null) {
    for (const raw of match[1].split(",")) {
      let value = raw.trim();
      if (value.startsWith("@")) value = value.slice(1);
      if (value && value.toLowerCase() !== "null") references.push(value);
    }
  }
  return normalizeUnique(references);
}

function extractVersion(text) {
  const match = String(text || "").match(/\b\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\b/i);
  return match ? match[0] : null;
}

function parseCoordinateRows(stdout, expectedCount) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== expectedCount) {
    throw new Brf37VerificationError("output-row-count", "The coordinate output row count does not match the pinned control-vector count.");
  }
  return lines.map((line) => {
    const columns = line.split(/\s+/);
    if (columns.length < 2) {
      throw new Brf37VerificationError("output-parse-failed", "PROJ output did not contain two horizontal coordinate columns.");
    }
    const pair = [Number(columns[0]), Number(columns[1])];
    if (!pair.every(Number.isFinite)) {
      throw new Brf37VerificationError("output-non-finite", "PROJ returned a non-finite or unparseable horizontal coordinate.");
    }
    return pair;
  });
}

export function runCctProcess({ executable = "cct", args = [], input = "", env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new Brf37VerificationError("cct-launch-failed", "PROJ cct could not be started."));
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, new Brf37VerificationError("cct-timeout", "PROJ cct exceeded the bounded execution timeout."));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputExceeded = true;
        try { child.kill("SIGKILL"); } catch {}
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputExceeded = true;
        try { child.kill("SIGKILL"); } catch {}
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      finish(reject, new Brf37VerificationError("cct-launch-failed", "PROJ cct could not be started."));
    });
    child.on("close", (code) => {
      if (outputExceeded) {
        finish(reject, new Brf37VerificationError("cct-output-too-large", "PROJ cct produced more output than allowed."));
        return;
      }
      finish(resolve, { exitCode: code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Execute only a hash-pinned, explicitly reviewed horizontal operation.
 * All paths are local; this function never downloads data or turns a
 * candidate operation into an approval. Height/Z is never passed to cct.
 */
export async function executeBrf37PinnedProjOperation(manifest, options = {}) {
  const checks = [];
  const blockers = [];
  const details = { grids: [], controlVectors: [] };
  const manifestOk = isRecord(manifest) &&
    manifest.schemaVersion === "1.0.0" &&
    safeId(manifest.evaluationId) &&
    isRecord(manifest.operation) &&
    Array.isArray(manifest.controlVectors);
  addCheck(checks, blockers, "manifest-contract", manifestOk,
    manifestOk ? "The manifest has the expected schema and top-level contract."
      : "Manifest schema, evaluation ID, operation and control-vector collection are invalid.");
  if (!manifestOk) return finalizeReport(manifest, checks, blockers, details);

  const metadata = validateOperationMetadata(manifest, checks, blockers);
  if (!metadata.valid) {
    return finalizeReport(manifest, checks, blockers, details);
  }

  let root;
  try {
    root = await resolveAssetRoot(options.assetRoot);
    addCheck(checks, blockers, "asset-root", true, "A real local asset root is available.");
  } catch (error) {
    addCheck(checks, blockers, "asset-root", false, safeErrorCode(error));
    return finalizeReport(manifest, checks, blockers, details);
  }

  let dataDirectory;
  try {
    dataDirectory = await resolveNoSymlink(root, metadata.operation.dataDirectory, "directory");
    addCheck(checks, blockers, "proj-data-directory-resolved", true, "The pinned PROJ data directory resolves inside the asset root.");
  } catch (error) {
    addCheck(checks, blockers, "proj-data-directory-resolved", false, safeErrorCode(error));
    return finalizeReport(manifest, checks, blockers, details);
  }

  const paths = [
    metadata.operation.definition.path,
    metadata.operation.projDatabase.path,
    ...metadata.operation.grids.map((grid) => grid.path),
  ];
  const uniquePaths = new Set(paths);
  addCheck(checks, blockers, "pinned-paths-unique", uniquePaths.size === paths.length,
    uniquePaths.size === paths.length ? "Definition, database and grid paths are distinct."
      : "Definition, database and grid pins must not alias the same path.");
  const declaredTotalBytes = metadata.operation.definition.byteSize +
    metadata.operation.projDatabase.byteSize +
    metadata.operation.grids.reduce((sum, grid) => sum + grid.byteSize, 0);
  addCheck(checks, blockers, "aggregate-declared-byte-limit", declaredTotalBytes <= MAX_TOTAL_PINNED_BYTES,
    declaredTotalBytes <= MAX_TOTAL_PINNED_BYTES ? "Declared pinned input sizes fit within the aggregate byte ceiling."
      : "Declared operation, database and grid byte sizes exceed the aggregate limit.");
  if (blockers.length > 0) return finalizeReport(manifest, checks, blockers, details);

  let definitionFile = null;
  try {
    definitionFile = await verifyPinnedFile(root, metadata.operation.definition, MAX_DEFINITION_BYTES);
    details.definitionSha256 = definitionFile.sha256;
    details.definitionByteSize = definitionFile.byteSize;
    addCheck(checks, blockers, "operation-definition-bytes", true, "The exact operation definition size and SHA-256 match the local bytes.");
  } catch (error) {
    addCheck(checks, blockers, "operation-definition-bytes", false, safeErrorCode(error));
  }

  let databaseFile = null;
  try {
    databaseFile = await verifyPinnedFile(root, metadata.operation.projDatabase, MAX_DATABASE_BYTES);
    details.databaseSha256 = databaseFile.sha256;
    details.databaseByteSize = databaseFile.byteSize;
    addCheck(checks, blockers, "proj-database-bytes", true, "The exact proj.db byte size and SHA-256 match the local bytes.");
  } catch (error) {
    addCheck(checks, blockers, "proj-database-bytes", false, safeErrorCode(error));
  }

  if (databaseFile && path.dirname(databaseFile.absolutePath) !== dataDirectory) {
    addCheck(checks, blockers, "proj-database-location", false, "The pinned proj.db must be directly inside the selected PROJ data directory.");
  } else if (databaseFile) {
    addCheck(checks, blockers, "proj-database-location", true, "The hash-pinned proj.db is in the isolated PROJ data directory.");
  }

  let totalBytes = (definitionFile?.byteSize || 0) + (databaseFile?.byteSize || 0);
  let gridBytesFailed = false;
  const gridFiles = [];
  for (const grid of metadata.operation.grids) {
    try {
      const verified = await verifyPinnedFile(root, grid, MAX_GRID_BYTES);
      const relativeToData = path.relative(dataDirectory, verified.absolutePath);
      if (relativeToData === ".." || relativeToData.startsWith(".." + path.sep) || path.isAbsolute(relativeToData)) {
        throw new Brf37VerificationError("grid-outside-proj-data", "A required grid must be inside the isolated PROJ data directory.");
      }
      totalBytes += verified.byteSize;
      const record = { id: grid.id, path: grid.path, expectedSha256: grid.sha256, verifiedSha256: verified.sha256, byteSize: verified.byteSize };
      gridFiles.push({ ...record, absolutePath: verified.absolutePath });
      details.grids.push(record);
    } catch (error) {
      gridBytesFailed = true;
      blockers.push("grid-" + grid.id + "-bytes");
      checks.push({ id: "grid-" + grid.id + "-bytes", status: "blocked", detail: safeErrorCode(error) });
    }
  }
  if (!gridBytesFailed) {
    addCheck(checks, blockers, "required-grid-bytes", true, "Every listed grid is present locally and matches its exact byte pin.");
  }
  addCheck(checks, blockers, "aggregate-byte-limit", totalBytes <= MAX_TOTAL_PINNED_BYTES,
    totalBytes <= MAX_TOTAL_PINNED_BYTES ? "All pinned inputs stay within the aggregate byte ceiling."
      : "The aggregate size of pinned operation inputs exceeds the configured ceiling.");
  if (blockers.length > 0) return finalizeReport(manifest, checks, blockers, details);

  let definitionText;
  try {
    definitionText = await readFile(definitionFile.absolutePath, "utf8");
    if (!definitionText.trim() || definitionText.includes("\u0000") || definitionText.includes("\uFFFD")) {
      throw new Brf37VerificationError("operation-definition-text-invalid", "The operation definition must be non-empty UTF-8 text.");
    }
    addCheck(checks, blockers, "operation-definition-text", true, "The pinned operation definition is non-empty UTF-8 text.");
  } catch (error) {
    addCheck(checks, blockers, "operation-definition-text", false, safeErrorCode(error));
    return finalizeReport(manifest, checks, blockers, details);
  }

  const verticalPattern = /\+proj=(?:vgridshift|vertcon)\b|\+geoidgrids=/i;
  const horizontalDefinition = !verticalPattern.test(definitionText);
  addCheck(checks, blockers, "definition-horizontal-only", horizontalDefinition,
    horizontalDefinition ? "No explicit vertical grid-shift operation was found in the pinned definition."
      : "The definition appears to include vertical transformation semantics and is refused by the horizontal-only executor.");

  const requiredGridReferences = operationGridReferences(definitionText);
  const verifiedGridPaths = new Set(gridFiles.map((grid) =>
    path.relative(dataDirectory, grid.absolutePath).split(path.sep).join("/")));
  const allReferencesPinned = requiredGridReferences.every((reference) => verifiedGridPaths.has(reference));
  addCheck(checks, blockers, "grid-reference-coverage", allReferencesPinned,
    allReferencesPinned ? "Every grid referenced by the operation definition has a matching local hash-pinned file."
      : "The definition references a grid that is not listed and verified in the manifest.");
  if (blockers.length > 0) return finalizeReport(manifest, checks, blockers, details);

  const env = {
    ...process.env,
    PROJ_DATA: dataDirectory,
    PROJ_LIB: dataDirectory,
    PROJ_NETWORK: "OFF",
  };
  const executable = typeof options.cctExecutable === "string" && options.cctExecutable.trim()
    ? options.cctExecutable
    : "cct";
  const runCct = typeof options.runCct === "function" ? options.runCct : runCctProcess;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 60000)
    : DEFAULT_TIMEOUT_MS;

  let versionResult;
  try {
    versionResult = await runCct({ executable, args: ["--version"], input: "", env, timeoutMs });
  } catch (error) {
    addCheck(checks, blockers, "proj-version", false, safeErrorCode(error));
    return finalizeReport(manifest, checks, blockers, details);
  }
  const versionText = String(versionResult.stdout || "") + "\n" + String(versionResult.stderr || "");
  const observedVersion = extractVersion(versionText);
  details.observedProjVersion = observedVersion;
  const versionMatches = versionResult.exitCode === 0 && observedVersion === metadata.operation.projVersion;
  addCheck(checks, blockers, "proj-version", versionMatches,
    versionMatches ? "The cct version exactly matches the pinned PROJ version."
      : "The installed cct version is unavailable or differs from the required PROJ version.");
  if (!versionMatches) return finalizeReport(manifest, checks, blockers, details);

  const inputText = manifest.controlVectors.map((vector) => vector.input.join(" ")).join("\n") + "\n";
  let execution;
  try {
    execution = await runCct({
      executable,
      args: ["-c", "1,2", "-d", "15", "@" + definitionFile.absolutePath],
      input: inputText,
      env,
      timeoutMs,
    });
  } catch (error) {
    addCheck(checks, blockers, "cct-execution", false, safeErrorCode(error));
    return finalizeReport(manifest, checks, blockers, details);
  }

  details.commandExitCode = execution.exitCode;
  details.stderrSha256 = createHash("sha256").update(String(execution.stderr || "")).digest("hex");
  const exitOk = execution.exitCode === 0;
  addCheck(checks, blockers, "cct-execution", exitOk,
    exitOk ? "The pinned definition was executed by cct without a shell and with PROJ network access disabled."
      : "cct returned a non-zero exit code.");
  if (!exitOk) return finalizeReport(manifest, checks, blockers, details);

  let outputPairs;
  try {
    outputPairs = parseCoordinateRows(execution.stdout, manifest.controlVectors.length);
    addCheck(checks, blockers, "cct-output-parse", true, "Every input produced exactly one finite horizontal coordinate pair.");
  } catch (error) {
    addCheck(checks, blockers, "cct-output-parse", false, safeErrorCode(error));
    return finalizeReport(manifest, checks, blockers, details);
  }

  const vectorResults = [];
  for (let index = 0; index < manifest.controlVectors.length; index += 1) {
    const vector = manifest.controlVectors[index];
    const output = outputPairs[index];
    const dx = output[0] - vector.expectedOutput[0];
    const dy = output[1] - vector.expectedOutput[1];
    const errorMeters = Math.hypot(dx, dy);
    const withinTolerance = errorMeters <= vector.toleranceMeters;
    vectorResults.push({
      id: vector.id,
      input: vector.input,
      areaCheckLonLat: vector.areaCheckLonLat,
      areaCheckStatus: "reviewer-supplied-lonlat-point-within-declared-area",
      expectedOutput: vector.expectedOutput,
      actualOutput: output,
      observedDifferenceMeters: errorMeters,
      toleranceMeters: vector.toleranceMeters,
      status: withinTolerance ? "passed" : "blocked",
    });
    addCheck(checks, blockers, "control-vector-" + vector.id, withinTolerance,
      withinTolerance ? "The coordinate result is within the declared numerical regression tolerance."
        : "The coordinate result exceeds the declared numerical regression tolerance.");
  }
  details.controlVectors = vectorResults;
  addCheck(checks, blockers, "accuracy-not-certified", true,
    "Control-vector repeatability is not a real-building accuracy certification.");
  return finalizeReport(manifest, checks, blockers, details);
}
