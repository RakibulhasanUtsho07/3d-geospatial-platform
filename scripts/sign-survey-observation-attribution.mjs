#!/usr/bin/env node
import { constants } from "node:fs";\nimport { createHash } from "node:crypto";
import { lstat, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSurveyObservationAttributionAttestation,
  surveyObservationAttributionAttestationPath,
  verifySurveyObservationAttributionAttestation,
  MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES,
} from "../src/core/building-generation/survey-observation-attribution-attestation.mjs";
import {
  readStableSingleImageSurveyObservationRecord,
  readStableSingleImageWorkspaceEvidenceFile,
} from "../src/core/building-generation/single-image-review-package-evidence.mjs";
import { verifySingleImageRuntimeSmoke } from "../src/core/building-generation/verify-single-image-runtime-smoke.mjs";

const REGISTRY_ENV = "SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON";
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_SMOKE_REPORT_BYTES = 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function parseArguments(args) {
  const positional = [];
  let surveyorId = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--surveyor-id") {
      if (surveyorId !== null || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--surveyor-id must be supplied exactly once with a value.");
      }
      surveyorId = args[++index];
    } else if (value.startsWith("--")) {
      throw new Error("Unknown survey-observation signing option: " + value);
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== 3 || !surveyorId || !SAFE_ID.test(surveyorId) || surveyorId !== surveyorId.toLowerCase()) {
    throw new Error("Usage: npm run sign:survey-observation-attribution -- <private-smoke-workspace> <job-id> <ed25519-private-key.pem> --surveyor-id <registered-surveyor-id>");
  }
  return {
    workspaceRoot: path.resolve(positional[0]),
    jobId: positional[1],
    privateKeyPath: path.resolve(positional[2]),
    surveyorId,
  };
}

function statIdentity(stat) {
  return [
    stat.dev.toString(),
    stat.ino.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
    stat.mode.toString(),
  ].join(":");
}

async function readPrivateKeyFile(filePath) {
  const before = await lstat(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() ||
      before.size < 1n || before.size > BigInt(MAX_PRIVATE_KEY_BYTES)) {
    throw new Error("Surveyor private key must be a non-empty regular file no larger than 16 KiB.");
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile() || statIdentity(descriptorBefore) !== statIdentity(before)) {
      throw new Error("Surveyor private-key file identity changed before reading.");
    }
    const bytes = await handle.readFile();
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    if (statIdentity(descriptorBefore) !== statIdentity(descriptorAfter) ||
        statIdentity(descriptorAfter) !== statIdentity(pathAfter) ||
        bytes.length !== Number(descriptorAfter.size) ||
        bytes.length < 1 || bytes.length > MAX_PRIVATE_KEY_BYTES) {
      bytes.fill(0);
      throw new Error("Surveyor private-key file changed while being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertAbsent(filePath) {
  try {
    await lstat(filePath);
    throw new Error("Survey observation attestation sidecar already exists; refusing to overwrite it.");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function removeOnlyCreatedSidecars(created) {
  for (const item of created.reverse()) {
    try {
      const current = await lstat(item.path, { bigint: true });
      if (current.isFile() && !current.isSymbolicLink() &&
          statIdentity(current) === item.identity) {
        await unlink(item.path);
      }
    } catch {
      // Never remove a replacement or an entry whose identity cannot be proven.
    }
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(label + " must contain valid JSON.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run sign:survey-observation-attribution -- <private-smoke-workspace> <job-id> <ed25519-private-key.pem> --surveyor-id <registered-surveyor-id>");
    console.log("Signs exact D3M-14 held-out observation bytes into deterministic detached sidecars. It never modifies source records or stores the private key.");
    console.log("Reads the separate public-key-only registry from SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON; registry JSON is never accepted on the command line or printed.");
    console.log("The signature attributes record bytes to a checkpoint context only; it is not survey certification, receiver authentication or release approval.");
    return;
  }

  const { workspaceRoot, jobId, privateKeyPath, surveyorId } = parseArguments(args);
  if (!SAFE_ID.test(jobId)) throw new Error("Single-image smoke job ID is invalid.");
  const rawRegistry = process.env[REGISTRY_ENV];
  if (typeof rawRegistry !== "string" || !rawRegistry.trim()) {
    throw new Error("trusted-surveyor-registry-secret-missing");
  }
  if (Buffer.byteLength(rawRegistry, "utf8") > MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES) {
    throw new Error("trusted-surveyor-registry-secret-exceeds-64-KiB");
  }

  const beforeSmoke = await verifySingleImageRuntimeSmoke({ workspaceRoot, jobId });
  const reportRelativePath = ".building-engine/runtime-smokes/" + jobId + ".json";
  const reportFile = await readStableSingleImageWorkspaceEvidenceFile({
    workspaceRoot,
    relativePath: reportRelativePath,
    label: "Single-image runtime smoke report",
    maxBytes: MAX_SMOKE_REPORT_BYTES,
  });
  const report = parseJson(reportFile.bytes, "Single-image runtime smoke report");
  const georeference = report.georeferenceEvidence;
  if (report.status !== "passed" || report.jobId !== jobId ||
      report.buildingId !== beforeSmoke.buildingId ||
      georeference?.schemaVersion !== "1.2.0" ||
      georeference?.status !== "calibrated-needs-human-review" ||
      georeference?.independentCheckpointEvidence?.status !== "validated-needs-human-review" ||
      report.mapReady !== false || report.publicationEligible !== false ||
      report.automaticApproval !== false) {
    throw new Error("Only a verified D3M-14 held-out checkpoint smoke with all release flags false may be surveyor-attested.");
  }

  const manifestRelativePath = georeference.manifest?.path;
  const manifestFile = await readStableSingleImageWorkspaceEvidenceFile({
    workspaceRoot,
    relativePath: manifestRelativePath,
    label: "Single-image held-out control-point manifest",
    maxBytes: 1024 * 1024,
  });
  if (manifestFile.bytes.length !== georeference.manifest.bytes ||
      createHash("sha256").update(manifestFile.bytes).digest("hex") !== georeference.manifest.sha256) {
    throw new Error("Control-point manifest bytes do not match the verified smoke report.");
  }
  const controlManifest = parseJson(manifestFile.bytes, "Single-image control-point manifest");
  const checkpoints = controlManifest.heldOutCheckpoints?.points;
  const expectedCount = georeference.independentCheckpointEvidence?.controls?.count;
  if (controlManifest.schemaVersion !== "1.2.0" ||
      controlManifest.buildingId !== report.buildingId ||
      !Array.isArray(checkpoints) || checkpoints.length < 6 || checkpoints.length > 100 ||
      checkpoints.length !== expectedCount) {
    throw new Error("Control-point manifest must bind the exact verified set of 6–100 held-out checkpoints.");
  }

  const privateKeyBytes = await readPrivateKeyFile(privateKeyPath);
  const privateKeyPem = privateKeyBytes.toString("utf8");
  const attestedAtUtc = new Date().toISOString();
  const candidates = [];
  const observationIds = new Set();
  const checkpointIds = new Set();

  try {
    for (const checkpoint of checkpoints) {
      if (!checkpoint || typeof checkpoint.id !== "string" ||
          typeof checkpoint.observationId !== "string" ||
          observationIds.has(checkpoint.observationId.toLowerCase()) ||
          checkpointIds.has(checkpoint.id.toLowerCase()) ||
          typeof checkpoint.observationRecordSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(checkpoint.observationRecordSha256)) {
        throw new Error("Held-out checkpoint IDs, observation IDs or declared record hashes are invalid or duplicated.");
      }
      observationIds.add(checkpoint.observationId.toLowerCase());
      checkpointIds.add(checkpoint.id.toLowerCase());

      const record = await readStableSingleImageSurveyObservationRecord({
        workspaceRoot,
        observationId: checkpoint.observationId,
      });
      if (record.sha256 !== checkpoint.observationRecordSha256) {
        throw new Error("Survey observation record bytes do not match checkpoint " + checkpoint.id + ".");
      }
      const relativePath = surveyObservationAttributionAttestationPath(checkpoint.observationId);
      const absolutePath = path.join(workspaceRoot, ...relativePath.split("/"));
      await assertAbsent(absolutePath);
      const attestation = createSurveyObservationAttributionAttestation({
        recordBytes: record.bytes,
        controlPointManifestBytes: manifestFile.bytes,
        observationId: checkpoint.observationId,
        checkpointId: checkpoint.id,
        buildingId: report.buildingId,
        surveyorId,
        privateKeyPem,
        trustedSurveyorRegistry: rawRegistry,
        attestedAtUtc,
      });
      candidates.push({
        relativePath,
        absolutePath,
        record,
        attestation,
        bytes: Buffer.from(JSON.stringify(attestation, null, 2) + "\n", "utf8"),
      });
    }
  } finally {
    privateKeyBytes.fill(0);
  }

  const created = [];
  try {
    for (const candidate of candidates) {
      await writeFile(candidate.absolutePath, candidate.bytes, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const stat = await lstat(candidate.absolutePath, { bigint: true });
      created.push({ path: candidate.absolutePath, identity: statIdentity(stat) });
    }

    const now = new Date();
    for (const candidate of candidates) {
      const persisted = await readStableSingleImageWorkspaceEvidenceFile({
        workspaceRoot,
        relativePath: candidate.relativePath,
        label: "Persisted survey observation attribution sidecar",
        maxBytes: 32 * 1024,
      });
      if (!persisted.bytes.equals(candidate.bytes)) {
        throw new Error("Survey observation attribution sidecar changed after writing.");
      }
      const result = verifySurveyObservationAttributionAttestation({
        attestation: parseJson(persisted.bytes, "Survey observation attribution sidecar"),
        recordBytes: candidate.record.bytes,
        controlPointManifestBytes: manifestFile.bytes,
        observationId: candidate.attestation.observationId,
        checkpointId: candidate.attestation.checkpointId,
        buildingId: report.buildingId,
        trustedSurveyorRegistry: rawRegistry,
        now,
      });
      if (!result.valid) throw new Error("New survey observation attribution sidecar failed self-verification.");
    }

    const afterSmoke = await verifySingleImageRuntimeSmoke({ workspaceRoot, jobId });
    const reportAfter = await readStableSingleImageWorkspaceEvidenceFile({
      workspaceRoot,
      relativePath: reportRelativePath,
      label: "Single-image runtime smoke report",
      maxBytes: MAX_SMOKE_REPORT_BYTES,
    });
    const manifestAfter = await readStableSingleImageWorkspaceEvidenceFile({
      workspaceRoot,
      relativePath: manifestRelativePath,
      label: "Single-image held-out control-point manifest",
      maxBytes: 1024 * 1024,
    });
    const changedRecords = [];
    for (const candidate of candidates) {
      const recordAfter = await readStableSingleImageSurveyObservationRecord({
        workspaceRoot,
        observationId: candidate.attestation.observationId,
      });
      if (recordAfter.sha256 !== candidate.record.sha256 ||
          !recordAfter.bytes.equals(candidate.record.bytes)) {
        changedRecords.push(candidate.attestation.observationId);
      }
    }
    if (afterSmoke.model?.sha256 !== beforeSmoke.model?.sha256 ||
        !reportAfter.bytes.equals(reportFile.bytes) ||
        !manifestAfter.bytes.equals(manifestFile.bytes) ||
        changedRecords.length > 0) {
      throw new Error("Smoke output, control-point manifest or survey observation bytes changed during attribution signing.");
    }
  } catch (error) {
    await removeOnlyCreatedSidecars(created);
    throw error;
  }

  console.log(JSON.stringify({
    status: "survey-observation-attribution-sidecars-created",
    jobId,
    buildingId: report.buildingId,
    surveyorId,
    registryId: candidates[0]?.attestation.registryId ?? null,
    attestationCount: candidates.length,
    attestations: candidates.map((candidate) => ({
      observationId: candidate.attestation.observationId,
      checkpointId: candidate.attestation.checkpointId,
      relativePath: candidate.relativePath,
      sha256: createHash("sha256").update(candidate.bytes).digest("hex"),
      bytes: candidate.bytes.length,
    })),
    publicationEligible: false,
    measurementAccuracyCertified: false,
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not sign survey observation attribution:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
