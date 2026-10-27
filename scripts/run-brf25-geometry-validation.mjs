#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assessBrf25CandidateBinding } from "../src/core/building-generation/brf25-geometry-validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const RELEASE_FLAGS = ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"];
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
async function resolveInside(root, rawPath, label, { kind = "file", create = false } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw new TypeError(label + " path is required.");
  const resolved = path.resolve(root, rawPath);
  if (!inside(root, resolved)) throw new TypeError(label + " must remain within the project root.");
  const relative = path.relative(root, resolved);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const last = i === parts.length - 1;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new TypeError(label + " path must not traverse a symlink.");
      if (!last && !info.isDirectory()) throw new TypeError(label + " path parent is not a directory.");
      if (last && kind === "file" && !info.isFile()) throw new TypeError(label + " must be a regular file.");
      if (last && kind === "directory" && !info.isDirectory()) throw new TypeError(label + " must be a directory.");
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      await mkdir(current);
    }
  }
  if (create) {
    const finalInfo = await lstat(resolved);
    if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) throw new TypeError(label + " must be a non-symlink directory.");
  }
  const real = await realpath(resolved);
  if (!inside(root, real)) throw new TypeError(label + " resolved outside the project root.");
  return real;
}
async function readJson(root, rawPath, label) {
  const abs = await resolveInside(root, rawPath, label);
  const bytes = await readFile(abs);
  return { abs, bytes, sha256: sha256(bytes), value: JSON.parse(bytes.toString("utf8")) };
}
function runNode(scriptPath, args, root) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60 * 1000,
  });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    error: result.error?.message ?? null,
    stdout: (result.stdout ?? "").slice(-12000),
    stderr: (result.stderr ?? "").slice(-12000),
  };
}
function usage() {
  console.log("Usage: node scripts/run-brf25-geometry-validation.mjs <authorization.json> <truth-config.json> <output-directory> --workspace=<workspace-root> [--root=project-root]\nRevalidates a real BRF-24 candidate binding, then runs actual-GLB extraction and independent-truth evaluation. Output remains review-only; this command does not approve a model.");
}
async function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.find((x) => x.startsWith("--root="));
  const workspaceFlag = argv.find((x) => x.startsWith("--workspace="));
  const positional = argv.filter((x) => !x.startsWith("--root=") && !x.startsWith("--workspace="));
  if (process.argv.includes("--help")) { usage(); return; }
  if (positional.length !== 3 || !workspaceFlag) {
    usage();
    process.exitCode = 2;
    return;
  }

  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const outputAbs = path.resolve(root, positional[2]);
  if (!inside(root, outputAbs)) throw new TypeError("Output directory must be under project root.");
  await resolveInside(root, path.relative(root, outputAbs), "Output directory", { kind: "directory", create: true });
  const reportAbs = path.join(outputAbs, "brf25-geometry-validation.json");
  try {
    await lstat(reportAbs);
    throw new TypeError("Refusing to overwrite existing BRF-25 report; select a fresh output directory.");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }

  const report = {
    schemaVersion: "1.0.0",
    recordType: "brf-25-geometry-validation",
    status: "blocked",
    generatedAt: new Date().toISOString(),
    checks: [],
    blockers: [],
    artifacts: {},
    visualReview: { status: "pending-human-review", acceptanceEligible: false },
    policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false },
    limitations: [
      "This runner orchestrates actual GLB geometry extraction and independent-truth metrics only after BRF-24 produced a hash-bound candidate.",
      "A benchmark-review-required result is not a final PASS; source-camera visual review and human review remain separate required gates.",
      "Neither source hashes nor an evaluator report authenticate survey provenance or licence claims independently.",
      "Candidate generation and geometry metrics never enable publication or map readiness.",
    ],
  };

  const workspaceRaw = workspaceFlag.slice("--workspace=".length);
  const workspaceRoot = await resolveInside(root, workspaceRaw, "Workspace", { kind: "directory" });
  const authorization = await readJson(root, positional[0], "Authorization");
  const config = await readJson(root, positional[1], "Truth-evaluation config");
  report.artifacts.authorization = { path: path.relative(root, authorization.abs).split(path.sep).join("/"), sha256: authorization.sha256 };
  report.artifacts.truthConfig = { path: path.relative(root, config.abs).split(path.sep).join("/"), sha256: config.sha256 };

  const authRecord = authorization.value;
  const relativeGlb = authRecord?.candidateGlb?.relativePath;
  if (typeof relativeGlb !== "string" || path.isAbsolute(relativeGlb)) {
    report.blockers.push({ id: "authorized-candidate-path", detail: "BRF-24 record has no safe workspace-relative candidate GLB path." });
    report.checks.push({ id: "authorized-candidate-path", status: "blocked" });
    await writeFile(reportAbs, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.exitCode = 2;
    return;
  }

  const candidatePath = await resolveInside(root, path.relative(root, path.resolve(workspaceRoot, relativeGlb)), "Candidate GLB");
  const candidateBytes = await readFile(candidatePath);
  const configValue = config.value;
  const configuredCandidatePath = typeof configValue?.candidate?.glbPath === "string"
    ? path.resolve(root, configValue.candidate.glbPath) : "";
  const binding = assessBrf25CandidateBinding({
    authorization: authRecord,
    candidateSha256: sha256(candidateBytes),
    candidateByteSize: candidateBytes.byteLength,
    workspaceRoot,
    configuredCandidatePath,
    expectedGlbSha256: configValue?.candidate?.expectedGlbSha256,
  });
  report.checks.push(...binding.checks);
  report.binding = binding.binding;
  if (!binding.ready) {
    report.status = "blocked";
    report.blockers.push(...binding.blockers);
    await writeFile(reportAbs, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.exitCode = 2;
    return;
  }

  const evaluationId = configValue?.evaluationId;
  if (typeof evaluationId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(evaluationId)) {
    throw new TypeError("Truth config evaluationId must be a safe ID.");
  }
  const outputRel = path.relative(root, outputAbs).split(path.sep).join("/");
  const preparedRel = outputRel + "/prepared-manifest.json";
  const evalRel = outputRel + "/evaluation-report.json";
  for (const rel of [preparedRel, evalRel]) {
    try { await lstat(path.resolve(root, rel)); throw new TypeError("Refusing to overwrite existing output artifact: " + rel); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  const prepareScript = await resolveInside(root, "scripts/prepare-independent-building-truth-manifest.mjs", "Geometry preparation CLI");
  const prepareRun = runNode(prepareScript, [positional[1], preparedRel, "--root=" + root], root);
  report.steps = [{ id: "actual-glb-extraction-and-reference-adaptation", ...prepareRun }];
  if (prepareRun.exitCode !== 0) {
    report.status = "geometry-extraction-failed";
    report.blockers.push({ id: "actual-glb-extraction-and-reference-adaptation", detail: prepareRun.error || prepareRun.stderr || "Preparation CLI failed." });
    await writeFile(reportAbs, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.exitCode = 1;
    return;
  }
  const prepared = await readJson(root, preparedRel, "Prepared geometry manifest");
  if (prepared.value.preparation?.exactCandidateGlbSha256?.toLowerCase() !== binding.binding.candidateGlbSha256) {
    report.status = "geometry-extraction-failed";
    report.blockers.push({ id: "prepared-candidate-hash", detail: "Prepared manifest does not bind to the authorized candidate GLB bytes." });
    report.artifacts.preparedManifest = { path: preparedRel, sha256: prepared.sha256 };
    await writeFile(reportAbs, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.exitCode = 1;
    return;
  }
  report.artifacts.preparedManifest = { path: preparedRel, sha256: prepared.sha256,
    candidateGlbSha256: prepared.value.preparation.exactCandidateGlbSha256,
    independentReferenceSha256: prepared.value.preparation.exactReferenceSourceSha256,
    extractedHeldOutCheckpointCount: prepared.value.preparation.extractedHeldOutCheckPointCount ?? null };

  const evaluateScript = await resolveInside(root, "scripts/evaluate-independent-building-truth.mjs", "Independent-truth evaluator CLI");
  const evaluateRun = runNode(evaluateScript, [preparedRel, evalRel, "--root=" + root], root);
  report.steps.push({ id: "independent-truth-evaluation", ...evaluateRun });
  if (![0, 1, 2].includes(evaluateRun.exitCode)) {
    report.status = "independent-evaluation-failed";
    report.blockers.push({ id: "independent-truth-evaluation", detail: evaluateRun.error || "Evaluator subprocess did not return a normal exit code." });
    await writeFile(reportAbs, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.exitCode = 1;
    return;
  }
  const evaluation = await readJson(root, evalRel, "Independent-truth evaluation report");
  report.artifacts.evaluationReport = { path: evalRel, sha256: evaluation.sha256 };
  const evalValue = evaluation.value;
  const reportCandidateHash = evalValue.candidate?.glbSha256;
  const policySafe = object(evalValue.policy) && RELEASE_FLAGS.every((flag) => evalValue.policy[flag] === false);
  const evaluatedHashMatches = SHA256.test(reportCandidateHash ?? "") &&
    reportCandidateHash.toLowerCase() === binding.binding.candidateGlbSha256;
  report.checks.push({ id: "evaluation-candidate-hash", status: evaluatedHashMatches ? "passed" : "failed" });
  report.checks.push({ id: "evaluation-release-flags-remain-false", status: policySafe ? "passed" : "failed" });
  if (!evaluatedHashMatches || !policySafe) {
    report.status = "independent-evaluation-failed";
    report.blockers.push({ id: "evaluation-integrity", detail: "Evaluation report hash binding or release-flag invariants failed." });
    report.exitCode = 1;
  } else if (evalValue.status === "benchmark-failed" || evaluateRun.exitCode === 1) {
    report.status = "geometry-evaluation-failed";
    report.exitCode = 1;
  } else if (evalValue.status === "benchmark-incomplete" || evaluateRun.exitCode === 2) {
    report.status = "geometry-evaluation-incomplete";
    report.exitCode = 2;
  } else if (evalValue.status === "benchmark-review-required") {
    report.status = "geometry-evaluated-review-required";
    report.exitCode = 2;
  } else {
    report.status = "blocked";
    report.exitCode = 2;
    report.blockers.push({ id: "unexpected-evaluator-status", detail: "Evaluator status is not an accepted evidence-only state." });
  }
  report.evaluation = {
    status: evalValue.status ?? "unknown",
    counts: evalValue.counts ?? null,
    failures: evalValue.failures ?? [],
    warnings: evalValue.warnings ?? [],
    policy: evalValue.policy ?? null,
  };
  report.finalDisposition = "REVIEW-REQUIRED";
  report.policy = { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false };
  await writeFile(reportAbs, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ report: path.relative(root, reportAbs).split(path.sep).join("/"),
    status: report.status, candidateGlbSha256: binding.binding.candidateGlbSha256,
    acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false }, null, 2));
  process.exitCode = report.exitCode;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
