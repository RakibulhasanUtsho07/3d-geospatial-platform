const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const FLAGS = ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"];

function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function hash(v) { return typeof v === "string" && SHA256.test(v); }
function timestamp(v) { return typeof v === "string" && Number.isFinite(Date.parse(v)); }
function identifier(v) { return typeof v === "string" && ID.test(v); }
function https(v) {
  if (!nonEmpty(v)) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}
function add(checks, blockers, id, passed, detail) {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) blockers.push(id);
}
function rightsApproved(asset) {
  const r = asset?.rights;
  return object(r) && r.status === "approved" && hash(asset.sha256) &&
    typeof r.assetSha256 === "string" && r.assetSha256.toLowerCase() === asset.sha256.toLowerCase() &&
    https(r.evidenceUrl) && nonEmpty(r.attributionText) && nonEmpty(r.reviewedBy) &&
    timestamp(r.reviewedAt) && nonEmpty(r.scopeDescription);
}
function operationApproved(v) {
  return object(v) && v.status === "approved" && nonEmpty(v.operationId) &&
    nonEmpty(v.name) && nonEmpty(v.definition) && Number.isFinite(v.accuracyM) &&
    v.accuracyM >= 0 && nonEmpty(v.areaOfUse) && object(v.software) &&
    nonEmpty(v.software.name) && nonEmpty(v.software.version) &&
    nonEmpty(v.reviewedBy) && timestamp(v.reviewedAt) && hash(v.evidenceSha256);
}
function addRights(checks, blockers, id, asset, label) {
  const ok = rightsApproved(asset);
  add(checks, blockers, id, ok, ok
    ? label + " rights are evidence-backed and bound to the exact asset SHA-256."
    : label + " rights lack approved exact-asset scope, evidence URL, attribution, reviewer or timestamp.");
}
function result(manifest, checks, blockers) {
  return {
    schemaVersion: "1.0.0",
    evaluationId: object(manifest) && nonEmpty(manifest.evaluationId) ? manifest.evaluationId : "invalid-manifest",
    status: blockers.length ? "blocked-missing-or-invalid-evidence" : "evidence-complete-human-release-review-required",
    blockingCount: [...new Set(blockers)].length,
    blockers: [...new Set(blockers)],
    checks,
    candidateSelected: false,
    accuracyPassed: false,
    releaseFlags: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false },
    policy: "completeness check only; it does not grant rights, verify identity, execute a CRS transform, adjudicate accuracy, or approve release"
  };
}
function sourcePins(manifest, sourceReport, checks, blockers) {
  const source = object(sourceReport?.source) ? sourceReport.source : {};
  const bytes = object(sourceReport?.byteVerification) ? sourceReport.byteVerification : {};
  const geometry = object(sourceReport?.geometry) ? sourceReport.geometry : {};
  const model = object(manifest.sourceModel) ? manifest.sourceModel : {};
  const verified = sourceReport?.status === "full-object-hash-verified-xml-valid-geometry-extracted" &&
    bytes.status === "whole-object-sha256-and-size-verified" &&
    Number.isSafeInteger(bytes.actualBytes) && bytes.actualBytes > 0 &&
    hash(bytes.actualSha256) && bytes.actualBytes === source.lfsExpectedBytes &&
    bytes.actualSha256 === source.lfsExpectedSha256 &&
    geometry.fullXmlDocumentValidated === true && geometry.fullGeometryPayloadParsed === true;
  add(checks, blockers, "source-report-whole-object-verified", verified,
    verified ? "BRF-33 has a verified whole-object byte count/SHA-256 and full XML/geometry parse."
      : "BRF-33 source report is not in the expected verified state.");
  const pinsMatch = model.sourceProject === source.project && model.sourceCommit === source.commit &&
    model.sourcePath === source.path && model.repositoryBlobId === source.repositoryBlobId &&
    model.sha256 === bytes.actualSha256 && model.bytes === bytes.actualBytes &&
    model.sourceCrs === "EPSG:25832" && Array.isArray(geometry.buildingGmlIds) &&
    geometry.buildingGmlIds.includes(model.buildingGmlId) &&
    Array.isArray(geometry.srsNamesObserved) &&
    geometry.srsNamesObserved.some((v) => /(?:^|[:/])25832$/i.test(v));
  add(checks, blockers, "source-model-pins-match-brf33", pinsMatch,
    pinsMatch ? "Project/revision/path/blob ID/hash/size, explicit Building GML ID and source CRS match BRF-33."
      : "Model pins, explicit in-file Building GML ID or source CRS differ from BRF-33.");
}
function sourceRecords(manifest) {
  const records = [];
  const model = manifest.sourceModel;
  if (object(model)) records.push({ assetId: model.assetId, sha256: model.sha256, role: "citygml" });
  const assets = object(manifest.assets) ? manifest.assets : {};
  for (const v of Array.isArray(assets.imageFrames) ? assets.imageFrames : [])
    records.push({ assetId: v?.assetId, sha256: v?.sha256, role: "image" });
  if (object(assets.ulsCrop)) records.push({ assetId: assets.ulsCrop.assetId, sha256: assets.ulsCrop.sha256, role: "uls" });
  for (const v of Array.isArray(assets.surveyControls) ? assets.surveyControls : [])
    records.push({ assetId: v?.assetId, sha256: v?.sha256, role: "survey-control" });
  return records;
}
function validCheckpoint(point, surveyAssets, frameId) {
  if (!object(point) || !identifier(point.id) || point.independentOfFit !== true ||
      point.coordinateFrameId !== frameId || !Array.isArray(point.xyz) || point.xyz.length !== 3 ||
      point.xyz.some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
      typeof point.uncertaintyM !== "number" || !Number.isFinite(point.uncertaintyM) ||
      point.uncertaintyM < 0 || !identifier(point.sourceAssetId) || !hash(point.sourceSha256)) return false;
  const source = surveyAssets.find((v) => v.assetId === point.sourceAssetId);
  return Boolean(source && source.sha256?.toLowerCase() === point.sourceSha256.toLowerCase() && rightsApproved(source));
}

/**
 * Completeness and cross-reference validator only. It never flips a release
 * flag, even if a synthetic fixture satisfies every declared contract.
 */
export function validateBrf35BuildingLinkage(manifest, sourceReport) {
  const checks = [], blockers = [];
  if (!object(manifest) || manifest.schemaVersion !== "1.0.0") {
    add(checks, blockers, "manifest-schema", false, "Manifest must be an object with schemaVersion 1.0.0.");
    return result(manifest, checks, blockers);
  }
  add(checks, blockers, "evaluation-id", identifier(manifest.evaluationId), "evaluationId must be a stable safe identifier.");
  sourcePins(manifest, sourceReport, checks, blockers);

  const model = object(manifest.sourceModel) ? manifest.sourceModel : {};
  const frame = object(model.coordinateFrameReview) ? model.coordinateFrameReview : {};
  const frameOk = frame.status === "reviewed" && nonEmpty(frame.reviewedBy) && timestamp(frame.reviewedAt) &&
    hash(frame.evidenceSha256) && Array.isArray(frame.horizontalAxisOrder) &&
    frame.horizontalAxisOrder.length === 2 && frame.horizontalAxisOrder[0] === "E" &&
    frame.horizontalAxisOrder[1] === "N" && frame.verticalAxis === "H" &&
    frame.horizontalUnit === "m" && frame.verticalUnit === "m";
  add(checks, blockers, "source-axis-units-reviewed", frameOk,
    frameOk ? "Source axis order and units have a reviewed hash-bound record." : "Source axis order/units are not independently reviewed and hash-bound.");

  const assets = object(manifest.assets) ? manifest.assets : {};
  const images = Array.isArray(assets.imageFrames) ? assets.imageFrames : [];
  add(checks, blockers, "image-frames-present", images.length > 0,
    images.length > 0 ? "At least one image frame is declared." : "No matched image frame is declared.");
  const imageIds = new Set();
  for (const image of images) {
    const ok = object(image) && identifier(image.assetId) && !imageIds.has(image.assetId) &&
      hash(image.sha256) && Number.isSafeInteger(image.bytes) && image.bytes > 0 &&
      nonEmpty(image.view) && Number.isSafeInteger(image.width) && image.width > 0 &&
      Number.isSafeInteger(image.height) && image.height > 0 &&
      (https(image.sourceUri) || nonEmpty(image.sourcePath));
    add(checks, blockers, "image-frame-" + String(image?.assetId ?? "invalid") + "-metadata", ok,
      ok ? "Image frame has a unique ID, source, hash/size and positive dimensions." : "Image frame metadata or pins are invalid.");
    if (identifier(image?.assetId)) imageIds.add(image.assetId);
    addRights(checks, blockers, "image-frame-" + String(image?.assetId ?? "invalid") + "-rights", image, "Image frame");
  }

  const uls = object(assets.ulsCrop) ? assets.ulsCrop : null;
  const ulsOk = Boolean(uls && identifier(uls.assetId) && hash(uls.sha256) &&
    Number.isSafeInteger(uls.bytes) && uls.bytes > 0 &&
    Number.isSafeInteger(uls.pointCount) && uls.pointCount > 0 &&
    (https(uls.sourceUri) || nonEmpty(uls.sourcePath)) && uls.horizontalCrs === "EPSG:32632" &&
    nonEmpty(uls.verticalCrs) && !/^(unknown|tbd|unspecified|none)$/i.test(uls.verticalCrs) &&
    nonEmpty(uls.evaluationFrameId));
  add(checks, blockers, "uls-crop-present-and-framed", ulsOk,
    ulsOk ? "ULS crop has hash/size, point count, horizontal CRS and a named vertical frame." :
      "ULS crop or its horizontal/vertical metric frame is missing or unresolved.");
  if (uls) addRights(checks, blockers, "uls-crop-rights", uls, "ULS crop");

  const surveys = Array.isArray(assets.surveyControls) ? assets.surveyControls : [];
  add(checks, blockers, "survey-control-source-present", surveys.length > 0,
    surveys.length > 0 ? "A separate survey/control source is declared." : "No independent survey/checkpoint source is declared.");
  const surveyIds = new Set();
  for (const survey of surveys) {
    const ok = object(survey) && identifier(survey.assetId) && !surveyIds.has(survey.assetId) &&
      hash(survey.sha256) && Number.isSafeInteger(survey.bytes) && survey.bytes > 0 &&
      (https(survey.sourceUri) || nonEmpty(survey.sourcePath));
    add(checks, blockers, "survey-source-" + String(survey?.assetId ?? "invalid") + "-metadata", ok,
      ok ? "Survey/control source has a unique ID, source, hash and size." : "Survey/control source metadata is invalid.");
    if (identifier(survey?.assetId)) surveyIds.add(survey.assetId);
    addRights(checks, blockers, "survey-source-" + String(survey?.assetId ?? "invalid") + "-rights", survey, "Survey/control source");
  }
  addRights(checks, blockers, "citygml-source-rights", model, "CityGML source");

  const identity = object(manifest.identity) ? manifest.identity : {};
  const refs = Array.isArray(identity.evidenceRefs) ? identity.evidenceRefs : [];
  const records = sourceRecords(manifest);
  const refsValid = refs.every((ref) => object(ref) && identifier(ref.assetId) &&
    hash(ref.sha256) && nonEmpty(ref.role) && records.some((asset) =>
      asset.assetId === ref.assetId && asset.sha256?.toLowerCase() === ref.sha256.toLowerCase() && asset.role === ref.role));
  const roles = new Set(refs.map((ref) => ref?.role));
  const identityOk = identity.status === "reviewed" && identity.samePhysicalBuildingConfirmed === true &&
    nonEmpty(identity.reviewer) && timestamp(identity.reviewedAt) && nonEmpty(identity.method) &&
    hash(identity.decisionEvidenceSha256) && refs.length >= 3 && refsValid &&
    roles.has("citygml") && roles.has("image") && roles.has("uls") &&
    refs.some((ref) => ref.assetId === model.assetId) &&
    Boolean(uls && refs.some((ref) => ref.assetId === uls.assetId)) &&
    images.some((image) => refs.some((ref) => ref.assetId === image.assetId));
  add(checks, blockers, "same-building-linkage-reviewed", identityOk,
    identityOk ? "Human review links the exact CityGML, image and ULS asset hashes." :
      "A hash-bound, human-reviewed three-way same-building identity record is missing or invalid.");

  const coord = object(manifest.coordinateOperation) ? manifest.coordinateOperation : {};
  const horizontal = object(coord.horizontal) ? coord.horizontal : {};
  const vertical = object(coord.vertical) ? coord.vertical : {};
  const frameId = coord.evaluationFrameId;
  const horizontalOk = coord.status === "approved" && coord.sourceHorizontalCrs === "EPSG:25832" &&
    coord.targetHorizontalCrs === "EPSG:32632" && nonEmpty(frameId) && operationApproved(horizontal);
  add(checks, blockers, "horizontal-operation-approved", horizontalOk,
    horizontalOk ? "Horizontal operation has a definition, accuracy, area, software version and review evidence." :
      "Approved EPSG:25832-to-EPSG:32632 operation evidence is missing or incomplete.");

  const sourceZ = model.verticalCrs, targetZ = uls?.verticalCrs;
  const verticalOk = coord.status === "approved" && nonEmpty(sourceZ) &&
    !/^(unknown|tbd|unspecified|none)$/i.test(sourceZ) && nonEmpty(targetZ) &&
    !/^(unknown|tbd|unspecified|none)$/i.test(targetZ) && vertical.sourceCrs === sourceZ &&
    vertical.targetCrs === targetZ && operationApproved(vertical) &&
    (sourceZ !== targetZ || hash(vertical.sameDatumEvidenceSha256)) &&
    (!uls || uls.evaluationFrameId === frameId);
  add(checks, blockers, "vertical-frame-operation-approved", verticalOk,
    verticalOk ? "Vertical datum/operation or hash-backed same-datum evidence is explicit." :
      "Source/target vertical datum or approved reproducible vertical operation is missing.");

  const candidate = object(manifest.candidateGlb) ? manifest.candidateGlb : {};
  const candidateOk = candidate.status === "generated" && candidate.role === "platform-reconstruction-candidate" &&
    identifier(candidate.assetId) && hash(candidate.sha256) && nonEmpty(candidate.path) &&
    candidate.pipeline === "platform-reconstruction-pipeline" &&
    hash(candidate.generationProvenanceSha256) &&
    candidate.sha256.toLowerCase() !== model.sha256?.toLowerCase();
  add(checks, blockers, "platform-candidate-glb-present", candidateOk,
    candidateOk ? "A separate platform reconstruction candidate GLB is provenance/hash-bound." :
      "Distinct platform-generated candidate GLB is missing; a source-reference GLB cannot replace it.");

  const accuracy = object(manifest.accuracy) ? manifest.accuracy : {};
  const points = Array.isArray(accuracy.heldOutCheckpoints) ? accuracy.heldOutCheckpoints : [];
  const pointIds = new Set();
  const pointsOk = points.length >= 3 && points.every((point) => {
    const ok = validCheckpoint(point, surveys, frameId) && !pointIds.has(point.id);
    if (identifier(point?.id)) pointIds.add(point.id);
    return ok;
  });
  add(checks, blockers, "held-out-checkpoints-independent", pointsOk,
    pointsOk ? "At least three unique controls are hash-linked, same-frame and independent of fitting." :
      "At least three unique hash-linked survey checkpoints independent of fitting are required.");

  const accuracyOk = accuracy.status === "reviewed" &&
    accuracy.candidateGlbSha256?.toLowerCase() === candidate.sha256?.toLowerCase() &&
    accuracy.referenceSourceSha256?.toLowerCase() === model.sha256?.toLowerCase() &&
    hash(accuracy.evaluationReportSha256) && nonEmpty(accuracy.thresholdPolicyId) &&
    nonEmpty(accuracy.reviewer) && timestamp(accuracy.reviewedAt);
  add(checks, blockers, "accuracy-result-reviewed-and-bound", accuracyOk,
    accuracyOk ? "Reviewed accuracy report is tied to exact candidate/reference hashes and threshold policy." :
      "Reviewed accuracy result is missing or not bound to the exact candidate/reference hashes.");

  const visual = object(manifest.visualReview) ? manifest.visualReview : {};
  const visualOk = visual.status === "approved" && nonEmpty(visual.reviewer) &&
    timestamp(visual.reviewedAt) && hash(visual.renderManifestSha256);
  add(checks, blockers, "fixed-view-visual-review-approved", visualOk,
    visualOk ? "Human fixed-view review is bound to a render-manifest SHA-256." :
      "Approved fixed-view visual review is missing or not hash-bound.");

  const flags = object(manifest.releaseFlags) ? manifest.releaseFlags : {};
  const flagsOff = FLAGS.every((flag) => flags[flag] === false);
  add(checks, blockers, "release-flags-remain-disabled", flagsOff,
    flagsOff ? "Every release flag is false." : "An input release flag was enabled; output release flags remain false.");
  return result(manifest, checks, blockers);
}
