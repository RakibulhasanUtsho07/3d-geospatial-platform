const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
export const REQUIRED_SOURCE_SIDES = Object.freeze(["front", "back", "left", "right"]);
export const REQUIRED_RENDER_VIEWS = Object.freeze([
  "front", "back", "left", "right", "top",
  "turntable-000", "turntable-045", "turntable-090", "turntable-135",
  "turntable-180", "turntable-225", "turntable-270", "turntable-315",
]);
const CATEGORIES = new Set(["complex-landmark", "ordinary-low-rise", "ordinary-high-rise"]);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const hashOk = (v) => typeof v === "string" && SHA256.test(v);
const dateOk = (v) => nonEmpty(v) && Number.isFinite(Date.parse(v));
const sameHash = (a, b) => hashOk(a) && hashOk(b) && a.toLowerCase() === b.toLowerCase();

export function assessBuildingAccuracyEvidencePack(input = {}) {
  if (!object(input)) throw new TypeError("evidence pack input must be an object");
  const { packId, generatedAt, buildings, candidateCommit = null } = input;
  if (typeof packId !== "string" || !ID.test(packId)) throw new TypeError("packId is invalid");
  if (!dateOk(generatedAt)) throw new TypeError("generatedAt must be a valid timestamp");
  if (candidateCommit !== null && (typeof candidateCommit !== "string" || !/^[a-f0-9]{7,64}$/i.test(candidateCommit))) {
    throw new TypeError("candidateCommit must be a Git commit SHA or null");
  }
  if (!Array.isArray(buildings) || buildings.length < 2 || buildings.length > 3) {
    throw new TypeError("pilot pack must contain 2 or 3 buildings");
  }

  const ids = new Set();
  const categories = new Set();
  const reports = buildings.map((building) => {
    if (!object(building) || typeof building.buildingId !== "string" || !ID.test(building.buildingId)) {
      throw new TypeError("each building must have a valid buildingId");
    }
    if (ids.has(building.buildingId)) throw new TypeError("duplicate buildingId: " + building.buildingId);
    ids.add(building.buildingId);
    if (!CATEGORIES.has(building.category)) throw new TypeError("unsupported building category for " + building.buildingId);
    categories.add(building.category);

    const checks = [];
    const add = (id, pass, detail, failureMode = "warning") => {
      checks.push({ id, status: pass ? "passed" : failureMode, detail });
    };
    const sourceIdentity = building.sourceIdentity ?? {};
    add("building-identity",
      sourceIdentity.verified === true && nonEmpty(sourceIdentity.sourceId) &&
      nonEmpty(sourceIdentity.evidenceDescription) && nonEmpty(sourceIdentity.verifiedBy) && dateOk(sourceIdentity.verifiedAt),
      "Building identity must be linked to a documented source; identity claims remain operator-attested.");

    const candidate = building.candidate ?? {};
    const candidateHashValid = hashOk(candidate.sha256);
    add("candidate-glb-hash", candidateHashValid, "Candidate GLB must have a valid SHA-256 digest.", "failed");
    add("candidate-glb-hash-pinned", candidateHashValid && sameHash(candidate.expectedSha256, candidate.sha256),
      "Pin the expected GLB SHA-256 after reviewing the bootstrap report.");
    const geometry = candidate.geometryQa ?? {};
    add("glb-geometry-qa", geometry.valid === true, "Structural GLB geometry QA must pass.", geometry.valid === false ? "failed" : "warning");
    if (Array.isArray(geometry.warnings) && geometry.warnings.length) {
      add("glb-geometry-warnings", false, "Geometry warnings require review: " + geometry.warnings.join(", "));
    }

    const sourceMedia = Array.isArray(building.sourceMedia) ? building.sourceMedia : [];
    const validMedia = sourceMedia.filter((item) => object(item) && nonEmpty(item.id) &&
      ["photo", "video"].includes(item.kind) && REQUIRED_SOURCE_SIDES.includes(item.side) &&
      hashOk(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes > 0);
    const coveredSides = [...new Set(validMedia.map((item) => item.side))].sort();
    const mediaCoverage = sourceMedia.length >= 4 && validMedia.length === sourceMedia.length &&
      REQUIRED_SOURCE_SIDES.every((side) => coveredSides.includes(side));
    const mediaRights = mediaCoverage && sourceMedia.every((item) => item.rightsStatus === "verified" &&
      nonEmpty(item.sourceId) && nonEmpty(item.rightsEvidenceId) && nonEmpty(item.verifiedBy) && dateOk(item.verifiedAt));
    add("source-media-rights-and-side-coverage", mediaRights,
      "At least four hash-verified source photos/videos must cover front, back, left and right with documented rights evidence.");
    add("source-media-hash-pins", sourceMedia.length > 0 &&
      sourceMedia.every((item) => sameHash(item.expectedSha256, item.sha256)),
      "Pin the expected SHA-256 for every source asset after reviewing the bootstrap report.");

    const referenceImages = Array.isArray(building.referenceImages) ? building.referenceImages : [];
    const referenceIds = new Set();
    let referencesValid = referenceImages.length >= 4;
    for (const image of referenceImages) {
      const valid = object(image) && nonEmpty(image.id) && !referenceIds.has(image.id) &&
        REQUIRED_SOURCE_SIDES.includes(image.side) && hashOk(image.sha256) &&
        Number.isSafeInteger(image.bytes) && image.bytes > 0 &&
        image.rightsStatus === "verified" && nonEmpty(image.sourceId) &&
        nonEmpty(image.rightsEvidenceId) && nonEmpty(image.verifiedBy) && dateOk(image.verifiedAt);
      if (!valid) referencesValid = false;
      if (object(image) && nonEmpty(image.id)) referenceIds.add(image.id);
    }
    const referenceSides = new Set(referenceImages.map((image) => image?.side));
    referencesValid = referencesValid && REQUIRED_SOURCE_SIDES.every((side) => referenceSides.has(side));
    add("reference-image-rights-and-side-coverage", referencesValid,
      "Need at least four unique, hash-verified independent references with rights provenance and all four side views.");
    add("reference-image-hash-pins", referenceImages.length > 0 &&
      referenceImages.every((item) => sameHash(item.expectedSha256, item.sha256)),
      "Pin the expected SHA-256 for every independent reference image after reviewing the bootstrap report.");

    const render = building.renderEvidence ?? {};
    const views = Array.isArray(render.views) ? render.views : [];
    const byView = new Map(views.filter((view) => object(view) && nonEmpty(view.id)).map((view) => [view.id, view]));
    const viewsReady = REQUIRED_RENDER_VIEWS.every((id) => {
      const view = byView.get(id);
      return view && view.verified === true && hashOk(view.sha256) &&
        Number.isSafeInteger(view.bytes) && view.bytes > 0 &&
        Number.isSafeInteger(view.width) && view.width >= 256 &&
        Number.isSafeInteger(view.height) && view.height >= 256;
    });
    const modelBound = sameHash(render.modelSha256, candidate.sha256);
    const manifestPinned = sameHash(render.expectedManifestSha256, render.manifestSha256);
    add("fixed-camera-render-integrity", render.valid === true && viewsReady && modelBound && manifestPinned,
      "All 13 fixed render PNGs and the render manifest must be hash-bound to this exact candidate GLB.",
      render.modelSha256 && !modelBound ? "failed" : "warning");
    if (views.some((view) => view?.integrityError === true)) {
      add("render-byte-integrity", false, "A render file does not match its manifest hash or metadata.", "failed");
    }

    const benchmark = building.benchmarkReport ?? {};
    const benchmarkChecks = new Map((Array.isArray(benchmark.checks) ? benchmark.checks : []).map((check) => [check.id, check.status]));
    const benchmarkPassed = benchmark.status === "benchmark-passed-review-required" &&
      benchmarkChecks.get("dimension-reference-provenance") === "passed" &&
      benchmarkChecks.get("reference-dimensions-within-tolerance") === "passed" &&
      benchmarkChecks.get("ground-control-model-binding") === "passed" &&
      benchmarkChecks.get("ground-control-residuals-within-tolerance") === "passed" &&
      benchmarkChecks.get("render-reference-review") === "passed" &&
      sameHash(benchmark.candidateGlbSha256, candidate.sha256);
    add("dimension-and-horizontal-georeference-benchmark", benchmarkPassed,
      "Independent dimension evidence and horizontal control-point residuals must pass for this GLB.",
      benchmark.status === "benchmark-failed" ? "failed" : "warning");

    const review = building.renderReferenceReview ?? {};
    const reviewComparisons = Array.isArray(review.comparisons) ? review.comparisons : [];
    const comparisonsByView = new Map(reviewComparisons.filter((item) => object(item) && nonEmpty(item.viewId)).map((item) => [item.viewId, item]));
    const reviewRefs = new Map((Array.isArray(review.referenceImages) ? review.referenceImages : [])
      .filter((item) => object(item) && nonEmpty(item.id)).map((item) => [item.id, item]));
    const packRefs = new Map(referenceImages.filter((item) => object(item) && nonEmpty(item.id)).map((item) => [item.id, item]));
    const everyViewReviewed = REQUIRED_RENDER_VIEWS.every((viewId) => {
      const item = comparisonsByView.get(viewId);
      if (!item || item.outcome !== "match" || !nonEmpty(item.reviewer) || !dateOk(item.reviewedAt) ||
        !nonEmpty(item.notes) || !nonEmpty(item.referenceImageId)) return false;
      const packRef = packRefs.get(item.referenceImageId);
      const reviewRef = reviewRefs.get(item.referenceImageId);
      return packRef && reviewRef && sameHash(reviewRef.sha256, packRef.sha256) &&
        (!item.referenceSha256 || sameHash(item.referenceSha256, packRef.sha256));
    });
    const reviewHashMatches = sameHash(review.provenance?.sourceModelSha256, candidate.sha256);
    const visualPass = review.valid === true && review.buildingId === building.buildingId &&
      review.reviewStatus === "reviewer-reported-matches" && reviewHashMatches && everyViewReviewed;
    const hasExplicitMismatch = reviewComparisons.some((item) => item?.outcome === "mismatch" || item?.outcome === "partial");
    add("human-review-all-fixed-views", visualPass,
      "A human reviewer must record all 13 views against independent reference-image hashes and this exact GLB.",
      hasExplicitMismatch || (review.provenance?.sourceModelSha256 && !reviewHashMatches) ? "failed" : "warning");

    const vertical = building.verticalDatum ?? {};
    add("vertical-datum-evidence", vertical.status === "verified" && nonEmpty(vertical.sourceId) &&
      nonEmpty(vertical.sourceDescription) && nonEmpty(vertical.verifiedBy) && dateOk(vertical.verifiedAt),
      "Vertical elevation/datum is separate from horizontal location; mark it unsolved until independently evidenced.");

    const status = checks.some((check) => check.status === "failed") ? "benchmark-failed" :
      checks.some((check) => check.status === "warning") ? "benchmark-incomplete" : "benchmark-passed-review-required";
    return {
      buildingId: building.buildingId,
      category: building.category,
      status,
      candidate: { path: candidate.path ?? null, bytes: candidate.bytes ?? null, sha256: candidate.sha256 ?? null,
        expectedSha256Pinned: sameHash(candidate.expectedSha256, candidate.sha256), geometryQaStatus: geometry.status ?? "missing" },
      sourceCoverage: { requiredSides: [...REQUIRED_SOURCE_SIDES], coveredSides, sourceMediaCount: sourceMedia.length },
      sourceMediaEvidence: sourceMedia.map((item) => ({ id: item.id ?? null, path: item.path ?? null, kind: item.kind ?? null,
        side: item.side ?? null, sha256: item.sha256 ?? null, bytes: item.bytes ?? null, expectedSha256Pinned: sameHash(item.expectedSha256, item.sha256),
        rightsStatus: item.rightsStatus ?? "pending", rightsEvidenceId: item.rightsEvidenceId ?? null })),
      referenceImageEvidence: referenceImages.map((item) => ({ id: item.id ?? null, path: item.path ?? null, side: item.side ?? null,
        sha256: item.sha256 ?? null, bytes: item.bytes ?? null, expectedSha256Pinned: sameHash(item.expectedSha256, item.sha256),
        rightsStatus: item.rightsStatus ?? "pending", rightsEvidenceId: item.rightsEvidenceId ?? null })),
      renderEvidence: { manifestPath: render.manifestPath ?? null, manifestSha256: render.manifestSha256 ?? null,
        expectedManifestSha256: render.expectedManifestSha256 ?? null, modelSha256: render.modelSha256 ?? null,
        views: views.map((view) => ({ id: view.id ?? null, filename: view.filename ?? null, sha256: view.sha256 ?? null,
          bytes: view.bytes ?? null, width: view.width ?? null, height: view.height ?? null, verified: view.verified === true })) },
      dimensionAndGeoreferenceStatus: benchmark.status ?? "missing",
      verticalDatumStatus: vertical.status ?? "not-solved",
      checks,
      policy: { mapReady: false, publicationEligible: false, automaticApproval: false },
      limitations: [
        "Rights and survey provenance are operator-attested; file/hash checks do not authenticate legal ownership or survey validity.",
        "Geometry QA and renders do not prove hidden surfaces or architectural detail match reality.",
        "Horizontal ground-control residuals do not validate vertical datum or elevation.",
      ],
    };
  });

  const requiredCategories = buildings.length === 3
    ? ["complex-landmark", "ordinary-low-rise", "ordinary-high-rise"] : ["complex-landmark"];
  const coveragePass = requiredCategories.every((category) => categories.has(category)) && categories.size >= 2;
  const checks = [{ id: "representative-category-coverage", status: coveragePass ? "passed" : "failed",
    detail: buildings.length === 3
      ? "Three-building pilot must include a landmark, an ordinary low-rise and an ordinary high-rise."
      : "Two-building pilot must include a landmark and an ordinary building." },
    ...reports.flatMap((building) => building.checks.map((check) => ({ ...check, buildingId: building.buildingId })))];
  const status = checks.some((check) => check.status === "failed") || reports.some((item) => item.status === "benchmark-failed")
    ? "benchmark-failed"
    : checks.some((check) => check.status === "warning") || reports.some((item) => item.status !== "benchmark-passed-review-required")
      ? "benchmark-incomplete" : "benchmark-passed-review-required";
  return {
    schemaVersion: "1.0.0", engine: "building-accuracy-evidence-pack-v1", packId, generatedAt, candidateCommit, status,
    counts: { buildings: reports.length, passedReviewRequired: reports.filter((item) => item.status === "benchmark-passed-review-required").length,
      incomplete: reports.filter((item) => item.status === "benchmark-incomplete").length, failed: reports.filter((item) => item.status === "benchmark-failed").length,
      checksPassed: checks.filter((check) => check.status === "passed").length, checksWarning: checks.filter((check) => check.status === "warning").length,
      checksFailed: checks.filter((check) => check.status === "failed").length },
    checks, buildings: reports, policy: { mapReady: false, publicationEligible: false, automaticApproval: false },
    accuracyPercent: null,
    limitations: ["No combined accuracy percentage is produced.", "Missing evidence stays incomplete; failed measurements/references stay failed.",
      "A complete pack still requires final human/release review and never enables automatic publication."],
  };
}
