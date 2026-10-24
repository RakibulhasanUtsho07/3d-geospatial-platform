import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const runAPath = resolve(
  process.cwd(),
  process.env.P2_12_RUN_A_REPORT ?? "test-results/p2-12-run-a.json",
);
const runBPath = resolve(
  process.cwd(),
  process.env.P2_12_RUN_B_REPORT ?? "test-results/p2-12-run-b.json",
);

async function readReport(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("Could not read cold/warm benchmark report at " + path + ": " + String(error));
  }
  assert.equal(parsed.benchmark, "p2.11-controlled-cold-warm-viewport");
  assert.ok(parsed.cold && parsed.warm && parsed.viewport && parsed.spatialTileManifestSha256);
  return parsed;
}

function assertSame(actual, expected, field, label) {
  assert.deepEqual(
    actual,
    expected,
    label + ": deterministic field '" + field + "' changed across fresh server processes",
  );
}

const [runA, runB] = await Promise.all([readReport(runAPath), readReport(runBPath)]);

assertSame(runA.viewport.boundsSha256, runB.viewport.boundsSha256, "viewport.boundsSha256", "cross-process guard");
assertSame(runA.viewport.featureLimit, runB.viewport.featureLimit, "viewport.featureLimit", "cross-process guard");
assertSame(runA.spatialTileManifestSha256, runB.spatialTileManifestSha256, "spatialTileManifestSha256", "cross-process guard");

const deterministicColdFields = [
  "statusCode",
  "selectedTileCount",
  "candidateFeatureCount",
  "matchedFeatureCount",
  "returnedFeatureCount",
  "candidatePayloadBytes",
  "indexReadBytes",
  "featureReadBytes",
  "combinedReadBytes",
  "combinedReadReductionRatio",
  "fetchedFeatureCount",
  "featureLimit",
  "featureSha256",
];
for (const field of deterministicColdFields) {
  assertSame(runA.cold[field], runB.cold[field], "cold." + field, "cross-process guard");
}
assert.ok(runA.cold.indexReadBytes > 0, "run A cold request must read the compact tile index");
assert.ok(runB.cold.indexReadBytes > 0, "run B cold request must read the compact tile index");
assert.ok(runA.cold.candidatePayloadBytes > 0 && runB.cold.candidatePayloadBytes > 0);
assert.ok(runA.cold.featureReadBytes < runA.cold.candidatePayloadBytes);
assert.ok(runB.cold.featureReadBytes < runB.cold.candidatePayloadBytes);
assert.ok(runA.cold.combinedReadBytes < runA.cold.candidatePayloadBytes);
assert.ok(runB.cold.combinedReadBytes < runB.cold.candidatePayloadBytes);
assert.ok(runA.cold.fetchedFeatureCount <= runA.cold.featureLimit);
assert.ok(runB.cold.fetchedFeatureCount <= runB.cold.featureLimit);

for (const [label, report] of [["run A", runA], ["run B", runB]]) {
  assert.equal(report.warm.allIndexReadsServedFromMemory, true, label + " warm requests must reuse the parsed index");
  assert.equal(report.warm.allFeatureHashesMatchCold, true, label + " warm response hashes must match its cold response");
  assert.equal(report.warm.totalIndexReadBytes, 0, label + " must not reread compact indexes during warm repeats");
  assert.ok(report.warm.requestCount >= 3, label + " must include repeated warm requests");
  assert.ok((report.warm.meanGeometryPayloadReductionRatio ?? 0) > 0);
  assert.ok(
    report.runObservations.every((sample) => sample.featureSha256 === report.cold.featureSha256),
    label + " every repeated response must preserve the ordered feature hash",
  );
}

assertSame(runA.warm.totalGeometryReadBytes, runB.warm.totalGeometryReadBytes, "warm.totalGeometryReadBytes", "cross-process guard");
assertSame(runA.warm.totalCandidatePayloadBaselineBytes, runB.warm.totalCandidatePayloadBaselineBytes, "warm.totalCandidatePayloadBaselineBytes", "cross-process guard");
assertSame(runA.warm.meanGeometryPayloadReductionRatio, runB.warm.meanGeometryPayloadReductionRatio, "warm.meanGeometryPayloadReductionRatio", "cross-process guard");
assertSame(runA.warm.requestCount, runB.warm.requestCount, "warm.requestCount", "cross-process guard");

const round = (value) => Number(value.toFixed(2));
const latency = {
  runA: {
    coldMs: runA.cold.elapsedMs,
    warmMedianMs: runA.warm.medianResponseMs,
    warmP95Ms: runA.warm.p95ResponseMs,
  },
  runB: {
    coldMs: runB.cold.elapsedMs,
    warmMedianMs: runB.warm.medianResponseMs,
    warmP95Ms: runB.warm.p95ResponseMs,
  },
  coldDifferenceMs: round(runB.cold.elapsedMs - runA.cold.elapsedMs),
  warmMedianDifferenceMs: round(runB.warm.medianResponseMs - runA.warm.medianResponseMs),
  note: "Latency is reported for trend review but not hard-gated because hosted-runner scheduling and OS caches are noisy. Deterministic bytes, feature selection, index-cache behavior, and response hashes are hard-gated.",
};

const result = {
  benchmark: "p2.12-cross-process-viewport-regression-guard",
  generatedAt: new Date().toISOString(),
  candidateSha: process.env.GITHUB_SHA ?? null,
  sameSpatialTileManifest: runA.spatialTileManifestSha256 === runB.spatialTileManifestSha256,
  sameOrderedFeatureHash: runA.cold.featureSha256 === runB.cold.featureSha256,
  deterministicMetricsMatch: true,
  coldIndexReadsVerifiedOnBothProcesses: true,
  zeroWarmIndexReadsVerifiedOnBothProcesses: true,
  featureBudgetVerifiedOnBothProcesses: true,
  latency,
  evidence: {
    runA: {
      spatialTileManifestSha256: runA.spatialTileManifestSha256,
      cold: Object.fromEntries(deterministicColdFields.map((field) => [field, runA.cold[field]])),
      warm: runA.warm,
    },
    runB: {
      spatialTileManifestSha256: runB.spatialTileManifestSha256,
      cold: Object.fromEntries(deterministicColdFields.map((field) => [field, runB.cold[field]])),
      warm: runB.warm,
    },
  },
  limitations: [
    "Two fresh Next.js production processes run against the same generated spatial-tile build; this tests process-cache repeatability, not independent build reproducibility.",
    "Byte counts are application-reported reads and a whole-selected-tile payload baseline, not physical disk I/O.",
    "Latency differences are informational rather than a hard failure threshold.",
  ],
};

const outputPath = resolve(
  process.cwd(),
  process.env.P2_12_GUARD_REPORT_PATH ?? "test-results/p2-12-cold-warm-regression-guard.json",
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log("[P2.12 cross-process viewport regression guard]", JSON.stringify(result));
