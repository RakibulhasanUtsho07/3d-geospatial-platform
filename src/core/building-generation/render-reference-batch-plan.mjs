import path from "node:path";

const safeRenderFilename = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
  !value.includes("..");

function insideRoot(root, candidate, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === "." || relative === ".." ||
    relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    if (relative === "." && label === "diagnostics directory") return resolved;
    throw new TypeError(label + " must resolve to a child of the review-input directory");
  }
  return resolved;
}

/**
 * Build a deterministic, bounded list of exact render/reference pairs for batch
 * diagnostics. The planner never reads or modifies image bytes.
 */
export function buildRenderReferenceBatchPlan({
  renderManifest,
  reviewInput,
  renderDirectory,
  reviewInputPath,
  diagnosticsDirectoryName = "generated-render-diagnostics",
  maxComparisons = 250,
} = {}) {
  if (!renderManifest || renderManifest.schemaVersion !== "1.0.0" ||
    renderManifest.engine !== "building-render-review-manifest-v1" ||
    !Array.isArray(renderManifest.views)) {
    throw new TypeError("renderManifest must be a version 1.0.0 building render review manifest");
  }
  if (!reviewInput || reviewInput.schemaVersion !== "1.0.0" ||
    typeof reviewInput.buildingId !== "string" || !reviewInput.buildingId.trim() ||
    !Array.isArray(reviewInput.referenceImages) || !Array.isArray(reviewInput.comparisons)) {
    throw new TypeError("reviewInput must be version 1.0.0 with buildingId, referenceImages and comparisons");
  }
  if (!Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 1000) {
    throw new RangeError("maxComparisons must be an integer between 1 and 1000");
  }
  if (reviewInput.comparisons.length < 1 || reviewInput.comparisons.length > maxComparisons) {
    throw new RangeError("reviewInput comparisons must contain between 1 and " + maxComparisons + " entries");
  }
  if (typeof renderDirectory !== "string" || !renderDirectory.trim() ||
    typeof reviewInputPath !== "string" || !reviewInputPath.trim()) {
    throw new TypeError("renderDirectory and reviewInputPath are required");
  }
  if (typeof diagnosticsDirectoryName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(diagnosticsDirectoryName) ||
    diagnosticsDirectoryName.includes("..")) {
    throw new TypeError("diagnosticsDirectoryName must be a safe, single relative directory name");
  }

  const renderRoot = path.resolve(renderDirectory);
  const reviewRoot = path.dirname(path.resolve(reviewInputPath));
  const diagnosticsDirectoryPath = insideRoot(
    reviewRoot,
    path.join(reviewRoot, diagnosticsDirectoryName),
    "diagnostics directory",
  );
  const inputBase = path.basename(reviewInputPath, path.extname(reviewInputPath));
  const reviewInputWithDiagnosticsPath = path.join(reviewRoot, inputBase + ".with-similarity-diagnostics.json");

  const viewsById = new Map();
  const renderFilenames = new Set();
  for (const view of renderManifest.views) {
    if (!view || typeof view.id !== "string" || !view.id.trim() || viewsById.has(view.id)) {
      throw new TypeError("render manifest contains an invalid or duplicate view id");
    }
    if (!safeRenderFilename(view.filename) || renderFilenames.has(view.filename)) {
      throw new TypeError("render manifest contains an unsafe, non-PNG, or duplicate render filename");
    }
    viewsById.set(view.id, view);
    renderFilenames.add(view.filename);
  }

  const referencesById = new Map();
  for (const reference of reviewInput.referenceImages) {
    if (!reference || typeof reference.id !== "string" || !reference.id.trim() || referencesById.has(reference.id)) {
      throw new TypeError("review input contains an invalid or duplicate reference image id");
    }
    if (typeof reference.path !== "string" || !reference.path.trim() ||
      path.isAbsolute(reference.path) || path.win32.isAbsolute(reference.path)) {
      throw new TypeError("reference " + reference.id + " must use a non-empty relative file path");
    }
    const referencePath = insideRoot(reviewRoot, path.resolve(reviewRoot, reference.path), "reference image path");
    if (!/\.(?:png|jpe?g)$/i.test(reference.path)) {
      throw new TypeError("reference " + reference.id + " must use a JPEG or PNG file");
    }
    referencesById.set(reference.id, { ...reference, resolvedPath: referencePath });
  }

  const seenPairs = new Set();
  const pairs = [];
  for (let index = 0; index < reviewInput.comparisons.length; index++) {
    const comparison = reviewInput.comparisons[index];
    if (!comparison || typeof comparison.viewId !== "string" || !comparison.viewId.trim()) {
      throw new TypeError("comparison " + index + " has no valid viewId");
    }
    if (typeof comparison.referenceImageId !== "string" || !comparison.referenceImageId.trim()) {
      throw new TypeError("comparison " + index + " has no valid referenceImageId");
    }
    const pairKey = comparison.viewId + "\u0000" + comparison.referenceImageId;
    if (seenPairs.has(pairKey)) {
      throw new TypeError("duplicate render/reference comparison: " + comparison.viewId + ":" + comparison.referenceImageId);
    }
    seenPairs.add(pairKey);

    const view = viewsById.get(comparison.viewId);
    if (!view) throw new TypeError("comparison references unknown render view: " + comparison.viewId);
    const reference = referencesById.get(comparison.referenceImageId);
    if (!reference) throw new TypeError("comparison references unknown reference image: " + comparison.referenceImageId);

    const filename = "pair-" + String(index + 1).padStart(3, "0") + ".json";
    const diagnosticRelativePath = path.posix.join(diagnosticsDirectoryName, filename);
    pairs.push({
      index,
      viewId: view.id,
      referenceImageId: reference.id,
      renderPath: path.join(renderRoot, view.filename),
      referencePath: reference.resolvedPath,
      diagnosticFilename: filename,
      diagnosticRelativePath,
    });
  }

  return {
    renderRoot,
    reviewRoot,
    diagnosticsDirectoryPath,
    reviewInputWithDiagnosticsPath,
    pairs,
  };
}
