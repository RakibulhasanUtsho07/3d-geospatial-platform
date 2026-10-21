const finite = (value) => typeof value === "number" && Number.isFinite(value);

function validateInput(model, options) {
  if (!model || !Array.isArray(model.vertices) || !Array.isArray(model.edges)) {
    throw new TypeError("wireframe model must contain vertices and edges arrays");
  }
  const maxPasses = options.maxPasses ?? 3;
  const maxRmsReprojectionError = options.maxRmsReprojectionError ?? model.maxRmsReprojectionError ?? 3;
  if (!Number.isInteger(maxPasses) || maxPasses < 3 || maxPasses > 4) {
    throw new RangeError("maxPasses must be 3 or 4");
  }
  if (!finite(maxRmsReprojectionError) || maxRmsReprojectionError <= 0) {
    throw new RangeError("maxRmsReprojectionError must be a positive finite number");
  }
  return { maxPasses, maxRmsReprojectionError };
}

/**
 * Runs bounded, deterministic topology QA. Safe repairs are limited to
 * invalid/duplicate edge records; coordinates are never silently changed.
 */
export function runWireframeQaRepairPasses(inputModel, options = {}) {
  const { maxPasses, maxRmsReprojectionError } = validateInput(inputModel, options);
  const vertices = inputModel.vertices.map((vertex) => ({ ...vertex }));
  let edges = inputModel.edges.map((edge) => ({ ...edge }));
  const vertexIds = new Set();
  for (const vertex of vertices) {
    if (!vertex || typeof vertex.id !== "string" || !vertex.id || vertexIds.has(vertex.id)) {
      throw new TypeError("vertex IDs must be non-empty and unique");
    }
    vertexIds.add(vertex.id);
  }

  const history = [];
  const repairs = [];
  let previousSignature = "";
  let converged = false;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const nextEdges = [];
    const seen = new Set();
    const issues = [];
    for (const edge of edges) {
      const from = edge?.from;
      const to = edge?.to;
      if (typeof from !== "string" || typeof to !== "string" || from === to ||
          !vertexIds.has(from) || !vertexIds.has(to)) {
        issues.push({ type: "invalid-edge-removed", edge });
        repairs.push({ pass, action: "remove-invalid-edge", edge });
        continue;
      }
      const key = [from, to].sort().join("\u0000");
      if (seen.has(key)) {
        issues.push({ type: "duplicate-edge-removed", edge });
        repairs.push({ pass, action: "remove-duplicate-edge", edge });
        continue;
      }
      seen.add(key);
      nextEdges.push({ from, to });
    }

    const flaggedVertices = [];
    for (const vertex of vertices) {
      const error = vertex.rmsReprojectionError;
      if (finite(error) && error > maxRmsReprojectionError) {
        flaggedVertices.push({ vertexId: vertex.id, rmsReprojectionError: error });
      }
      if (!Array.isArray(vertex.point) || vertex.point.length !== 3 || vertex.point.some((n) => !finite(n))) {
        flaggedVertices.push({ vertexId: vertex.id, reason: "invalid-or-missing-3d-coordinate" });
      }
    }

    const signature = JSON.stringify({
      edges: nextEdges.map((edge) => [edge.from, edge.to]),
      flaggedVertices,
    });
    history.push({
      pass,
      inputEdgeCount: edges.length,
      outputEdgeCount: nextEdges.length,
      issueCount: issues.length,
      flaggedVertexCount: flaggedVertices.length,
      issues,
      flaggedVertices,
    });
    edges = nextEdges;
    if (signature === previousSignature || (issues.length === 0 && flaggedVertices.length === 0)) {
      converged = true;
      break;
    }
    previousSignature = signature;
  }

  const remainingFlags = history.at(-1)?.flaggedVertices ?? [];
  const remainingIssues = history.at(-1)?.issues ?? [];
  const status = remainingFlags.length || remainingIssues.length ? "review-required" : "qa-clean";
  return {
    schemaVersion: "1.0.0",
    method: "bounded-wireframe-topology-qa",
    status,
    maxPasses,
    passesExecuted: history.length,
    converged,
    maxRmsReprojectionError,
    vertices,
    edges,
    repairs,
    history,
    limitations: [
      "Only malformed and duplicate edge records are automatically repaired.",
      "3D coordinates are never moved or fabricated by this stage.",
      "A low reprojection error does not prove architectural correctness or metric scale.",
      "Flagged vertices require evidence-backed manual correction or reacquisition.",
    ],
    publicationEligible: false,
  };
}
