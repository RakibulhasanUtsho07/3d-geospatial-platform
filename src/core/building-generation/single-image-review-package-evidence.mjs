import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./generation-artifact-receipt.mjs";
import { verifySingleImageRuntimeSmoke } from "./verify-single-image-runtime-smoke.mjs";
import {
  buildSingleImageSurveyObservationRecordInventory,
  MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
  MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS_BYTES,
  singleImageSurveyObservationRecordPath,
} from "./single-image-survey-observation-records.mjs";
import {
  buildSurveyObservationAttributionInventory,
  surveyObservationAttributionAttestationPath,
  verifySurveyObservationAttributionAttestation,
  MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES,
} from "./survey-observation-attribution-attestation.mjs";
import {
  buildSurveyObservationDeviceAttestationInventory,
  surveyObservationDeviceAttestationPath,
  verifySurveyObservationDeviceAttestation,
  MAX_TRUSTED_SURVEY_DEVICE_REGISTRY_BYTES,
} from "./survey-observation-device-attestation.mjs";
import {
  surveyDeviceEnrollmentEvidencePath,
  verifySurveyDeviceEnrollmentEvidence,
  MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES,
  MAX_TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_BYTES,
} from "./survey-device-enrollment-evidence.mjs";
import { buildTrustRegistrySnapshotInventory } from "./trust-registry-snapshot.mjs";
import { verifyTrustRegistryGovernanceAttestation } from "./trust-registry-governance-attestation.mjs";
import { buildSurveyDeviceEnrollmentEvidenceInventory } from "./survey-device-enrollment-evidence-inventory.mjs";

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " contains an unsafe path segment.");
  }
  return value;
}

function fileSignature(info) {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function readStableWorkspaceFile(root, relativePath, label, maxBytes) {
  const safePath = safeRelativePath(relativePath, label);
  let current = root;
  const segments = safePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new TypeError(label + " must not contain symbolic links.");
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new TypeError(label + " contains a non-directory path segment.");
    }
    if (index === segments.length - 1 && !details.isFile()) {
      throw new TypeError(label + " must be a regular file.");
    }
  }
  const actual = await realpath(current);
  if (!inside(root, actual)) throw new TypeError(label + " resolves outside the smoke workspace.");
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new RangeError(label + " is empty or exceeds its size limit.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const actualAfter = await realpath(current);
    const pathAfter = await lstat(actual);
    if (actualAfter !== actual || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        fileSignature(before) !== fileSignature(after) ||
        fileSignature(after) !== fileSignature(pathAfter) ||
        bytes.length !== after.size) {
      throw new Error(label + " changed while being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}


/**
 * Descriptor-pinned read for operator tooling that consumes existing smoke
 * evidence. It applies the same no-symlink, workspace-containment and
 * before/after file-identity checks as review-package preparation.
 */
export async function readStableSingleImageWorkspaceEvidenceFile({
  workspaceRoot,
  relativePath,
  label = "Single-image workspace evidence",
  maxBytes = MAX_MANIFEST_BYTES,
}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("Single-image smoke workspace root is required.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Workspace evidence byte limit must be a positive safe integer.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const safePath = safeRelativePath(relativePath, label + " path");
  return readStableWorkspaceFile(root, safePath, label, maxBytes);
}

export async function readStableSingleImageSurveyObservationRecord({ workspaceRoot, observationId }) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("Survey observation workspace root is required.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const relativePath = singleImageSurveyObservationRecordPath(observationId);
  const bytes = await readStableWorkspaceFile(
    root,
    relativePath,
    "Held-out survey observation record " + observationId,
    MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
  );
  return { observationId, relativePath, sha256: sha256(bytes), bytes };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(label + " is not valid UTF-8 JSON.");
  }
}

function addFile(artifactType, relativePath, bytes) {
  return { artifactType, relativePath, bytes, sha256: sha256(bytes) };
}

/**
 * Verify a D3M-08 smoke in its private workspace and return the exact bytes
 * required to carry its horizontal registration into a signed review package.
 */
export async function prepareSingleImageReviewPackageEvidence({
  workspaceRoot,
  jobId,
  buildingId,
  candidateGlbSha256,
  trustedSurveyorRegistry = null,
  trustedDeviceRegistry = null,
  trustedEnrollmentAuthorityRegistry = null,
  trustRegistryGovernanceAttestation = null,
  trustRegistryGovernancePublicKeyPem = null,
  minimumTrustRegistrySequence = null,
}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw new TypeError("single-image smoke workspace is required.");
  if (typeof jobId !== "string" || !SAFE_ID.test(jobId)) throw new TypeError("single-image smoke jobId is invalid.");
  if (typeof buildingId !== "string" || !SAFE_ID.test(buildingId)) throw new TypeError("buildingId is invalid.");
  if (!HASH.test(candidateGlbSha256 ?? "")) throw new TypeError("candidateGlbSha256 must be a SHA-256 digest.");

  const root = await realpath(path.resolve(workspaceRoot));
  const before = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId });
  const reportPath = ".building-engine/runtime-smokes/" + jobId + ".json";
  const reportBytes = await readStableWorkspaceFile(root, reportPath, "Single-image smoke report", MAX_REPORT_BYTES);
  const report = parseJson(reportBytes, "Single-image smoke report");
  if (!["1.5.0", "1.6.0"].includes(report.schemaVersion) || report.kind !== "single-image-runtime-smoke" ||
      report.status !== "passed" || report.jobId !== jobId || report.buildingId !== buildingId ||
      report.output?.sha256 !== candidateGlbSha256 ||
      before.model?.sha256 !== candidateGlbSha256 ||
      before.generationArtifactReceiptStatus !== "verified" ||
      before.georeferenceEvidenceStatus !== "calibrated-needs-human-review" ||
      report.georeferenceEvidence?.status !== "calibrated-needs-human-review" ||
      report.georeferenceEvidence?.modelSha256 !== candidateGlbSha256 ||
      report.georeferenceEvidence?.manifest === null ||
      report.georeferenceEvidence?.registration?.vertical?.status !== "not-solved" ||
      (report.georeferenceEvidence?.verticalEvidence?.status !== undefined &&
       !["not-requested", "calibrated-needs-human-review"].includes(report.georeferenceEvidence.verticalEvidence.status)) ||
      (report.georeferenceEvidence?.schemaVersion === "1.2.0" &&
       report.georeferenceEvidence?.independentCheckpointEvidence?.status !== "validated-needs-human-review") ||
      report.mapReady !== false || report.publicationEligible !== false || report.automaticApproval !== false) {
    throw new Error("Single-image smoke must be a verified D3M-08 run with successful horizontal control-point registration for the exact candidate GLB.");
  }

  const receiptPath = safeRelativePath(report.generationArtifactReceipt?.path, "Generation artifact receipt path");
  const receiptBytes = await readStableWorkspaceFile(root, receiptPath, "Generation artifact receipt", MAX_RECEIPT_BYTES);
  const receipt = parseJson(receiptBytes, "Generation artifact receipt");
  const workflowPath = safeRelativePath(receipt?.payload?.workflowReport?.path, "Generation workflow report path");
  const workflowBytes = await readStableWorkspaceFile(root, workflowPath, "Generation workflow report", MAX_WORKFLOW_BYTES);
  const workflowReport = parseJson(workflowBytes, "Generation workflow report");
  const manifestPath = safeRelativePath(report.georeferenceEvidence.manifest.path, "Control-point manifest path");
  const manifestBytes = await readStableWorkspaceFile(root, manifestPath, "Control-point manifest", MAX_MANIFEST_BYTES);
  const controlManifest = parseJson(manifestBytes, "Control-point manifest");
  const observationRecordFiles = [];
  let observationRecordInventory = null;
  const observationAttestationFiles = [];
  let observationAttestationInventory = null;
  const observationDeviceAttestationFiles = [];
  let observationDeviceAttestationInventory = null;
  const hasTrustedSurveyorRegistry = typeof trustedSurveyorRegistry === "string" && trustedSurveyorRegistry.trim().length > 0;
  if (hasTrustedSurveyorRegistry && Buffer.byteLength(trustedSurveyorRegistry, "utf8") > MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES) {
    throw new RangeError("Trusted surveyor registry exceeds the 64 KiB limit.");
  }
  if (report.georeferenceEvidence?.schemaVersion === "1.2.0") {
    const checkpoints = controlManifest.heldOutCheckpoints?.points;
    if (controlManifest.schemaVersion !== "1.2.0" || !Array.isArray(checkpoints) ||
        checkpoints.length < 6 || checkpoints.length > 100 ||
        checkpoints.length !== report.georeferenceEvidence.independentCheckpointEvidence?.controls?.count) {
      throw new Error("Held-out control manifest does not declare the exact 6–100 checkpoints required by its georeference evidence.");
    }
    let totalRecordBytes = 0;
    for (const checkpoint of checkpoints) {
      const record = await readStableSingleImageSurveyObservationRecord({
        workspaceRoot: root,
        observationId: checkpoint.observationId,
      });
      const { relativePath, bytes: recordBytes, sha256: actualSha256 } = record;
      if (typeof checkpoint.observationRecordSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(checkpoint.observationRecordSha256)) {
        throw new Error("Held-out checkpoint is missing a valid observation-record SHA-256: " + checkpoint.id);
      }
      if (actualSha256 !== checkpoint.observationRecordSha256) {
        throw new Error("Held-out survey observation record SHA-256 does not match checkpoint " + checkpoint.id + ".");
      }
      totalRecordBytes += recordBytes.length;
      if (!Number.isSafeInteger(totalRecordBytes) ||
          totalRecordBytes > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS_BYTES) {
        throw new RangeError("Held-out survey observation records exceed the 128 MiB aggregate limit.");
      }
      observationRecordFiles.push({
        artifactType: "single-image-survey-observation-record",
        observationId: checkpoint.observationId,
        checkpointId: checkpoint.id,
        relativePath,
        sha256: actualSha256,
        bytes: recordBytes,
      });
    }
    observationRecordInventory = buildSingleImageSurveyObservationRecordInventory(
      observationRecordFiles.map((file) => ({
        observationId: file.observationId,
        relativePath: file.relativePath,
        sha256: file.sha256,
        bytes: file.bytes.length,
      })),
    );
    if (hasTrustedSurveyorRegistry) {
      for (const file of observationRecordFiles) {
        const relativePath = surveyObservationAttributionAttestationPath(file.observationId);
        const attestationBytes = await readStableWorkspaceFile(
          root,
          relativePath,
          "Survey observation attribution attestation " + file.observationId,
          32 * 1024,
        );
        const attestation = parseJson(attestationBytes, "Survey observation attribution attestation");
        const result = verifySurveyObservationAttributionAttestation({
          attestation,
          recordBytes: file.bytes,
          controlPointManifestBytes: manifestBytes,
          observationId: file.observationId,
          checkpointId: file.checkpointId,
          buildingId,
          trustedSurveyorRegistry,
        });
        if (!result.valid) {
          throw new Error("Survey observation attribution signature verification failed for " +
            file.observationId + ": " + result.errors.map((item) => item.id).join(","));
        }
        observationAttestationFiles.push({
          artifactType: "single-image-survey-observation-attestation",
          observationId: file.observationId,
          checkpointId: file.checkpointId,
          relativePath,
          sha256: sha256(attestationBytes),
          bytes: attestationBytes,
          registryId: result.registryId,
          surveyorId: result.surveyorId,
          keyId: result.keyId,
        });
      }
      observationAttestationInventory = buildSurveyObservationAttributionInventory(
        observationAttestationFiles.map((file) => ({
          observationId: file.observationId,
          checkpointId: file.checkpointId,
          relativePath: file.relativePath,
          sha256: file.sha256,
          bytes: file.bytes.length,
        })),
      );
    } else {
      // Do not silently omit present signatures from a package when the
      // external trust registry was not supplied to verify them.
      for (const file of observationRecordFiles) {
        const sidecarPath = path.join(root, ...surveyObservationAttributionAttestationPath(file.observationId).split("/"));
        try {
          const info = await lstat(sidecarPath);
          if (info.isSymbolicLink() || !info.isFile()) {
            throw new TypeError("Survey observation attribution sidecar must be a regular file.");
          }
          throw new Error("Survey observation attribution sidecars exist but SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON was not supplied.");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
  }

    const hasTrustedDeviceRegistry = typeof trustedDeviceRegistry === "string" && trustedDeviceRegistry.trim().length > 0;
    if (hasTrustedDeviceRegistry && Buffer.byteLength(trustedDeviceRegistry, "utf8") > MAX_TRUSTED_SURVEY_DEVICE_REGISTRY_BYTES) {
      throw new RangeError("Trusted survey device registry exceeds the 64 KiB limit.");
    }
    if (hasTrustedDeviceRegistry) {
      if (!hasTrustedSurveyorRegistry || observationAttestationFiles.length !== observationRecordFiles.length) {
        throw new Error("D3M-ENGINE-17 requires D3M-ENGINE-16 surveyor attestations and the trusted surveyor registry.");
      }
      for (const file of observationRecordFiles) {
        const relativePath = surveyObservationDeviceAttestationPath(file.observationId);
        const sidecarBytes = await readStableWorkspaceFile(root, relativePath,
          "Survey observation device attestation " + file.observationId, 32 * 1024);
        const sidecar = parseJson(sidecarBytes, "Survey observation device attestation");
        const result = verifySurveyObservationDeviceAttestation({
          attestation: sidecar, recordBytes: file.bytes, controlPointManifestBytes: manifestBytes,
          observationId: file.observationId, checkpointId: file.checkpointId, buildingId, trustedDeviceRegistry,
        });
        if (!result.valid) throw new Error("Survey observation device attestation verification failed for " +
          file.observationId + ": " + result.errors.map((item) => item.id).join(","));
        observationDeviceAttestationFiles.push({
          artifactType: "single-image-survey-observation-device-attestation", observationId: file.observationId,
          checkpointId: file.checkpointId, relativePath, sha256: sha256(sidecarBytes), bytes: sidecarBytes,
          registryId: result.registryId, deviceId: result.deviceId, keyId: result.keyId,
          enrollmentEvidenceSha256: result.enrollmentEvidenceSha256,
        });
      }
      observationDeviceAttestationInventory = buildSurveyObservationDeviceAttestationInventory(
        observationDeviceAttestationFiles.map((file) => ({
          observationId: file.observationId, checkpointId: file.checkpointId, relativePath: file.relativePath,
          sha256: file.sha256, bytes: file.bytes.length,
        })),
      );
    } else {
      for (const file of observationRecordFiles) {
        const sidecarPath = path.join(root, ...surveyObservationDeviceAttestationPath(file.observationId).split("/"));
        try {
          const info = await lstat(sidecarPath);
          if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("Device-attestation sidecar must be a regular file.");
          throw new Error("Device-attestation sidecars exist but SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON was not supplied.");
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }

  const hasTrustedEnrollmentAuthorityRegistry =
    typeof trustedEnrollmentAuthorityRegistry === "string" && trustedEnrollmentAuthorityRegistry.trim().length > 0;
  if (hasTrustedEnrollmentAuthorityRegistry &&
      Buffer.byteLength(trustedEnrollmentAuthorityRegistry, "utf8") > MAX_TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_BYTES) {
    throw new RangeError("Trusted survey-device enrollment-authority registry exceeds the 64 KiB limit.");
  }
  const enrollmentEvidenceFiles = [];
  let enrollmentEvidenceInventory = null;
  let trustRegistrySnapshotInventory = null;
  let trustRegistryGovernanceMetadata = null;
  const distinctDevices = new Map();
  for (const sidecar of observationDeviceAttestationFiles) {
    const existing = distinctDevices.get(sidecar.deviceId);
    if (existing && (existing.enrollmentEvidenceSha256 !== sidecar.enrollmentEvidenceSha256 || existing.registryId !== sidecar.registryId)) {
      throw new Error("One device identity resolves to conflicting enrollment evidence or device registries.");
    }
    distinctDevices.set(sidecar.deviceId, sidecar);
  }
  const expectedEnrollmentPaths = [...distinctDevices.values()].map((entry) => surveyDeviceEnrollmentEvidencePath(entry.deviceId)).sort();
  const enrollmentDirectory = path.join(root, "evidence", "device-enrollments");
  let enrollmentDirectoryEntries = [];
  try {
    const directoryInfo = await lstat(enrollmentDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new TypeError("Device enrollment evidence directory must be a regular directory.");
    enrollmentDirectoryEntries = await readdir(enrollmentDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (expectedEnrollmentPaths.length > 0 && hasTrustedEnrollmentAuthorityRegistry) throw new Error("D3M-ENGINE-18 device enrollment evidence directory is missing.");
  }
  const expectedEnrollmentNames = new Set(expectedEnrollmentPaths.map((value) => path.posix.basename(value)));
  for (const name of enrollmentDirectoryEntries) {
    if (!expectedEnrollmentNames.has(name)) throw new Error("Unexpected or orphaned device enrollment evidence file: " + name);
    const itemInfo = await lstat(path.join(enrollmentDirectory, name));
    if (itemInfo.isSymbolicLink() || !itemInfo.isFile()) throw new TypeError("Device enrollment evidence must be a regular file: " + name);
  }
  if (hasTrustedEnrollmentAuthorityRegistry) {
    if (!hasTrustedDeviceRegistry || distinctDevices.size < 1) throw new Error("D3M-ENGINE-18 enrollment evidence requires verified D3M-17 device attestations and the trusted device registry.");
    for (const entry of [...distinctDevices.values()].sort((x, y) => x.deviceId.localeCompare(y.deviceId))) {
      const relativePath = surveyDeviceEnrollmentEvidencePath(entry.deviceId);
      const evidenceBytes = await readStableWorkspaceFile(root, relativePath, "Device enrollment evidence " + entry.deviceId, MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES);
      const result = verifySurveyDeviceEnrollmentEvidence({ evidenceBytes, trustedDeviceRegistry, trustedEnrollmentAuthorityRegistry, deviceId: entry.deviceId });
      if (!result.valid || result.evidenceSha256 !== entry.enrollmentEvidenceSha256 || result.authorityRegistryId === null) {
        throw new Error("Device enrollment evidence verification failed for " + entry.deviceId + ": " + result.errors.map((item) => item.id).join(","));
      }
      enrollmentEvidenceFiles.push({ artifactType: "single-image-survey-device-enrollment-evidence", deviceId: entry.deviceId,
        authorityId: result.authorityId, authorityType: result.authorityType, authorityRegistryId: result.authorityRegistryId,
        relativePath, sha256: sha256(evidenceBytes), bytes: evidenceBytes });
    }
    enrollmentEvidenceInventory = buildSurveyDeviceEnrollmentEvidenceInventory(enrollmentEvidenceFiles.map((file) => ({
      deviceId: file.deviceId, relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes.length,
      authorityId: file.authorityId, authorityType: file.authorityType, authorityRegistryId: file.authorityRegistryId,
    })));
    if (enrollmentEvidenceFiles.length !== enrollmentDirectoryEntries.length) throw new Error("Device enrollment evidence directory inventory is incomplete or contains orphaned files.");
    trustRegistrySnapshotInventory = buildTrustRegistrySnapshotInventory({
      trustedSurveyorRegistry,
      trustedDeviceRegistry,
      trustedEnrollmentAuthorityRegistry,
    });
  } else if (enrollmentDirectoryEntries.length > 0) {
    throw new Error("Device enrollment evidence files exist but SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON was not supplied.");
  }
  const governanceInputsPresent = [
    trustRegistryGovernanceAttestation,
    trustRegistryGovernancePublicKeyPem,
    minimumTrustRegistrySequence,
  ].some((value) => value !== null && value !== undefined && value !== "");
  if (governanceInputsPresent) {
    if (!trustRegistrySnapshotInventory ||
        typeof trustRegistryGovernanceAttestation !== "string" ||
        typeof trustRegistryGovernancePublicKeyPem !== "string" ||
        minimumTrustRegistrySequence === null || minimumTrustRegistrySequence === undefined) {
      throw new Error("D3M-ENGINE-21 requires the exact D3M-20 snapshot, governance attestation, independently pinned public key and minimum sequence.");
    }
    const governanceResult = verifyTrustRegistryGovernanceAttestation({
      attestation: trustRegistryGovernanceAttestation,
      governancePublicKeyPem: trustRegistryGovernancePublicKeyPem,
      minimumSequence: minimumTrustRegistrySequence,
      snapshotInventory: trustRegistrySnapshotInventory,
    });
    if (!governanceResult.valid) {
      throw new Error("trust-registry-governance-verification-failed:" +
        governanceResult.errors.map((item) => item.id).join(","));
    }
    trustRegistryGovernanceMetadata = governanceResult.metadata;
  }
  const expectedReceiptSchema = report.schemaVersion === "1.6.0" ? "1.2.0" : "1.1.0";
  if (receipt.schemaVersion !== expectedReceiptSchema || receipt.payload?.georeference === undefined ||
      receipt.payload?.buildingId !== buildingId || receipt.payload?.jobId !== jobId ||
      receipt.payload?.output?.sha256 !== candidateGlbSha256 ||
      receipt.payload?.source?.sourceId !== report.source?.sourceId ||
      receipt.payload?.source?.sha256 !== report.source?.sha256 ||
      receipt.payload?.workflowReport?.bytes !== workflowBytes.length ||
      receipt.payload?.workflowReport?.sha256 !== sha256(workflowBytes) ||
      sha256(receiptBytes) !== report.generationArtifactReceipt.sha256 ||
      receiptBytes.length !== report.generationArtifactReceipt.bytes ||
      sha256(manifestBytes) !== report.georeferenceEvidence.manifest.sha256 ||
      manifestBytes.length !== report.georeferenceEvidence.manifest.bytes ||
      workflowReport.jobId !== jobId || workflowReport.buildingId !== buildingId ||
      workflowReport.output?.modelSha256 !== candidateGlbSha256 ||
      canonicalJson(workflowReport.georeference) !== canonicalJson(report.georeferenceEvidence.registration) ||
      canonicalJson(receipt.payload.georeference) !== canonicalJson(report.georeferenceEvidence)) {
    throw new Error("Single-image smoke, generation receipt, workflow report and control-point manifest are not cross-bound.");
  }

  const after = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId });
  const reportBytesAfter = await readStableWorkspaceFile(root, reportPath, "Single-image smoke report", MAX_REPORT_BYTES);
  const receiptBytesAfter = await readStableWorkspaceFile(root, receiptPath, "Generation artifact receipt", MAX_RECEIPT_BYTES);
  const workflowBytesAfter = await readStableWorkspaceFile(root, workflowPath, "Generation workflow report", MAX_WORKFLOW_BYTES);
  const manifestBytesAfter = await readStableWorkspaceFile(root, manifestPath, "Control-point manifest", MAX_MANIFEST_BYTES);
  const observationRecordBytesAfter = [];
  for (const file of observationRecordFiles) {
    observationRecordBytesAfter.push(await readStableSingleImageSurveyObservationRecord({
      workspaceRoot: root,
      observationId: file.observationId,
    }));
  }
  const observationAttestationBytesAfter = [];
  for (const file of observationAttestationFiles) {
    observationAttestationBytesAfter.push(await readStableWorkspaceFile(
      root, file.relativePath, "Survey observation attribution attestation " + file.observationId, 32 * 1024,
    ));
  }
  const enrollmentEvidenceBytesAfter = [];
  for (const file of enrollmentEvidenceFiles) {
    enrollmentEvidenceBytesAfter.push(await readStableWorkspaceFile(
      root, file.relativePath, "Device enrollment evidence " + file.deviceId + "/" + file.keyId,
      MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES,
    ));
  }
  const observationDeviceAttestationBytesAfter = [];
  for (const file of observationDeviceAttestationFiles) {
    observationDeviceAttestationBytesAfter.push(await readStableWorkspaceFile(
      root, file.relativePath, "Survey observation device attestation " + file.observationId, 32 * 1024,
    ));
  }
  if (after.model?.sha256 !== candidateGlbSha256 ||
      sha256(reportBytesAfter) !== sha256(reportBytes) ||
      sha256(receiptBytesAfter) !== sha256(receiptBytes) ||
      sha256(workflowBytesAfter) !== sha256(workflowBytes) ||
      sha256(manifestBytesAfter) !== sha256(manifestBytes) ||
      observationRecordBytesAfter.some((record, index) =>
        record.relativePath !== observationRecordFiles[index].relativePath ||
        record.bytes.length !== observationRecordFiles[index].bytes.length ||
        record.sha256 !== observationRecordFiles[index].sha256) ||
      observationAttestationBytesAfter.some((bytes, index) =>
        sha256(bytes) !== observationAttestationFiles[index].sha256 ||
        !bytes.equals(observationAttestationFiles[index].bytes)) ||
      observationDeviceAttestationBytesAfter.some((bytes, index) =>
        sha256(bytes) !== observationDeviceAttestationFiles[index].sha256 ||
        !bytes.equals(observationDeviceAttestationFiles[index].bytes)) ||
      enrollmentEvidenceBytesAfter.some((bytes, index) =>
        sha256(bytes) !== enrollmentEvidenceFiles[index].sha256 ||
        !bytes.equals(enrollmentEvidenceFiles[index].bytes))) {
    throw new Error("Single-image smoke or survey observation evidence changed during review-package preparation.");
  }

  const files = [
    addFile("single-image-smoke-report", "reports/single-image-runtime-smoke.json", reportBytes),
    addFile("single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", receiptBytes),
    addFile("single-image-workflow-report", "reports/single-image-workflow-report.json", workflowBytes),
    addFile("single-image-control-point-manifest", "evidence/single-image-control-points.json", manifestBytes),
    ...observationRecordFiles.map((file) => ({
      artifactType: file.artifactType,
      observationId: file.observationId,
      relativePath: file.relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
    ...observationAttestationFiles.map((file) => ({
      artifactType: file.artifactType, observationId: file.observationId, checkpointId: file.checkpointId,
      relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes,
    })),
    ...observationDeviceAttestationFiles.map((file) => ({
      artifactType: file.artifactType, observationId: file.observationId, checkpointId: file.checkpointId,
      deviceId: file.deviceId, keyId: file.keyId,
      relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes,
    })),
    ...enrollmentEvidenceFiles.map((file) => ({
      artifactType: file.artifactType, deviceId: file.deviceId, keyId: file.keyId,
      authorityId: file.authorityId, authorityType: file.authorityType, authorityRegistryId: file.authorityRegistryId,
      relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes,
    })),
  ];
  const verticalEvidence = report.georeferenceEvidence.verticalEvidence;
  const hasVerticalCalibration = verticalEvidence?.status === "calibrated-needs-human-review";
  const checkpointEvidence = report.georeferenceEvidence.independentCheckpointEvidence;
  const hasIndependentCheckpoints = checkpointEvidence?.status === "validated-needs-human-review";
  return {
    schemaVersion: trustRegistryGovernanceMetadata ? "1.8.0" : trustRegistrySnapshotInventory ? "1.7.0" : enrollmentEvidenceInventory ? "1.6.0" : observationDeviceAttestationInventory ? "1.5.0" : observationAttestationInventory ? "1.4.0" : hasIndependentCheckpoints && observationRecordInventory ? "1.3.0" : hasVerticalCalibration ? "1.1.0" : "1.0.0",
    jobId,
    buildingId,
    sourceId: report.source.sourceId,
    sourceSha256: report.source.sha256,
    candidateGlbSha256,
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: sha256(manifestBytes),
    smokeReportSha256: sha256(reportBytes),
    generationArtifactReceiptSha256: sha256(receiptBytes),
    workflowReportSha256: sha256(workflowBytes),
    verticalDatum: hasVerticalCalibration ? "EPSG:4979-ellipsoidal" : "not-solved",
    ...(hasVerticalCalibration ? {
      verticalStatus: verticalEvidence.status,
      verticalEvidenceSha256: sha256(Buffer.from(canonicalJson(verticalEvidence), "utf8")),
      verticalReferenceFrame: verticalEvidence.referenceFrame,
      verticalCoordinateEpoch: verticalEvidence.coordinateEpoch,
      verticalHeightOffsetM: verticalEvidence.heightOffsetM,
      verticalRmsErrorM: verticalEvidence.controls.rmsErrorM,
      verticalMaxResidualM: verticalEvidence.controls.maxResidualM,
      verticalControlPointCount: verticalEvidence.controls.count,
    } : {}),
    ...(hasIndependentCheckpoints ? {
      checkpointValidationStatus: checkpointEvidence.status,
      checkpointEvidenceSha256: sha256(Buffer.from(canonicalJson(checkpointEvidence), "utf8")),
      checkpointReferenceFrame: checkpointEvidence.referenceFrame,
      checkpointCoordinateEpoch: checkpointEvidence.coordinateEpoch,
      checkpointCount: checkpointEvidence.controls.count,
      checkpointHorizontalRmsErrorM: checkpointEvidence.controls.horizontalRmsErrorM,
      checkpointHorizontalMaxResidualM: checkpointEvidence.controls.horizontalMaxResidualM,
      checkpointVerticalRmsErrorM: checkpointEvidence.controls.verticalRmsErrorM,
      checkpointVerticalMaxResidualM: checkpointEvidence.controls.verticalMaxResidualM,
      checkpoint3dRmsErrorM: checkpointEvidence.controls.spatial3dRmsErrorM,
      checkpoint3dMaxResidualM: checkpointEvidence.controls.spatial3dMaxResidualM,
      ...(observationRecordInventory ? {
        surveyObservationRecordCount: observationRecordInventory.count,
        surveyObservationRecordBytes: observationRecordInventory.totalBytes,
        surveyObservationRecordsSha256: observationRecordInventory.sha256,
        surveyObservationRecords: observationRecordInventory.records,
      } : {}),
      ...(observationAttestationInventory ? {
        surveyObservationAttestationCount: observationAttestationInventory.count,
        surveyObservationAttestationBytes: observationAttestationInventory.totalBytes,
        surveyObservationAttestationsSha256: observationAttestationInventory.sha256,
        surveyObservationAttestations: observationAttestationInventory.entries,
        surveyObservationAttributionStatus: "attribution-signatures-verified",
        trustedSurveyorRegistryId: observationAttestationFiles[0]?.registryId ?? null,
      } : {}),
      ...(observationDeviceAttestationInventory ? {
        surveyObservationDeviceAttestationCount: observationDeviceAttestationInventory.count,
        surveyObservationDeviceAttestationBytes: observationDeviceAttestationInventory.totalBytes,
        surveyObservationDeviceAttestationsSha256: observationDeviceAttestationInventory.sha256,
        surveyObservationDeviceAttestations: observationDeviceAttestationInventory.entries,
        surveyObservationDeviceAttestationStatus: "device-key-attestations-verified",
        trustedSurveyDeviceRegistryId: observationDeviceAttestationFiles[0]?.registryId ?? null,
      } : {}),
      ...(enrollmentEvidenceInventory ? {
        surveyDeviceEnrollmentEvidenceCount: enrollmentEvidenceInventory.count,
        surveyDeviceEnrollmentEvidenceBytes: enrollmentEvidenceInventory.totalBytes,
        surveyDeviceEnrollmentEvidenceSha256: enrollmentEvidenceInventory.sha256,
        surveyDeviceEnrollmentEvidence: enrollmentEvidenceInventory.entries,
        surveyDeviceEnrollmentEvidenceStatus: "enrollment-authority-evidence-verified",
        trustedSurveyDeviceEnrollmentAuthorityRegistryId: enrollmentEvidenceFiles[0]?.authorityRegistryId ?? null,
      } : {}),
      ...(trustRegistrySnapshotInventory ? {
        trustRegistrySnapshotSchemaVersion: trustRegistrySnapshotInventory.schemaVersion,
        trustRegistrySnapshotCount: trustRegistrySnapshotInventory.count,
        trustRegistrySnapshotBytes: trustRegistrySnapshotInventory.totalBytes,
        trustRegistrySnapshotsSha256: trustRegistrySnapshotInventory.sha256,
        trustRegistrySnapshots: trustRegistrySnapshotInventory.entries,
      } : {}),
      ...(trustRegistryGovernanceMetadata ? { trustRegistryGovernance: trustRegistryGovernanceMetadata } : {}),
    } : {}),
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    files,
  };
}
