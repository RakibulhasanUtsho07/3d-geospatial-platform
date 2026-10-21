const SEVERITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function finding(code, category, severity, title, summary, recommendation, evidence = {}) {
  return { code, category, severity, title, summary, recommendation, evidence };
}

function severityForMeshWarnings(warnings, quality) {
  if (warnings.includes("degenerate-triangle-ratio-exceeds-threshold")
      || warnings.includes("non-manifold-edges-present")
      || quality?.valid === false) return "high";
  if (warnings.some((warning) => [
    "long-triangle-edges-present",
    "disconnected-mesh-components-present",
    "small-detached-components-present",
    "topology-analysis-skipped-vertex-limit",
    "no-texture-atlas-embedded-or-declared",
    "no-materials-declared",
    "external-resources-referenced",
  ].includes(warning))) return "medium";
  return "low";
}

function makeGeometrySnapshot(quality) {
  const details = Array.isArray(quality?.meshDetails) ? quality.meshDetails : [];
  const analyzed = details.filter((item) => item?.topology?.topologyAnalyzed === true);
  const skipped = details.filter((item) => item?.topology?.topologyAnalyzed === false);
  const longEdgeTriangleCount = details.reduce((sum, item) => sum + (Number.isFinite(item?.topology?.longEdgeTriangleCount) ? item.topology.longEdgeTriangleCount : 0), 0);
  const topologyTriangleCount = details.reduce((sum, item) => sum + (Number.isFinite(item?.topology?.triangleCount) ? item.topology.triangleCount : 0), 0);

  return {
    primitiveCount: Number.isFinite(quality?.counts?.primitiveCount) ? quality.counts.primitiveCount : details.length,
    triangleCount: Number.isFinite(quality?.counts?.triangleCount) ? quality.counts.triangleCount : null,
    degenerateTriangleCount: Number.isFinite(quality?.counts?.degenerateTriangleCount) ? quality.counts.degenerateTriangleCount : null,
    degenerateTriangleRatio: Number.isFinite(quality?.counts?.degenerateTriangleRatio) ? quality.counts.degenerateTriangleRatio : null,
    topologyAnalyzedPrimitiveCount: analyzed.length,
    topologySkippedPrimitiveCount: skipped.length,
    longEdgeTriangleCount,
    longEdgeTriangleRatio: topologyTriangleCount ? Number((longEdgeTriangleCount / topologyTriangleCount).toFixed(6)) : null,
    connectedComponentsByPrimitive: analyzed.map((item) => ({
      meshIndex: item.meshIndex,
      primitiveIndex: item.primitiveIndex,
      triangleCount: item.topology.triangleCount,
      connectedComponentCount: item.topology.connectedComponentCount,
      smallDetachedComponentCount: item.topology.smallDetachedComponentCount,
      boundaryEdgeCount: item.topology.boundaryEdgeCount,
      boundaryEdgeRatio: item.topology.boundaryEdgeRatio,
      nonManifoldEdgeCount: item.topology.nonManifoldEdgeCount,
      longEdgeTriangleCount: item.topology.longEdgeTriangleCount,
      longEdgeTriangleRatio: item.topology.longEdgeTriangleRatio,
      warnings: Array.isArray(item.topology.warnings) ? item.topology.warnings : [],
    })),
  };
}

/**
 * Synthesize image, COLMAP, mesh, scale, orientation and placement diagnostics
 * into actionable review findings. This is a triage report, not a geometry
 * repairer or a publication gate that can be bypassed by having no warnings.
 */
export function buildModelReviewSummary(input = {}) {
  if (!isObject(input)) throw new TypeError("model review input must be an object");

  const {
    imageQualityPreflight,
    reconstructionDiagnostics,
    cameraCoverage,
    modelQuality,
    scaleCalibration,
    upAxisReviewed,
    georeference,
  } = input;
  const findings = [];

  if (!isObject(imageQualityPreflight)) {
    findings.push(finding(
      "image-preflight-unavailable", "input-images", "medium",
      "Input image diagnostics are unavailable",
      "The selected views have no usable image-quality preflight summary.",
      "Inspect the selected images for blur, exposure, resolution and overlapping viewpoints before rerunning reconstruction.",
    ));
  } else {
    const views = Array.isArray(imageQualityPreflight.views) ? imageQualityPreflight.views : [];
    const flaggedIds = views
      .filter((view) => (Array.isArray(view?.warnings) && view.warnings.length > 0)
        || (Array.isArray(view?.nearDuplicateIds) && view.nearDuplicateIds.length > 0))
      .map((view) => view.sourceId)
      .filter((id) => typeof id === "string");
    const flaggedCount = Number.isFinite(imageQualityPreflight.flaggedViewCount)
      ? imageQualityPreflight.flaggedViewCount
      : flaggedIds.length;
    const nearDuplicatePairCount = Number.isFinite(imageQualityPreflight.nearDuplicatePairCount)
      ? imageQualityPreflight.nearDuplicatePairCount
      : views.reduce((sum, view) => sum + (Array.isArray(view?.nearDuplicateIds) ? view.nearDuplicateIds.length : 0), 0) / 2;

    if (flaggedCount > 0 || nearDuplicatePairCount > 0) {
      findings.push(finding(
        "input-views-need-inspection", "input-images", "medium",
        "Some input views may be weak or repetitive",
        flaggedCount + " of " + views.length + " views were flagged; " + nearDuplicatePairCount + " near-duplicate pair(s) were detected.",
        "Review the listed source views for blur, low contrast, poor exposure or repetitive framing. Replace or deselect weak views manually; the engine does not discard them automatically.",
        { flaggedViewCount: flaggedCount, nearDuplicatePairCount, sourceIds: flaggedIds },
      ));
    }
  }

  if (!isObject(reconstructionDiagnostics) || reconstructionDiagnostics.status === "unavailable") {
    const messages = Array.isArray(reconstructionDiagnostics?.warnings) ? reconstructionDiagnostics.warnings : [];
    findings.push(finding(
      "reconstruction-diagnostics-unavailable", "reconstruction", "medium",
      "Sparse reconstruction quality could not be assessed",
      messages[0] || "Registered-image, sparse-point or feature-track diagnostics are missing.",
      "Inspect the COLMAP workspace and model_analyzer output; verify image registration and sparse coverage before trusting the dense mesh.",
      { warnings: messages.slice(0, 4) },
    ));
  } else if (reconstructionDiagnostics.status === "review-recommended") {
    const ratio = Number.isFinite(reconstructionDiagnostics.registeredImageRatio)
      ? reconstructionDiagnostics.registeredImageRatio
      : null;
    const severity = ratio !== null && ratio < 0.5 ? "high" : "medium";
    const messages = Array.isArray(reconstructionDiagnostics.warnings) ? reconstructionDiagnostics.warnings : [];
    findings.push(finding(
      "sparse-reconstruction-needs-review", "reconstruction", severity,
      "COLMAP reconstruction signals need review",
      messages.length ? messages.slice(0, 3).join(" ") : "COLMAP reported reconstruction warnings.",
      "Inspect unregistered photos and sparse camera coverage. Prefer sharp, overlapping views that orbit the same building and capture corners, roofline and lower facade.",
      {
        registeredImageRatio: ratio,
        registeredImages: reconstructionDiagnostics.metrics?.registeredImages ?? null,
        sourceImageCount: reconstructionDiagnostics.sourceImageCount ?? null,
        sparsePointCount: reconstructionDiagnostics.metrics?.sparsePointCount ?? null,
        warnings: messages.slice(0, 6),
      },
    ));
  }

  if (!isObject(cameraCoverage) || cameraCoverage.status === "unavailable") {
    const messages = Array.isArray(cameraCoverage?.warnings) ? cameraCoverage.warnings : [];
    findings.push(finding(
      "camera-coverage-diagnostics-unavailable", "camera-coverage", "medium",
      "Camera coverage could not be assessed",
      messages[0] || "COLMAP camera poses or sparse scene bounds were not available for coverage analysis.",
      "Inspect the exported COLMAP sparse model and verify that camera positions, image orientations and sparse point bounds are present before accepting the mesh.",
      { warnings: messages.slice(0, 4) },
    ));
  } else if (cameraCoverage.status === "review-recommended") {
    const messages = Array.isArray(cameraCoverage.warnings) ? cameraCoverage.warnings : [];
    const lowSpread = messages.includes("camera-positions-have-low-spread-relative-to-scene");
    const sameDirection = messages.includes("camera-viewing-directions-are-nearly-identical");
    findings.push(finding(
      "camera-coverage-needs-review", "camera-coverage", lowSpread || sameDirection ? "medium" : "low",
      "Registered viewpoints may not cover enough of the building",
      messages.length ? messages.slice(0, 3).join(", ") + "." : "COLMAP camera coverage heuristics recommended review.",
      "Inspect registered camera positions and viewing directions. Capture more overlapping oblique views around the building corners, roofline and opposite facades where access permits; do not assume unobserved geometry is correct.",
      {
        registeredCameraPoseCount: cameraCoverage.registeredCameraPoseCount ?? null,
        sparsePointCount: cameraCoverage.sparsePointCount ?? null,
        cameraPositionSpreadRatio: cameraCoverage.cameraPositionSpreadRatio ?? null,
        maximumViewingDirectionAngleDegrees: cameraCoverage.maximumViewingDirectionAngleDegrees ?? null,
        warnings: messages.slice(0, 6),
      },
    ));
  }

  if (!isObject(modelQuality)) {
    findings.push(finding(
      "mesh-geometry-qa-unavailable", "geometry", "medium",
      "Mesh geometry diagnostics are unavailable",
      "No GLB geometry QA report is available to inspect triangle or topology quality.",
      "Run GLB geometry QA on the exact model file and visually inspect the geometry before any approval.",
    ));
  } else {
    const warnings = uniqueStrings(Array.isArray(modelQuality.warnings) ? modelQuality.warnings : []);
    const geometrySnapshot = makeGeometrySnapshot(modelQuality);
    const meshWarnings = warnings.filter((warning) => [
      "degenerate-triangles-present",
      "degenerate-triangle-ratio-exceeds-threshold",
      "long-triangle-edges-present",
      "disconnected-mesh-components-present",
      "small-detached-components-present",
      "open-boundary-edges-present",
      "non-manifold-edges-present",
      "topology-analysis-skipped-vertex-limit",
    ].includes(warning));

    if (meshWarnings.length || modelQuality.valid === false) {
      const severity = severityForMeshWarnings(meshWarnings, modelQuality);
      findings.push(finding(
        "mesh-topology-needs-visual-review", "geometry", severity,
        "Mesh topology contains review signals",
        meshWarnings.length
          ? "Geometry QA reported: " + meshWarnings.join(", ") + "."
          : "The geometry QA report marked the asset invalid.",
        "Inspect the affected primitive(s) in a mesh viewer. Check detached islands, stretched triangles, holes and non-manifold edges; do not automatically close boundaries that may be intentional.",
        { warningCodes: meshWarnings, snapshot: geometrySnapshot },
      ));
    }

    const textureWarnings = warnings.filter((warning) => [
      "no-texture-atlas-embedded-or-declared",
      "no-materials-declared",
      "external-resources-referenced",
    ].includes(warning));
    if (textureWarnings.length) {
      findings.push(finding(
        "mesh-materials-or-textures-need-review", "texture", "medium",
        "Material or texture references need review",
        "GLB QA reported: " + textureWarnings.join(", ") + ".",
        "Open the GLB in a viewer and confirm that its intended material and image assets are embedded and render correctly.",
        { warningCodes: textureWarnings },
      ));
    }
    if (warnings.includes("very-small-triangle-count")) {
      findings.push(finding(
        "mesh-triangle-count-is-small", "geometry", "medium",
        "Mesh contains very little triangle geometry",
        "The output has fewer than 12 triangles, which is not enough to represent most building exteriors.",
        "Check whether the source mesh was truncated or whether the selected reconstruction output was the intended surface.",
        { triangleCount: modelQuality.counts?.triangleCount ?? null },
      ));
    }
  }

  if (!isObject(scaleCalibration) || scaleCalibration.scaleCalibrated !== true) {
    findings.push(finding(
      "metric-scale-unverified", "scale", "medium",
      "Model scale is provisional",
      "No verified real-world baseline has been applied to convert model units into metres.",
      "Measure a known distance visible in the reconstruction and record both its model-space length and real-world length; keep the result preview-only until checked.",
      { method: scaleCalibration?.method ?? "unavailable" },
    ));
  }

  if (upAxisReviewed !== true) {
    findings.push(finding(
      "up-axis-not-reviewed", "orientation", "medium",
      "Model up-axis still needs visual confirmation",
      "The selected source up-axis has not been reviewed for the generated model.",
      "Inspect the model with verticals aligned to the expected world-up axis, then verify facade-front heading separately.",
    ));
  }

  const placementStatus = typeof georeference?.status === "string" ? georeference.status : "not-solved";
  if (!["registered", "verified", "ground-control-registered", "calibrated"].includes(placementStatus)) {
    findings.push(finding(
      "wgs84-placement-not-registered", "placement", "medium",
      "Map placement is not registered to surveyed control points",
      "The BuildingSpec longitude/latitude is only a placement hint; the model has not been tied to surveyed WGS84 control points.",
      "Match at least three non-collinear points in the exact GLB to trustworthy surveyed longitude/latitude coordinates and independently review the vertical datum and heading.",
      { georeferenceStatus: placementStatus },
    ));
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const priority = findings[0]?.severity ?? "none";
  const nextActions = uniqueStrings(findings.map((item) => item.recommendation)).slice(0, 6);
  if (!nextActions.length) {
    nextActions.push("Visually inspect every facade, roofline, underside and texture seam against reliable references before approval.");
  }

  return {
    schemaVersion: "1.0.0",
    engine: "model-review-summary-v1",
    status: findings.length ? "review-recommended" : "no-automated-findings",
    priority,
    findingCount: findings.length,
    findings,
    geometrySnapshot: makeGeometrySnapshot(modelQuality),
    nextActions,
    humanReviewRequired: true,
    mapReady: false,
    publicationEligible: false,
    limitations: [
      "This summary combines heuristics and does not prove architectural fidelity, hidden-side completeness, source rights, true metric scale or precise georeferencing.",
      "No automated findings does not remove the human-review requirement; the worker never marks a model map-ready or publication-eligible.",
    ],
  };
}
