#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateIndependentBuildingTruth } from "../src/core/building-generation/independent-building-truth-evaluator.mjs";
import { extractGlbGeometry } from "../src/core/building-generation/glb-geometry-extraction.mjs";
import { adaptIndependentReferenceGeometry } from "../src/core/building-generation/independent-reference-geometry-adapter.mjs";
import { geometryPayloadSha256, validateGeometryExtractionProvenance } from "../src/core/building-generation/geometry-extraction-provenance.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe project-relative path.");
  }
  return value;
}
async function safeRead(root, relative, label) {
  const safe = safeRelative(relative, label);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " resolves outside the project root.");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symbolic links.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  return { path: resolved, bytes: await readFile(resolved) };
}

async function safeOutputPath(root, relative) {
  const safe = safeRelative(relative, "report output");
  const parts = safe.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Report output must not traverse symbolic links or non-directories.");
    }
  }
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(root + path.sep)) throw new TypeError("Report output resolves outside the project root.");
  return resolved;
}
function replayCandidateGeometry(manifest, config, candidateBytes, sourceSha256) {
  const candidate = manifest?.candidate;
  const configured = config?.candidate;
  try {
    if (!configured || !Array.isArray(configured.modelToEvaluationFrameMatrix4x4) ||
        !Array.isArray(configured.checkPointBindings)) {
      return {
        status: "incomplete",
        sourceSha256,
        expectedGeometrySha256: null,
        actualGeometrySha256: null,
        reason: "Hash-verified preparation config must declare the registration matrix and checkpoint vertex bindings.",
      };
    }
    const configMatchesManifest =
      candidate?.glbPath === configured.glbPath &&
      candidate?.coordinateFrameId === configured.coordinateFrameId &&
      candidate?.units === configured.units &&
      JSON.stringify(candidate?.modelToEvaluationFrameMatrix4x4) === JSON.stringify(configured.modelToEvaluationFrameMatrix4x4) &&
      JSON.stringify(candidate?.checkPointBindings) === JSON.stringify(configured.checkPointBindings) &&
      (!configured.expectedGlbSha256 || configured.expectedGlbSha256.toLowerCase() === sourceSha256.toLowerCase());
    if (!configMatchesManifest) {
      throw new TypeError("Candidate path/frame/units/transform/checkpoint bindings do not match the hash-pinned preparation config.");
    }
    const extracted = extractGlbGeometry(candidateBytes, {
      coordinateFrameId: configured.coordinateFrameId,
      units: configured.units,
      modelToEvaluationFrameMatrix4x4: configured.modelToEvaluationFrameMatrix4x4,
      checkPointBindings: configured.checkPointBindings,
    });
    const replayedGeometry = {
      coordinateFrameId: extracted.coordinateFrameId,
      units: extracted.units,
      footprint: extracted.footprint,
      dimensionsM: extracted.dimensionsM,
      checkPoints: extracted.checkPoints,
      surfaceMesh: {
        sourceGlbSha256: sourceSha256,
        vertices: extracted.surfaceMesh.vertices,
        triangles: extracted.surfaceMesh.triangles,
      },
    };
    const expectedGeometrySha256 = geometryPayloadSha256(candidate);
    const actualGeometrySha256 = geometryPayloadSha256(replayedGeometry);
    const matches = expectedGeometrySha256 === actualGeometrySha256;
    return {
      status: matches ? "passed" : "failed",
      sourceSha256,
      expectedGeometrySha256,
      actualGeometrySha256,
      extractionSummary: extracted.extractionSummary,
      reason: matches
        ? "Candidate geometry replayed identically from exact GLB bytes and the hash-verified preparation config."
        : "Prepared candidate geometry differs from deterministic extraction of the actual candidate GLB bytes.",
    };
  } catch (error) {
    return {
      status: "failed",
      sourceSha256,
      expectedGeometrySha256: null,
      actualGeometrySha256: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function replayReferenceGeometry(manifest, config, referenceBytes, sourceSha256) {
  const reference = manifest?.reference;
  const preparation = manifest?.preparation;
  const configured = config?.reference;
  try {
    if (!configured || typeof configured.sourceCoordinateFrameId !== "string" ||
        !configured.sourceCoordinateFrameId.trim() ||
        !Array.isArray(configured.sourceToEvaluationFrameMatrix4x4)) {
      return {
        status: "incomplete",
        sourceSha256,
        expectedGeometrySha256: null,
        actualGeometrySha256: null,
        reason: "Hash-verified preparation config must declare the independent reference source frame and metric transform.",
      };
    }
    const configMatchesManifest =
      reference?.sourcePath === configured.sourcePath &&
      reference?.coordinateFrameId === config?.candidate?.coordinateFrameId &&
      preparation?.referenceSourceCoordinateFrameId === configured.sourceCoordinateFrameId &&
      JSON.stringify(preparation?.referenceSourceToEvaluationFrameMatrix4x4) === JSON.stringify(configured.sourceToEvaluationFrameMatrix4x4) &&
      JSON.stringify(reference?.geometryExtractionSummary?.frameTransform?.sourceToEvaluationFrameMatrix4x4) === JSON.stringify(configured.sourceToEvaluationFrameMatrix4x4) &&
      (!configured.expectedSourceSha256 || configured.expectedSourceSha256.toLowerCase() === sourceSha256.toLowerCase());
    if (!configMatchesManifest) {
      throw new TypeError("Reference path/frame/transform does not match the hash-verified preparation config.");
    }
    const truth = JSON.parse(referenceBytes.toString("utf8"));
    const adapted = adaptIndependentReferenceGeometry(truth, {
      sourceCoordinateFrameId: configured.sourceCoordinateFrameId,
      evaluationCoordinateFrameId: reference.coordinateFrameId,
      sourceToEvaluationFrameMatrix4x4: configured.sourceToEvaluationFrameMatrix4x4,
    });
    const replayedGeometry = {
      coordinateFrameId: adapted.coordinateFrameId,
      units: adapted.units,
      footprint: adapted.footprint,
      dimensionsM: adapted.dimensionsM,
      checkPoints: adapted.checkPoints,
      surfaceMesh: {
        sha256: sourceSha256,
        vertices: adapted.surfaceMesh.vertices,
        triangles: adapted.surfaceMesh.triangles,
      },
    };
    const expectedGeometrySha256 = geometryPayloadSha256(reference);
    const actualGeometrySha256 = geometryPayloadSha256(replayedGeometry);
    const matches = expectedGeometrySha256 === actualGeometrySha256;
    return {
      status: matches ? "passed" : "failed",
      sourceSha256,
      expectedGeometrySha256,
      actualGeometrySha256,
      frameTransform: adapted.frameTransform,
      reason: matches
        ? "Reference geometry replayed identically from exact source bytes and the hash-verified preparation config."
        : "Prepared reference geometry differs from re-importing the exact independent-reference source bytes.",
    };
  } catch (error) {
    return {
      status: "failed",
      sourceSha256,
      expectedGeometrySha256: null,
      actualGeometrySha256: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function addArtifactCheck(report, id, passed, detail, failureStatus = "failed") {
  const check = { id, status: passed ? "passed" : failureStatus, detail };
  report.checks.push(check);
  if (!passed && failureStatus === "warning") report.warnings.push(check);
  if (!passed && failureStatus === "failed") report.failures.push(check);
}
function refreshStatus(report) {
  report.counts = {
    passed: report.checks.filter((item) => item.status === "passed").length,
    warnings: report.checks.filter((item) => item.status === "warning").length,
    failures: report.checks.filter((item) => item.status === "failed").length,
  };
  report.status = report.counts.failures ? "benchmark-failed" :
    report.counts.warnings ? "benchmark-incomplete" : "benchmark-review-required";
}

function createMetricWithheldReport(manifest, prerequisites, reason) {
  const candidate = manifest?.candidate ?? {};
  const reference = manifest?.reference ?? {};
  return {
    schemaVersion: "1.0.0",
    engine: "independent-building-truth-evaluator-v1",
    evaluationId: manifest?.evaluationId ?? "invalid-evaluation",
    buildingId: manifest?.buildingId ?? null,
    generatedAt: manifest?.generatedAt ?? null,
    status: "benchmark-incomplete",
    candidate: {
      glbSha256: typeof candidate.glbSha256 === "string" ? candidate.glbSha256.toLowerCase() : null,
      coordinateFrameId: candidate.coordinateFrameId ?? null,
      units: candidate.units ?? null,
    },
    reference: {
      sourceId: reference.sourceId ?? null,
      sourceSha256: typeof reference.sourceSha256 === "string" ? reference.sourceSha256.toLowerCase() : null,
      evidenceBasis: reference.evidenceBasis ?? "unknown",
      reviewedBy: reference.reviewedBy ?? null,
      reviewedAt: reference.reviewedAt ?? null,
      independentlyAuthenticated: false,
    },
    metrics: null,
    metricComputation: { status: "withheld", reason, prerequisites },
    checks: [],
    warnings: [],
    failures: [],
    counts: { passed: 0, warnings: 0, failures: 0 },
    policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false },
    limitations: [
      "No geometry comparison metrics were computed because one or more exact-source byte/replay prerequisites did not pass.",
      "A withheld report is not evidence that the candidate geometry is accurate or inaccurate.",
      "Source hashes and deterministic replay do not authenticate the physical building identity, survey accuracy, reviewer independence or source usage rights.",
      "No automatic model selection, publication approval or map-ready decision is produced.",
    ],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.find((arg) => arg.startsWith("--root="));
  const positional = argv.filter((arg) => !arg.startsWith("--root="));
  if (process.argv.includes("--help") || !positional[0] || positional.length > 2) {
    console.log("Usage: node scripts/evaluate-independent-building-truth.mjs <evaluation-manifest.json> [report.json] [--root=project-root]\nChecks candidate GLB, independent truth source, extractor source/configuration bytes, and deterministic geometry-payload provenance before computing footprint, dimension, checkpoint and optional mesh-distance metrics. This does not approve a model.");
    process.exitCode = process.argv.includes("--help") ? 0 : 2;
    return;
  }

  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const manifestFile = await safeRead(root, positional[0], "evaluation manifest");
  const manifestSha256 = sha256(manifestFile.bytes);
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const candidateAsset = await safeRead(root, manifest.candidate?.glbPath, "candidate GLB");
  const actualCandidateSha256 = sha256(candidateAsset.bytes);
  const candidateHashMatches = SHA256.test(manifest.candidate?.glbSha256 ?? "") &&
    actualCandidateSha256.toLowerCase() === manifest.candidate.glbSha256.toLowerCase();
  let preparationConfig = null;
  let preparationConfigResult = {
    status: "incomplete",
    expectedSha256: manifest.preparation?.configSha256 ?? null,
    actualSha256: null,
    path: manifest.preparation?.configPath ?? null,
    reason: "Prepared manifest is missing its hash-pinned configuration path/digest.",
  };
  try {
    const configFile = await safeRead(root, manifest.preparation?.configPath, "geometry preparation config");
    const actualConfigSha256 = sha256(configFile.bytes);
    const expectedConfigSha256 = manifest.preparation?.configSha256;
    const hashMatches = SHA256.test(expectedConfigSha256 ?? "") &&
      expectedConfigSha256.toLowerCase() === actualConfigSha256.toLowerCase();
    if (!hashMatches) {
      preparationConfigResult = {
        status: "failed",
        path: configFile.path,
        expectedSha256: expectedConfigSha256 ?? null,
        actualSha256: actualConfigSha256,
        reason: "Preparation config bytes do not match the prepared manifest SHA-256.",
      };
    } else {
      const parsedConfig = JSON.parse(configFile.bytes.toString("utf8"));
      if (!parsedConfig || parsedConfig.schemaVersion !== "1.0.0" ||
          !parsedConfig.candidate || !parsedConfig.reference) {
        preparationConfigResult = {
          status: "failed",
          path: configFile.path,
          expectedSha256: expectedConfigSha256,
          actualSha256: actualConfigSha256,
          reason: "Hash-pinned preparation config does not match schemaVersion 1.0.0.",
        };
      } else {
        preparationConfig = parsedConfig;
        preparationConfigResult = {
          status: "passed",
          path: configFile.path,
          expectedSha256: expectedConfigSha256,
          actualSha256: actualConfigSha256,
          reason: "The exact preparation config bytes match the recorded SHA-256.",
        };
      }
    }
  } catch (error) {
    preparationConfigResult = {
      status: "failed",
      path: manifest.preparation?.configPath ?? null,
      expectedSha256: manifest.preparation?.configSha256 ?? null,
      actualSha256: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const candidateReplay = replayCandidateGeometry(manifest, preparationConfig, candidateAsset.bytes, actualCandidateSha256);
  const referenceAsset = await safeRead(root, manifest.reference?.sourcePath, "independent reference source");
  const actualReferenceSha256 = sha256(referenceAsset.bytes);
  const referenceHashMatches = SHA256.test(manifest.reference?.sourceSha256 ?? "") &&
    actualReferenceSha256.toLowerCase() === manifest.reference.sourceSha256.toLowerCase();
  const referenceReplay = replayReferenceGeometry(manifest, preparationConfig, referenceAsset.bytes, actualReferenceSha256);

  const metricPrerequisites = [
    { id: "preparation-config-byte-integrity", status: preparationConfigResult.status },
    { id: "candidate-glb-byte-integrity", status: candidateHashMatches ? "passed" : "failed" },
    { id: "reference-source-byte-integrity", status: referenceHashMatches ? "passed" : "failed" },
    { id: "candidate-geometry-replay-from-source-bytes", status: candidateReplay.status },
    { id: "reference-geometry-replay-from-source-bytes", status: referenceReplay.status },
  ];
  const metricGatePassed = metricPrerequisites.every((item) => item.status === "passed");
  const metricGateHardFailure = metricPrerequisites.some((item) => item.status === "failed");
  const metricGateReason = "Geometric metrics were withheld because these exact-source prerequisites did not pass: " +
    metricPrerequisites.filter((item) => item.status !== "passed").map((item) => item.id + "=" + item.status).join(", ") + ".";
  const report = metricGatePassed
    ? evaluateIndependentBuildingTruth(manifest)
    : createMetricWithheldReport(manifest, metricPrerequisites, metricGateReason);
  report.metricComputation = metricGatePassed
    ? { status: "computed-after-source-replay", reason: "Candidate and reference source bytes and both deterministic geometry replays passed before metric computation.", prerequisites: metricPrerequisites }
    : report.metricComputation;
  report.evaluationManifestSha256 = manifestSha256;
  const artifactIntegrity = [];
  if (!metricGatePassed) {
    addArtifactCheck(report, "geometry-metrics-withheld-until-source-replay-passes", false,
      metricGateReason, metricGateHardFailure ? "failed" : "warning");
  }
  artifactIntegrity.push({
    kind: "preparation-config",
    path: preparationConfigResult.path,
    expectedSha256: preparationConfigResult.expectedSha256,
    actualSha256: preparationConfigResult.actualSha256,
    status: preparationConfigResult.status,
    reason: preparationConfigResult.reason,
  });
  addArtifactCheck(report, "preparation-config-byte-integrity",
    preparationConfigResult.status === "passed",
    preparationConfigResult.reason,
    preparationConfigResult.status === "incomplete" ? "warning" : "failed");
  artifactIntegrity.push({ kind: "candidate-glb", path: manifest.candidate.glbPath,
    expectedSha256: manifest.candidate.glbSha256 ?? null, actualSha256: actualCandidateSha256,
    status: candidateHashMatches ? "passed" : "failed" });
  addArtifactCheck(report, "candidate-glb-byte-integrity", candidateHashMatches,
    candidateHashMatches ? "Candidate GLB bytes match the declared SHA-256." :
      "Candidate GLB bytes do not match the declared SHA-256; metrics must not be trusted for this artifact.");

  artifactIntegrity.push({ kind: "independent-reference-source", path: manifest.reference.sourcePath,
    expectedSha256: manifest.reference.sourceSha256 ?? null, actualSha256: actualReferenceSha256,
    status: referenceHashMatches ? "passed" : "failed" });
  addArtifactCheck(report, "reference-source-byte-integrity", referenceHashMatches,
    referenceHashMatches ? "Independent reference-source bytes match the declared SHA-256." :
      "Reference-source bytes do not match the declared SHA-256; independent truth provenance is stale.");

  const extractionReports = {};
  for (const role of ["candidate", "reference"]) {
    const item = role === "candidate" ? manifest.candidate : manifest.reference;
    const sourceHash = role === "candidate" ? actualCandidateSha256 : actualReferenceSha256;
    let payloadSha256 = null;
    try {
      payloadSha256 = geometryPayloadSha256(item);
    } catch (error) {
      addArtifactCheck(report, role + "-geometry-payload-hash", false,
        error instanceof Error ? error.message : String(error));
    }
    const assessment = validateGeometryExtractionProvenance({
      provenance: item.geometryExtractionProvenance,
      sourceSha256: sourceHash,
      geometrySha256: payloadSha256,
      coordinateFrameId: item.coordinateFrameId,
      units: item.units,
      label: role,
    });
    for (const check of assessment.checks) {
      addArtifactCheck(report, check.id, check.status === "passed", check.detail,
        check.status === "warning" ? "warning" : "failed");
    }
    const provenance = assessment.provenance;
    const fileResults = [];
    if (provenance && provenance.extractor) {
      const pinnedFiles = [
        ["extractor-artifact", provenance.extractor.artifactPath, provenance.extractor.artifactSha256],
        ["extractor-configuration", provenance.extractor.configurationPath, provenance.extractor.configurationSha256],
        ...(provenance.auxiliaryArtifacts ?? []).map((artifact) => [
          "auxiliary-artifact-" + artifact.id, artifact.artifactPath, artifact.artifactSha256,
        ]),
      ];
      for (const [kind, relativePath, expectedHash] of pinnedFiles) {
        try {
          const asset = await safeRead(root, relativePath, role + " " + kind);
          const actualHash = sha256(asset.bytes);
          const matches = SHA256.test(expectedHash ?? "") && actualHash.toLowerCase() === expectedHash.toLowerCase();
          const record = { kind, path: relativePath, expectedSha256: expectedHash ?? null,
            actualSha256: actualHash, status: matches ? "passed" : "failed" };
          fileResults.push(record);
          artifactIntegrity.push(record);
          addArtifactCheck(report, role + "-" + kind + "-byte-integrity", matches,
            matches ? role + " " + kind + " bytes match the pinned SHA-256." :
              role + " " + kind + " bytes do not match the declared extraction provenance.");
        } catch (error) {
          const record = { kind, path: relativePath ?? null, expectedSha256: expectedHash ?? null,
            actualSha256: null, status: "failed", error: error instanceof Error ? error.message : String(error) };
          fileResults.push(record);
          artifactIntegrity.push(record);
          addArtifactCheck(report, role + "-" + kind + "-byte-integrity", false,
            record.error);
        }
      }
    }
    const extractorFilesMatch = fileResults.length === 2 + (provenance?.auxiliaryArtifacts?.length ?? 0) &&
      fileResults.every((file) => file.status === "passed");
    const finalExtractionStatus = assessment.status === "failed" || fileResults.some((file) => file.status === "failed")
      ? "failed"
      : assessment.status === "incomplete" || !extractorFilesMatch ? "incomplete" : "passed";
    extractionReports[role] = {
      status: finalExtractionStatus,
      geometryPayloadSha256: payloadSha256,
      provenance: provenance ?? null,
      extractorFiles: fileResults,
    };
  }
  report.geometryExtractionProvenance = extractionReports;
  for (const [role, replay] of [["candidate", candidateReplay], ["reference", referenceReplay]]) {
    const passed = replay.status === "passed";
    const warning = replay.status === "incomplete";
    artifactIntegrity.push({
      kind: role + "-geometry-replay",
      sourceSha256: replay.sourceSha256,
      expectedGeometrySha256: replay.expectedGeometrySha256,
      actualGeometrySha256: replay.actualGeometrySha256,
      status: replay.status,
      reason: replay.reason,
    });
    addArtifactCheck(report, role + "-geometry-replay-from-source-bytes", passed, replay.reason,
      warning ? "warning" : "failed");
  }
  report.geometryReplay = { candidate: candidateReplay, reference: referenceReplay };
  report.assetIntegrity = artifactIntegrity;
  refreshStatus(report);
  const reportRelative = positional[1] ??
    path.join("artifacts", "independent-building-truth", manifest.evaluationId + "-report.json").split(path.sep).join("/");
  const reportPath = await safeOutputPath(root, reportRelative);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    reportPath: path.relative(root, reportPath).split(path.sep).join("/"),
    status: report.status, checks: report.counts.passed, warnings: report.counts.warnings,
    failures: report.counts.failures, acceptanceEligible: false, publicationEligible: false, mapReady: false,
  }, null, 2));
  if (report.status === "benchmark-failed") process.exitCode = 1;
  else if (report.status === "benchmark-incomplete") process.exitCode = 2;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
