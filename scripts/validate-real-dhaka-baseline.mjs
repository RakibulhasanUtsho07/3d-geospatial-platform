#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const EXPECTED_RUNS = [
  ...[1, 2, 3].map((index) => ({ mode: "cold", index })),
  ...[1, 2, 3].map((index) => ({ mode: "warm", index })),
];
const REQUIRED_DATA_INPUTS = [
  "data/overture/spatial-tiles/manifest.json",
  "data/overture/dhaka-buildings-3d-pilot.geojson",
  "public/data/roads/dhaka-road-network-v1.json",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(errors, message) {
  errors.push(message);
}

function validateDataInput(entry, errors) {
  if (!isRecord(entry) || typeof entry.path !== "string") {
    addError(errors, "A data input record is missing its path.");
    return;
  }
  if (entry.exists === true) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      addError(errors, "Existing data input has invalid byte count or SHA-256: " + entry.path);
    }
    return;
  }
  if (entry.exists === false && entry.bytes === null && entry.sha256 === null) return;
  addError(errors, "Data input must contain a valid hash or an explicit missing-input marker: " + entry.path);
}

export function validateRealDhakaBaselineReport(report, options = {}) {
  const errors = [];
  const expectedCommitSha = options.expectedCommitSha;
  const screenshotShaByPath = options.screenshotShaByPath ?? {};

  if (!isRecord(report)) return ["Baseline report must be a JSON object."];
  if (report.schemaVersion !== 1 || report.benchmark !== "real-dhaka-map-performance-baseline") {
    addError(errors, "Report schema or benchmark identifier is not supported.");
  }
  if (typeof expectedCommitSha !== "string" || !COMMIT_SHA.test(expectedCommitSha)) {
    addError(errors, "An expected 40-character candidate commit SHA is required.");
  } else if (report.candidate?.gitCommitSha !== expectedCommitSha) {
    addError(errors, "Report candidate SHA does not match the workflow commit SHA.");
  }
  if (!isRecord(report.candidate) || !Array.isArray(report.candidate.dataInputs)) {
    addError(errors, "Candidate metadata or dataInputs are missing.");
  } else {
    for (const requiredPath of REQUIRED_DATA_INPUTS) {
      const matches = report.candidate.dataInputs.filter((entry) => entry?.path === requiredPath);
      if (matches.length !== 1) {
        addError(errors, "Expected exactly one data-input record for " + requiredPath + ".");
        continue;
      }
      validateDataInput(matches[0], errors);
      if (requiredPath === "public/data/roads/dhaka-road-network-v1.json" && matches[0].exists !== true) {
        addError(errors, "Bundled Dhaka road extract must exist and be hashed for this baseline.");
      }
    }
  }

  if (!Array.isArray(report.runs)) {
    addError(errors, "The report runs field must be an array.");
    return errors;
  }
  if (report.runs.length !== EXPECTED_RUNS.length) {
    addError(errors, "Exactly six measured runs (three cold and three warm) are required.");
  }

  if (!isRecord(report.summary)) {
    addError(errors, "Cold/warm summary metadata is missing.");
  } else {
    for (const mode of ["cold", "warm"]) {
      const summary = report.summary[mode];
      if (!isRecord(summary) || summary.totalRuns !== 3 || summary.successfulRuns !== 3 || summary.failedRuns !== 0) {
        addError(errors, "The " + mode + " summary must contain three successful runs and zero failures.");
      }
    }
  }

  const seen = new Set();
  for (const expected of EXPECTED_RUNS) {
    const label = expected.mode + "-" + String(expected.index).padStart(2, "0");
    const matches = report.runs.filter((run) => run?.mode === expected.mode && run?.index === expected.index);
    if (matches.length !== 1) {
      addError(errors, "Expected exactly one measured sample " + label + ".");
      continue;
    }
    const run = matches[0];
    seen.add(label);
    if (run.status !== "ok") addError(errors, label + " did not complete successfully.");
    if (!isRecord(run.readiness)
        || run.readiness.canvasCount < 1
        || run.readiness.viewportStageSuccessCount < 1
        || run.readiness.stagedFeatureCount < 1) {
      addError(errors, label + " does not prove a successful viewport stage with real building features.");
    }
    if (!isRecord(run.roadReadiness)
        || run.roadReadiness.status !== "rendered"
        || !Number.isFinite(run.roadReadiness.renderedFeatureCount)
        || run.roadReadiness.renderedFeatureCount <= 0) {
      addError(errors, label + " does not prove that a non-empty road layer rendered.");
    }
    const roadApi = run.network?.roadApi;
    if (!isRecord(roadApi)) {
      addError(errors, label + " is missing road API telemetry.");
    } else {
      if (roadApi.pendingRequestsAtCapture !== 0) addError(errors, label + " has pending road requests at screenshot capture.");
      if (!(roadApi.detailLevelResponses?.offline > 0)) addError(errors, label + " did not record an offline road API response.");
      if (!(roadApi.sourceResponses?.["local-extract"] > 0)) addError(errors, label + " did not record the bundled local extract as its source.");
      if (roadApi.upstreamAttempts?.total !== 0) addError(errors, label + " unexpectedly attempted an upstream Overpass request.");
    }

    const screenshot = run.screenshot;
    if (!isRecord(screenshot)
        || typeof screenshot.path !== "string"
        || !Number.isSafeInteger(screenshot.bytes)
        || screenshot.bytes <= 0
        || typeof screenshot.sha256 !== "string"
        || !SHA256.test(screenshot.sha256)) {
      addError(errors, label + " has an invalid screenshot manifest.");
    } else {
      if (path.isAbsolute(screenshot.path) || screenshot.path.split(/[\\/]/).includes("..")) {
        addError(errors, label + " screenshot path is not a safe project-relative path.");
      }
      if (typeof screenshotShaByPath[screenshot.path] !== "string") {
        addError(errors, label + " screenshot file was not read for digest verification.");
      } else if (screenshotShaByPath[screenshot.path].toLowerCase() !== screenshot.sha256.toLowerCase()) {
        addError(errors, label + " screenshot SHA-256 does not match the actual PNG bytes.");
      }
    }
  }

  if (seen.size !== EXPECTED_RUNS.length) addError(errors, "The report does not contain all six unique cold/warm samples.");
  const screenshotPaths = report.runs
    .filter((run) => typeof run?.screenshot?.path === "string")
    .map((run) => run.screenshot.path);
  if (new Set(screenshotPaths).size !== EXPECTED_RUNS.length) {
    addError(errors, "Each measured sample must have its own unique screenshot file.");
  }
  return errors;
}

async function main(argv) {
  const reportArgument = argv.find((argument) => !argument.startsWith("--"));
  const expectedArgument = argv.find((argument) => argument.startsWith("--expected-commit-sha="));
  const expectedCommitSha = expectedArgument?.slice("--expected-commit-sha=".length);
  if (!reportArgument || !expectedCommitSha) {
    throw new Error("Usage: node scripts/validate-real-dhaka-baseline.mjs <report.json> --expected-commit-sha=<sha>");
  }

  const reportPath = path.resolve(projectRoot, reportArgument);
  const relativeReportPath = path.relative(projectRoot, reportPath);
  if (!relativeReportPath || relativeReportPath.startsWith("..") || path.isAbsolute(relativeReportPath)) {
    throw new Error("Report path must be inside the repository.");
  }
  const reportDirectory = path.dirname(reportPath);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const screenshotShaByPath = Object.create(null);
  const referencedPaths = new Set((Array.isArray(report.runs) ? report.runs : [])
    .map((run) => run?.screenshot?.path)
    .filter((value) => typeof value === "string"));

  for (const relativePath of referencedPaths) {
    const screenshotPath = path.resolve(projectRoot, relativePath);
    if (path.dirname(screenshotPath) !== reportDirectory) {
      throw new Error("Screenshot must be stored beside report.json: " + relativePath);
    }
    const bytes = await readFile(screenshotPath);
    screenshotShaByPath[relativePath] = createHash("sha256").update(bytes).digest("hex");
  }

  const errors = validateRealDhakaBaselineReport(report, { expectedCommitSha, screenshotShaByPath });
  if (errors.length > 0) {
    console.error(JSON.stringify({ valid: false, errors }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    valid: true,
    candidateSha: report.candidate.gitCommitSha,
    coldSamples: report.summary.cold.successfulRuns,
    warmSamples: report.summary.warm.successfulRuns,
    roadReadinessCounts: {
      cold: report.summary.cold.roadReadinessCounts,
      warm: report.summary.warm.roadReadinessCounts,
    },
    verifiedScreenshots: referencedPaths.size,
    roadExtract: report.candidate.dataInputs.find((entry) => entry.path === "public/data/roads/dhaka-road-network-v1.json"),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("[Real-Dhaka Baseline] Validation failed:", error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
