import assert from "node:assert/strict";

const SERVER_TIMING_FIELDS = [
  "totalServerMs",
  "tileQueryMs",
  "manifestLookupMs",
  "tileIndexReadAndParseMs",
  "candidateMetadataScanMs",
  "oversizedSidecarReadMs",
  "featureSelectionMs",
  "selectedGeometryReadMs",
  "geometryRangePlanningMs",
  "geometryFileOpenMs",
  "geometryRangeReadMs",
  "geometryJsonParseMs",
  "geometryIntegrityCheckMs",
  "geometryFileCloseMs",
  "geometryReadMs",
  "featureAssemblyMs",
  "fallbackGeoJsonPreparationMs",
  "roleClassificationMs",
  "responseSerializationMs",
];

function validateServerTimings(value, label) {
  assert.ok(value && typeof value === "object", label + " requires server phase timing metrics");
  for (const field of SERVER_TIMING_FIELDS) {
    assert.equal(typeof value[field], "number", label + "." + field + " must be numeric");
    assert.ok(Number.isFinite(value[field]) && value[field] >= 0,
      label + "." + field + " must be finite and nonnegative");
  }
}

export function quantile(values, fraction) {
  assert.ok(Array.isArray(values) && values.length > 0, "quantile requires at least one sample");
  assert.ok(Number.isFinite(fraction) && fraction >= 0 && fraction <= 1, "quantile fraction must be in [0, 1]");
  const ordered = [...values].map(Number).sort((a, b) => a - b);
  assert.ok(ordered.every(Number.isFinite), "quantile values must be finite");
  const position = (ordered.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const value = ordered[lowerIndex] + (ordered[upperIndex] - ordered[lowerIndex]) * (position - lowerIndex);
  return Number(value.toFixed(2));
}

export function summarizeLatency(values) {
  assert.ok(Array.isArray(values) && values.length > 0, "latency summary requires at least one sample");
  const ordered = [...values].map(Number).sort((a, b) => a - b);
  assert.ok(ordered.every((value) => Number.isFinite(value) && value >= 0), "latency values must be finite and nonnegative");
  const medianMs = quantile(ordered, 0.5);
  const absoluteDeviations = ordered.map((value) => Math.abs(value - medianMs));
  const meanMs = ordered.reduce((sum, value) => sum + value, 0) / ordered.length;
  const variance = ordered.reduce((sum, value) => sum + (value - meanMs) ** 2, 0) / ordered.length;
  const standardDeviationMs = Math.sqrt(variance);
  return {
    sampleCount: ordered.length,
    minMs: Number(ordered[0].toFixed(2)),
    p25Ms: quantile(ordered, 0.25),
    medianMs,
    p75Ms: quantile(ordered, 0.75),
    iqrMs: Number((quantile(ordered, 0.75) - quantile(ordered, 0.25)).toFixed(2)),
    p95Ms: quantile(ordered, 0.95),
    maxMs: Number(ordered.at(-1).toFixed(2)),
    rangeMs: Number((ordered.at(-1) - ordered[0]).toFixed(2)),
    medianAbsoluteDeviationMs: quantile(absoluteDeviations, 0.5),
    meanMs: Number(meanMs.toFixed(2)),
    standardDeviationMs: Number(standardDeviationMs.toFixed(2)),
    coefficientOfVariationPercent: meanMs > 0
      ? Number((standardDeviationMs / meanMs * 100).toFixed(2))
      : null,
    interpretation: "Descriptive latency statistics only; do not treat observations from one CI runner as independent runs across different days or machines.",
  };
}

function assertSame(actual, expected, label) {
  assert.deepEqual(actual, expected, label + " changed across fresh-process samples");
}

export function buildRepeatabilityReport(sampleReports, metadata = {}) {
  assert.ok(Array.isArray(sampleReports) && sampleReports.length >= 3,
    "at least three fresh-process samples are required");
  const first = sampleReports[0];
  assert.equal(first.benchmark, "p2.11-controlled-cold-warm-viewport");
  const manifestSha256 = first.spatialTileManifestSha256;
  assert.match(manifestSha256 ?? "", /^[a-f0-9]{64}$/i, "sample must include a spatial tile manifest SHA-256");

  const exactColdFields = [
    "statusCode", "selectedTileCount", "candidateFeatureCount", "matchedFeatureCount",
    "returnedFeatureCount", "candidatePayloadBytes", "indexReadBytes", "featureReadBytes",
    "combinedReadBytes", "combinedReadReductionRatio", "fetchedFeatureCount", "featureLimit", "featureSha256",
  ];

  const samples = sampleReports.map((report, index) => {
    const label = "fresh process sample " + (index + 1);
    assert.equal(report.benchmark, first.benchmark, label + " has unexpected benchmark identifier");
    assertSame(report.spatialTileManifestSha256, manifestSha256, label + " manifest");
    assertSame(report.viewport?.boundsSha256, first.viewport?.boundsSha256, label + " viewport");
    assertSame(report.viewport?.featureLimit, first.viewport?.featureLimit, label + " feature limit");
    if (first.candidateSha && report.candidateSha) assertSame(report.candidateSha, first.candidateSha, label + " candidate SHA");

    assert.ok(report.cold && report.warm && Array.isArray(report.runObservations), label + " is missing observations");
    validateServerTimings(report.cold.serverTimingsMs, label + " cold server timings");
    assert.ok(Number.isFinite(report.cold.elapsedMs) && report.cold.elapsedMs >= 0, label + " cold latency is invalid");
    assert.ok(report.cold.indexReadBytes > 0, label + " must read the tile index on its first valid request");
    assert.ok(report.cold.candidatePayloadBytes > 0, label + " candidate baseline must be nonzero");
    assert.ok(report.cold.returnedFeatureCount > 0, label + " must return actual building features");
    assert.equal(report.warm.totalIndexReadBytes, 0, label + " warm requests must not reread the compact index");
    assert.equal(report.warm.allIndexReadsServedFromMemory, true, label + " cache assertion must pass");
    assert.equal(report.warm.allFeatureHashesMatchCold, true, label + " warm feature hashes must match cold");
    assert.ok(report.runObservations.length >= 4, label + " must include cold plus at least three warm observations");

    for (const field of exactColdFields) assertSame(report.cold[field], first.cold[field], label + " cold." + field);
    const warmObservations = report.runObservations.filter((sample) => sample.phase === "warm-repeat");
    assert.ok(warmObservations.length >= 3, label + " must include repeated warm samples");
    for (const [warmIndex, observation] of warmObservations.entries()) {
      validateServerTimings(observation.serverTimingsMs, label + " warm observation " + (warmIndex + 1));
    }
    assert.ok(warmObservations.every((sample) => sample.indexReadBytes === 0), label + " warm observations must have zero index reads");
    assert.ok(warmObservations.every((sample) => sample.featureSha256 === report.cold.featureSha256),
      label + " every warm hash must match its cold response");

    return {
      sampleIndex: index + 1,
      candidateSha: report.candidateSha ?? null,
      spatialTileManifestSha256: report.spatialTileManifestSha256,
      viewportBoundsSha256: report.viewport.boundsSha256,
      cold: {
        elapsedMs: report.cold.elapsedMs,
        serverTimingsMs: report.cold.serverTimingsMs,
        indexReadBytes: report.cold.indexReadBytes,
        featureReadBytes: report.cold.featureReadBytes,
        candidatePayloadBytes: report.cold.candidatePayloadBytes,
        combinedReadReductionRatio: report.cold.combinedReadReductionRatio,
        selectedTileCount: report.cold.selectedTileCount,
        returnedFeatureCount: report.cold.returnedFeatureCount,
        featureSha256: report.cold.featureSha256,
      },
      warm: {
        requestCount: warmObservations.length,
        medianResponseMs: report.warm.medianResponseMs,
        p95ResponseMs: report.warm.p95ResponseMs,
        minResponseMs: report.warm.minResponseMs,
        maxResponseMs: report.warm.maxResponseMs,
        totalIndexReadBytes: report.warm.totalIndexReadBytes,
        totalGeometryReadBytes: report.warm.totalGeometryReadBytes,
        meanGeometryPayloadReductionRatio: report.warm.meanGeometryPayloadReductionRatio,
        serverTimingMsByPhase: Object.fromEntries(SERVER_TIMING_FIELDS.map((field) => [
          field,
          summarizeLatency(warmObservations.map((sample) => sample.serverTimingsMs[field])),
        ])),
        serverTimingObservationsMs: warmObservations.map((sample) => sample.serverTimingsMs),
        responseLatenciesMs: warmObservations.map((sample) => sample.elapsedMs),
      },
    };
  });

  const coldLatencies = samples.map((sample) => sample.cold.elapsedMs);
  const warmPerProcessMedians = samples.map((sample) => sample.warm.medianResponseMs);
  const pooledWarmLatencies = samples.flatMap((sample) => sample.warm.responseLatenciesMs);
  const coldGeometryBytes = samples.map((sample) => sample.cold.featureReadBytes);
  const warmGeometryBytes = samples.map((sample) => sample.warm.totalGeometryReadBytes);
  const coldServerPhaseSamples = Object.fromEntries(SERVER_TIMING_FIELDS.map((field) => [
    field,
    summarizeLatency(sampleReports.map((report) => report.cold.serverTimingsMs[field])),
  ]));
  const pooledWarmServerPhaseSamples = Object.fromEntries(SERVER_TIMING_FIELDS.map((field) => [
    field,
    summarizeLatency(sampleReports.flatMap((report) => report.runObservations
      .filter((observation) => observation.phase === "warm-repeat")
      .map((observation) => observation.serverTimingsMs[field]))),
  ]));
  const candidateShaValues = [...new Set(samples.map((sample) => sample.candidateSha).filter(Boolean))];
  assert.ok(candidateShaValues.length <= 1, "fresh-process samples must belong to the same candidate SHA");

  return {
    benchmark: "p2.15-fresh-process-viewport-latency-repeatability",
    generatedAt: metadata.generatedAt ?? new Date().toISOString(),
    candidateSha: candidateShaValues[0] ?? null,
    environment: {
      node: metadata.nodeVersion ?? process.version,
      platform: metadata.platform ?? process.platform,
      architecture: metadata.architecture ?? process.arch,
      independentFreshProcessCount: samples.length,
      warmRequestsPerProcess: Math.min(...samples.map((sample) => sample.warm.requestCount)),
    },
    dataset: {
      spatialTileManifestSha256: manifestSha256,
      viewportBoundsSha256: first.viewport.boundsSha256,
      featureLimit: first.viewport.featureLimit,
      sameOrderedFeatureHashAcrossProcesses: true,
      orderedFeatureSha256: first.cold.featureSha256,
      deterministicColdMetricsMatchAcrossProcesses: true,
    },
    latency: {
      coldFirstValidRequestMs: summarizeLatency(coldLatencies),
      perProcessWarmMedianMs: summarizeLatency(warmPerProcessMedians),
      pooledWarmRequestMs: summarizeLatency(pooledWarmLatencies),
      note: "Pooled warm observations are clustered within fresh processes; the per-process warm-median distribution is the more conservative unit for process-to-process variability. Millisecond values are not hard-gated.",
    },
    serverPhaseTiming: {
      coldFirstRequestMsByPhase: coldServerPhaseSamples,
      pooledWarmRequestMsByPhase: pooledWarmServerPhaseSamples,
      phaseScope: "Reported by the API using node:perf_hooks. Selected-geometry subphases measure range planning, file open, range reads, per-feature JSON parse, integrity checks and file close; these are nested within selectedGeometryReadMs. Other tile subphases measure manifest lookup, tile index access/parsing, candidate metadata scans, sidecar reads, selection and assembly; route phases report fallback preparation, role classification and JSON serialization.",
      caveat: "Phase timings are component-level diagnostics. Framework/network overhead is not fully represented, and the geometryReadMs aggregate includes sidecar plus selected tile geometry read time.",
    },
    byteCost: {
      coldGeometryReadBytes: {
        sampleCount: coldGeometryBytes.length,
        samples: coldGeometryBytes,
        allEqual: new Set(coldGeometryBytes).size === 1,
      },
      warmGeometryReadBytesAcrossEachProcess: {
        sampleCount: warmGeometryBytes.length,
        samples: warmGeometryBytes,
        allEqual: new Set(warmGeometryBytes).size === 1,
      },
      coldIndexReadBytes: samples.map((sample) => sample.cold.indexReadBytes),
      warmIndexReadBytes: samples.map((sample) => sample.warm.totalIndexReadBytes),
      sameColdGeometryBytesAcrossProcesses: new Set(coldGeometryBytes).size === 1,
      sameWarmGeometryBytesAcrossProcesses: new Set(warmGeometryBytes).size === 1,
      coldIndexReadsVerified: samples.every((sample) => sample.cold.indexReadBytes > 0),
      zeroWarmIndexReadsVerified: samples.every((sample) => sample.warm.totalIndexReadBytes === 0),
    },
    samples,
    limitations: [
      "Samples are collected sequentially on one CI runner and share one build, filesystem and potentially the operating-system page cache.",
      "Four fresh process samples describe within-run variability; they are not four separate CI jobs or independent machines.",
      "Latency covers client-observed viewport request through response-body download, not map startup time or GPU render time.",
      "Byte counters are application-reported reads, not physical disk I/O.",
    ],
  };
}
