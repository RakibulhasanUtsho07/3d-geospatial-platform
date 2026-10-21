import { createHash } from "node:crypto";
import { REQUIRED_REVIEW_VIEWS } from "./render-review-manifest.mjs";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "./glb-texture-binding-qa.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/i;
const requiredArtifactTypes = [
  "candidate-glb",
  "geometry-qa",
  "texture-qa",
  "render-manifest",
  "render-reference-review",
  "correction-task-backlog",
  "correction-verification",
  "release-readiness-report",
  "review-instructions",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value) => typeof value === "string" && sha256Pattern.test(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const semanticDigest = (value) => digest(Buffer.from(JSON.stringify(value)));

function safeRelativePath(value) {
  if (!nonEmptyString(value) || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
  );
}

/**
 * Verify a review package against the immutable package manifest and the bytes
 * actually found on disk. A checksum package detects drift relative to its
 * manifest; it is not a signed provenance statement if both are replaced.
 */
export function verifyBuildingReviewPackage({ packageManifest, actualFiles, packageManifestSha256 }) {
  if (!isObject(packageManifest) || packageManifest.schemaVersion !== "1.0.0" ||
    packageManifest.engine !== "building-review-package-v1" ||
    !nonEmptyString(packageManifest.buildingId) || !Array.isArray(packageManifest.artifacts)) {
    throw new Error("building-review-package-manifest-invalid");
  }
  if (!Array.isArray(actualFiles)) throw new TypeError("actualFiles must be an array");
  if (!isHash(packageManifestSha256)) throw new TypeError("packageManifestSha256 must be a valid SHA-256 hash");
  if (!["ready-for-final-human-review", "ready-for-final-human-review-with-warnings"].includes(packageManifest.readiness?.status) ||
    packageManifest.readiness?.finalHumanReviewRequired !== true ||
    packageManifest.readiness?.publicationEligible !== false ||
    packageManifest.policy?.publicationEligible !== false ||
    packageManifest.policy?.assetPublished !== false) {
    throw new Error("building-review-package-release-policy-invalid");
  }

  const checks = [];
  const errors = [];
  const warnings = [];
  const check = (id, passed, message, severity = "error") => {
    const item = { id, status: passed ? "passed" : severity === "warning" ? "warning" : "failed", message };
    checks.push(item);
    if (!passed && severity === "warning") warnings.push(item);
    else if (!passed) errors.push(item);
  };

  const artifactByPath = new Map();
  const artifactByType = new Map();
  const artifactByViewId = new Map();
  const artifactByReferenceId = new Map();
  const expectedPaths = new Set();

  for (let index = 0; index < packageManifest.artifacts.length; index++) {
    const artifact = packageManifest.artifacts[index];
    const validArtifact = isObject(artifact) && nonEmptyString(artifact.artifactType) &&
      safeRelativePath(artifact.relativePath) && isHash(artifact.sha256) &&
      Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0;
    check("manifest-artifact:" + index, validArtifact,
      "Package manifest artifact entry " + index + " must have a safe path, SHA-256 and positive byte size.");
    if (!validArtifact) continue;
    if (expectedPaths.has(artifact.relativePath)) {
      check("manifest-path-unique:" + artifact.relativePath, false,
        "Package manifest contains a duplicated relative path.");
      continue;
    }
    expectedPaths.add(artifact.relativePath);
    artifactByPath.set(artifact.relativePath, artifact);
    artifactByType.set(artifact.artifactType, [...(artifactByType.get(artifact.artifactType) ?? []), artifact]);
    if (artifact.artifactType === "render-image" && nonEmptyString(artifact.viewId)) {
      artifactByViewId.set(artifact.viewId, artifact);
    }
    if (artifact.artifactType === "reference-image" && nonEmptyString(artifact.referenceImageId)) {
      artifactByReferenceId.set(artifact.referenceImageId, artifact);
    }
  }

  for (const artifactType of requiredArtifactTypes) {
    check("required-artifact:" + artifactType, artifactByType.get(artifactType)?.length === 1,
      "The package must include exactly one " + artifactType + " artifact.");
  }

  const actualByPath = new Map();
  for (let index = 0; index < actualFiles.length; index++) {
    const file = actualFiles[index];
    const validFile = isObject(file) && safeRelativePath(file.relativePath) &&
      Buffer.isBuffer(file.content) && file.isRegularFile !== false;
    check("actual-file:" + index, validFile,
      "Actual package file " + index + " must be a regular file with a safe relative path and readable bytes.");
    if (!validFile) continue;
    if (actualByPath.has(file.relativePath)) {
      check("actual-path-unique:" + file.relativePath, false, "Actual package contains duplicate file paths.");
      continue;
    }
    actualByPath.set(file.relativePath, file);
  }

  for (const [relativePath, artifact] of artifactByPath) {
    const actual = actualByPath.get(relativePath);
    check("file-present:" + relativePath, Boolean(actual), "Package artifact is missing: " + relativePath + ".");
    if (!actual) continue;
    const actualHash = digest(actual.content);
    check("file-sha256:" + relativePath, actualHash.toLowerCase() === artifact.sha256.toLowerCase(),
      "File SHA-256 does not match the package manifest: " + relativePath + ".");
    check("file-size:" + relativePath, actual.content.length === artifact.bytes,
      "File size does not match the package manifest: " + relativePath + ".");

    if (artifact.contentDigest) {
      let parsed;
      try {
        parsed = JSON.parse(actual.content.toString("utf8"));
      } catch {
        check("json-content-digest:" + relativePath, false, "JSON artifact cannot be parsed: " + relativePath + ".");
        continue;
      }
      check("json-content-digest:" + relativePath, semanticDigest(parsed).toLowerCase() === artifact.contentDigest.toLowerCase(),
        "JSON content digest does not match the package manifest: " + relativePath + ".");
    }

    if (["render-image", "reference-image"].includes(artifact.artifactType)) {
      check("image-metadata:" + relativePath,
        Number.isSafeInteger(actual.width) && Number.isSafeInteger(actual.height) &&
        actual.width === artifact.width && actual.height === artifact.height,
      "Image dimensions are missing or differ from the package manifest: " + relativePath + ".");
    }
  }

  for (const relativePath of actualByPath.keys()) {
    check("no-extra-file:" + relativePath, expectedPaths.has(relativePath),
      "Unlisted file is present in the review package: " + relativePath + ".");
  }

  for (const viewId of REQUIRED_REVIEW_VIEWS) {
    check("required-render-view:" + viewId, artifactByViewId.has(viewId),
      "Required render view is missing from the review package: " + viewId + ".");
  }
  for (const artifact of artifactByType.get("reference-image") ?? []) {
    check("reference-rights:" + artifact.referenceImageId, artifact.rightsStatus === "verified",
      "Reference usage rights are not recorded as verified: " + artifact.referenceImageId + ".");
  }

  function artifact(type) {
    const entries = artifactByType.get(type) ?? [];
    return entries.length === 1 ? entries[0] : null;
  }
  function content(type) {
    const item = artifact(type);
    const file = item ? actualByPath.get(item.relativePath) : null;
    if (!file) return null;
    try { return JSON.parse(file.content.toString("utf8")); } catch { return null; }
  }

  const candidate = artifact("candidate-glb");
  const candidateBytes = candidate ? actualByPath.get(candidate.relativePath)?.content : null;
  const geometry = content("geometry-qa");
  const texture = content("texture-qa");
  const manifest = content("render-manifest");
  const review = content("render-reference-review");
  const backlog = content("correction-task-backlog");
  const verification = content("correction-verification");
  const readiness = content("release-readiness-report");

  check("candidate-model-hash", Boolean(candidate && packageManifest.readiness.sourceCandidateGlbSha256?.toLowerCase?.() === candidate.sha256.toLowerCase()),
    "Candidate GLB hash does not match the review package readiness metadata.");

  check("release-readiness-report", Boolean(readiness && readiness.engine === "building-release-readiness-gate-v1" &&
    readiness.buildingId === packageManifest.buildingId &&
    readiness.status === packageManifest.readiness.status &&
    readiness.candidateGlbSha256?.toLowerCase?.() === candidate?.sha256.toLowerCase() &&
    readiness.publicationEligible === false && readiness.finalHumanReviewRequired === true),
  "Release readiness report does not match package metadata or release policy.");
  check("release-readiness-no-blockers", Boolean(readiness && readiness.counts?.blockers === 0 &&
    Array.isArray(readiness.checks) && readiness.checks.every((item) => item.status !== "blocked")),
  "The packaged release-readiness report must contain zero blockers and no blocked checks.");

  const provenance = readiness?.provenance ?? {};
  const digestBindings = [
    ["render-manifest", provenance.renderManifestSha256, "file-hash"],
    ["render-reference-review", provenance.renderReferenceReviewSha256, "content-digest"],
    ["correction-task-backlog", provenance.correctionTaskBacklogSha256, "content-digest"],
    ["correction-verification", provenance.correctionVerificationReportSha256, "content-digest"],
    ["geometry-qa", provenance.geometryQaReportSha256, "content-digest"],
    ["texture-qa", provenance.textureQaReportSha256, "content-digest"],
  ];
  for (const [type, expected, field] of digestBindings) {
    const item = artifact(type);
    const actualValue = field === "file-hash" ? item?.sha256 : item?.contentDigest;
    check("readiness-provenance:" + type, isHash(expected) &&
      actualValue?.toLowerCase?.() === expected.toLowerCase(),
    "Release readiness provenance does not match packaged evidence: " + type + ".");
  }

  check("geometry-qa-report", Boolean(geometry && geometry.engine === "glb-geometry-qa-v2" &&
    geometry.schemaVersion === "1.0.0" && geometry.valid === true),
  "Geometry QA report is missing, invalid or unsupported.");
  check("texture-qa-report", Boolean(texture && texture.engine === "glb-texture-binding-qa-v1" &&
    texture.schemaVersion === "1.0.0" && texture.valid === true && Array.isArray(texture.errors) && texture.errors.length === 0),
  "Texture/UV QA report is missing, invalid or has errors.");

  if (candidateBytes) {
    try {
      const actualGeometry = analyzeGlbQuality(candidateBytes);
      check("candidate-geometry-recomputed", Boolean(geometry && semanticDigest(actualGeometry) === semanticDigest(geometry)),
        "Recomputed geometry QA does not match the packaged geometry QA report.");
    } catch (error) {
      check("candidate-geometry-recomputed", false,
        "Candidate GLB failed geometry QA recomputation: " + (error instanceof Error ? error.message : String(error)));
    }
    try {
      const actualTexture = reviewGlbTextureBindings(candidateBytes);
      check("candidate-texture-recomputed", Boolean(texture && semanticDigest(actualTexture) === semanticDigest(texture)),
        "Recomputed texture/UV QA does not match the packaged texture QA report.");
    } catch (error) {
      check("candidate-texture-recomputed", false,
        "Candidate GLB failed texture/UV QA recomputation: " + (error instanceof Error ? error.message : String(error)));
    }
  } else {
    check("candidate-bytes-readable", false, "Candidate GLB bytes are not available for re-running QA.");
  }

  const manifestArtifact = artifact("render-manifest");
  check("render-manifest", Boolean(manifest && manifest.schemaVersion === "1.0.0" &&
    manifest.engine === "building-render-review-manifest-v1" && manifest.valid === true &&
    manifest.modelSha256?.toLowerCase?.() === candidate?.sha256.toLowerCase()),
  "Render manifest is invalid or refers to a different candidate GLB.");
  const manifestViewList = Array.isArray(manifest?.views) ? manifest.views : [];
  const manifestViewIds = manifestViewList.map((view) => view?.id);
  const manifestViews = new Map(manifestViewList.map((view) => [view.id, view]));
  check("render-manifest-view-identities", manifestViewIds.length === manifestViews.size &&
    REQUIRED_REVIEW_VIEWS.every((viewId) => manifestViews.has(viewId)),
  "Render manifest must contain unique IDs for all required render views.");
  for (const viewId of REQUIRED_REVIEW_VIEWS) {
    const view = manifestViews.get(viewId);
    const packaged = artifactByViewId.get(viewId);
    check("render-view-hash:" + viewId, Boolean(view && packaged &&
      isHash(view.sha256) && view.sha256.toLowerCase() === packaged.sha256.toLowerCase() &&
      view.width === packaged.width && view.height === packaged.height),
    "Packaged render image does not match the manifest evidence for view " + viewId + ".");
  }
  check("render-manifest-referenced-in-review", Boolean(manifestArtifact && review &&
    review.provenance?.renderManifestSha256?.toLowerCase?.() === manifestArtifact.sha256.toLowerCase()),
  "Reference review does not cite the packaged render manifest's exact file hash.");

  check("reference-review-report", Boolean(review && review.schemaVersion === "1.0.0" &&
    review.engine === "render-reference-review-v1" && review.valid === true &&
    review.buildingId === packageManifest.buildingId &&
    review.provenance?.sourceModelSha256?.toLowerCase?.() === candidate?.sha256.toLowerCase()),
  "Render/reference review report is invalid or belongs to a different candidate/building.");
  check("reference-review-status", review?.reviewStatus === "reviewer-reported-matches",
    "Review report must record reviewer-reported matches, without unresolved outcomes.");
  if (Array.isArray(review?.warnings) && review.warnings.length > 0) {
    check("reference-review-warnings", false,
      "Reference review retains " + review.warnings.length + " warning(s) for the final reviewer.", "warning");
  }

  const references = new Map((Array.isArray(review?.referenceImages) ? review.referenceImages : []).map((item) => [item.id, item]));
  check("reference-count", references.size === artifactByReferenceId.size,
    "Packaged reference image count differs from the review report.");
  for (const [referenceId, reference] of references) {
    const packaged = artifactByReferenceId.get(referenceId);
    check("reference-present:" + referenceId, Boolean(packaged && reference.rightsStatus === "verified" &&
      packaged.rightsStatus === "verified" && reference.sha256?.toLowerCase?.() === packaged.sha256.toLowerCase() &&
      reference.width === packaged.width && reference.height === packaged.height),
    "Reference image is missing, modified, dimension-mismatched or not rights-verified: " + referenceId + ".");
  }

  const comparisons = Array.isArray(review?.comparisons) ? review.comparisons : [];
  const seenPairs = new Set();
  for (const comparison of comparisons) {
    const view = manifestViews.get(comparison.viewId);
    const reference = references.get(comparison.referenceImageId);
    const key = comparison.viewId + "\u0000" + comparison.referenceImageId;
    check("comparison-unique:" + comparison.viewId + ":" + comparison.referenceImageId, !seenPairs.has(key),
      "Duplicate review comparison pair detected.");
    seenPairs.add(key);
    check("comparison-evidence:" + comparison.viewId,
      Boolean(view && reference && comparison.outcome === "match" &&
        ["same-facade-known", "pose-estimated"].includes(comparison.comparisonBasis) &&
        comparison.renderSha256?.toLowerCase?.() === view.sha256.toLowerCase() &&
        comparison.referenceSha256?.toLowerCase?.() === reference.sha256.toLowerCase() &&
        nonEmptyString(comparison.reviewer) && nonEmptyString(comparison.notes) &&
        typeof comparison.reviewedAt === "string" && Number.isFinite(Date.parse(comparison.reviewedAt))),
    "Comparison for view " + comparison.viewId + " is not a direct, hash-bound reviewer-reported match.");
  }
  const coveredViews = new Set(comparisons.filter((item) => item.outcome === "match" &&
    ["same-facade-known", "pose-estimated"].includes(item.comparisonBasis)).map((item) => item.viewId));
  for (const viewId of REQUIRED_REVIEW_VIEWS) {
    check("review-coverage:" + viewId, coveredViews.has(viewId),
      "Review coverage is missing for view " + viewId + ".");
  }

  check("correction-backlog", Boolean(backlog && backlog.schemaVersion === "1.0.0" &&
    backlog.engine === "render-review-correction-tasks-v1" && backlog.buildingId === packageManifest.buildingId &&
    Array.isArray(backlog.tasks)),
  "Correction task backlog is invalid or belongs to another building.");
  check("correction-verification", Boolean(verification && verification.schemaVersion === "1.0.0" &&
    verification.engine === "render-correction-verification-v1" &&
    verification.buildingId === packageManifest.buildingId &&
    verification.provenance?.verificationSourceModelSha256?.toLowerCase?.() === candidate?.sha256.toLowerCase() &&
    verification.provenance?.verificationRenderManifestSha256?.toLowerCase?.() === manifestArtifact?.sha256.toLowerCase()),
  "Correction verification is invalid or refers to other source/model evidence.");

  if (backlog && verification) {
    const backlogArtifact = artifact("correction-task-backlog");
    check("verification-backlog-link", Boolean(backlogArtifact &&
      verification.sourceBacklogSha256 === backlogArtifact.contentDigest &&
      verification.sourceBacklogReviewReportSha256 === backlog.createdFromReviewReportSha256),
    "Correction verification is not linked to the exact packaged backlog.");
    check("verification-review-link", Boolean(artifact("render-reference-review") &&
      verification.verificationReviewReportSha256 === artifact("render-reference-review").contentDigest),
    "Correction verification is not linked to the exact packaged review report.");
    const backlogTasks = Array.isArray(backlog.tasks) ? backlog.tasks : [];
    const verifyTasks = Array.isArray(verification.tasks) ? verification.tasks : [];
    const verificationById = new Map(verifyTasks.map((item) => [item.taskId, item]));
    check("verification-task-count", verifyTasks.length === backlogTasks.length,
      "Correction verification task count differs from backlog task count.");
    for (const task of backlogTasks) {
      const result = verificationById.get(task.id);
      const expected = task.kind === "model-correction-review" ? "verified" :
        task.kind === "resolve-reference-comparability" ? "resolved" : "completed";
      check("verification-task:" + task.id,
        Boolean(result && result.status === expected &&
          (task.kind !== "model-correction-review" || result.verified === true)),
      "Correction task is not in its required verified/review-complete state: " + task.id + ".");
    }
    for (const taskId of verificationById.keys()) {
      check("verification-no-orphan-task:" + taskId, backlogTasks.some((task) => task.id === taskId),
        "Verification report contains an orphan task: " + taskId + ".");
    }
  }

  const status = errors.length ? "tampered-or-invalid" : warnings.length ? "verified-with-warnings" : "verified";
  return {
    schemaVersion: "1.0.0",
    engine: "building-review-package-integrity-v1",
    buildingId: packageManifest.buildingId,
    status,
    valid: errors.length === 0,
    packageManifestSha256: packageManifestSha256.toLowerCase(),
    counts: {
      expectedFiles: expectedPaths.size,
      actualFiles: actualByPath.size,
      checks: checks.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
    checks,
    publicationEligible: false,
    note: "Integrity verification checks the bytes and cross-references against the included package manifest. Without a separate trusted signature or externally stored manifest hash, it cannot detect an attacker who replaces both the package and its manifest.",
  };
}
