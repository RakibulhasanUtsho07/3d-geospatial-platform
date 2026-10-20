const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PROVIDER_FILE_TOKEN_PATTERN = /^file_[A-Za-z0-9_-]{4,240}$/;
const REFERENCE_KINDS = new Set(["image", "video", "floor-plan", "elevation", "blueprint"]);
const PURPOSES = new Set(["actual-building", "style-reference", "plan"]);
const PERMISSIONS = new Set(["authorized", "research-only", "unknown"]);
const VIEWS = new Set(["front", "left", "back", "right", "oblique", "top", "unknown"]);
const QUALITIES = new Set(["massing", "parametric-facade", "reference-assisted", "multi-view-reconstruction"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(name + " must be a finite number in [" + min + ", " + max + "].");
  }
  return value;
}
function optionalText(value, name, max = 300) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(name + " must be a non-empty string of at most " + max + " characters.");
  }
  return value.trim();
}
function normalizeTextArray(value, name, maxItems = 20) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(name + " must be an array with at most " + maxItems + " items.");
  return [...new Set(value.map((item) => optionalText(item, name + " item", 120)))];
}
function normalizeFootprint(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("footprint must be an object.");
  const hasWidth = value.widthMeters !== undefined;
  const hasDepth = value.depthMeters !== undefined;
  if (hasWidth !== hasDepth) throw new TypeError("footprint widthMeters and depthMeters must be supplied together.");
  const result = {};
  if (hasWidth) {
    result.widthMeters = finite(value.widthMeters, "footprint widthMeters", 1, 1000);
    result.depthMeters = finite(value.depthMeters, "footprint depthMeters", 1, 1000);
  }
  if (value.polygonXYMeters !== undefined) {
    if (!Array.isArray(value.polygonXYMeters) || value.polygonXYMeters.length < 3 || value.polygonXYMeters.length > 1000) {
      throw new TypeError("footprint polygonXYMeters must contain 3 to 1000 points.");
    }
    const points = value.polygonXYMeters.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 2) throw new TypeError("footprint point " + index + " must be an [x, y] pair.");
      return [
        finite(point[0], "footprint point x", -1000, 1000),
        finite(point[1], "footprint point y", -1000, 1000),
      ];
    });
    const distinct = new Set(points.map((point) => point[0] + "," + point[1]));
    if (distinct.size < 3) throw new RangeError("footprint polygon needs at least 3 distinct points.");
    result.polygonXYMeters = points;
  }
  if (!hasWidth && !result.polygonXYMeters) throw new TypeError("footprint needs width/depth or polygonXYMeters.");
  return result;
}
function normalizeReference(value, index) {
  if (!isRecord(value)) throw new TypeError("reference " + index + " must be an object.");
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) throw new TypeError("reference " + index + " has an invalid id.");
  if (!REFERENCE_KINDS.has(value.kind)) throw new TypeError("reference " + index + " has an unsupported kind.");
  if (!PURPOSES.has(value.purpose)) throw new TypeError("reference " + index + " has an unsupported purpose.");
  if (!PERMISSIONS.has(value.permission)) throw new TypeError("reference " + index + " has an unsupported permission.");
  if (typeof value.assetId !== "string" || !ASSET_ID_PATTERN.test(value.assetId)) throw new TypeError("reference " + index + " has an invalid internal assetId.");
  if (value.view !== undefined && !VIEWS.has(value.view)) throw new TypeError("reference " + index + " has an unsupported view label.");
  if (value.providerFileToken !== undefined && (typeof value.providerFileToken !== "string" || !PROVIDER_FILE_TOKEN_PATTERN.test(value.providerFileToken))) {
    throw new TypeError("reference " + index + " has an invalid provider file token.");
  }
  if (value.derivedFromReferenceId !== undefined && (typeof value.derivedFromReferenceId !== "string" || !ID_PATTERN.test(value.derivedFromReferenceId))) {
    throw new TypeError("reference " + index + " has an invalid source-video reference ID.");
  }
  if (value.timestampSeconds !== undefined) finite(value.timestampSeconds, "reference timestampSeconds", 0, 86400);
  if (value.derivedFromReferenceId !== undefined && value.kind !== "image") {
    throw new TypeError("Only image references can be extracted from a source video.");
  }
  const result = {
    id: value.id,
    kind: value.kind,
    purpose: value.purpose,
    permission: value.permission,
    assetId: value.assetId,
  };
  if (value.view !== undefined) result.view = value.view;
  if (value.providerFileToken !== undefined) result.providerFileToken = value.providerFileToken;
  if (value.derivedFromReferenceId !== undefined) result.derivedFromReferenceId = value.derivedFromReferenceId;
  if (value.timestampSeconds !== undefined) result.timestampSeconds = value.timestampSeconds;
  if (value.sourceLabel !== undefined) result.sourceLabel = optionalText(value.sourceLabel, "sourceLabel", 240);
  if (value.licence !== undefined) result.licence = optionalText(value.licence, "licence", 240);
  return result;
}

export function normalizeBuildingGenerationRequest(value) {
  if (!isRecord(value)) throw new TypeError("Building generation request must be an object.");
  if (value.schemaVersion !== 1) throw new RangeError("schemaVersion must be 1.");
  if (typeof value.requestId !== "string" || !ID_PATTERN.test(value.requestId)) throw new TypeError("requestId is invalid.");
  if (!isRecord(value.building)) throw new TypeError("building must be an object.");
  if (!QUALITIES.has(value.quality)) throw new TypeError("quality is unsupported.");
  if (typeof value.allowExternalProviderProcessing !== "boolean") {
    throw new TypeError("allowExternalProviderProcessing must be an explicit boolean.");
  }

  const dimensionsIn = isRecord(value.building.dimensions) ? value.building.dimensions : {};
  const dimensions = {};
  if (dimensionsIn.totalHeightMeters !== undefined) dimensions.totalHeightMeters = finite(dimensionsIn.totalHeightMeters, "totalHeightMeters", 2, 1000);
  if (dimensionsIn.aboveGroundFloors !== undefined) {
    const floors = finite(dimensionsIn.aboveGroundFloors, "aboveGroundFloors", 1, 200);
    if (!Number.isInteger(floors)) throw new TypeError("aboveGroundFloors must be an integer.");
    dimensions.aboveGroundFloors = floors;
  }
  if (dimensionsIn.floorToFloorHeightMeters !== undefined) dimensions.floorToFloorHeightMeters = finite(dimensionsIn.floorToFloorHeightMeters, "floorToFloorHeightMeters", 2, 12);
  if (dimensionsIn.basementFloors !== undefined) {
    const floors = finite(dimensionsIn.basementFloors, "basementFloors", 0, 20);
    if (!Number.isInteger(floors)) throw new TypeError("basementFloors must be an integer.");
    dimensions.basementFloors = floors;
  }

  const footprint = normalizeFootprint(value.building.footprint);
  const buildingType = optionalText(value.building.buildingType, "buildingType", 100);
  if (!buildingType) throw new TypeError("buildingType is required.");
  const building = { buildingType, dimensions };
  for (const key of ["name", "architecturalStyle", "designBrief", "roofType"]) {
    const text = optionalText(value.building[key], key, key === "designBrief" ? 2000 : 240);
    if (text !== undefined) building[key] = text;
  }
  if (footprint) building.footprint = footprint;
  if (value.building.frontAzimuthDegrees !== undefined) building.frontAzimuthDegrees = finite(value.building.frontAzimuthDegrees, "frontAzimuthDegrees", -360, 360);
  const facadeMaterials = normalizeTextArray(value.building.facadeMaterials, "facadeMaterials");
  const facadeColours = normalizeTextArray(value.building.facadeColours, "facadeColours");
  if (facadeMaterials !== undefined) building.facadeMaterials = facadeMaterials;
  if (facadeColours !== undefined) building.facadeColours = facadeColours;

  if (!Array.isArray(value.references) || value.references.length > 100) throw new TypeError("references must be an array with at most 100 items.");
  const references = value.references.map(normalizeReference);
  const ids = new Set();
  for (const ref of references) {
    if (ids.has(ref.id)) throw new TypeError("reference IDs must be unique.");
    ids.add(ref.id);
  }
  const byId = new Map(references.map((ref) => [ref.id, ref]));
  for (const ref of references) {
    if (ref.derivedFromReferenceId !== undefined) {
      const source = byId.get(ref.derivedFromReferenceId);
      if (!source || source.kind !== "video") throw new TypeError("An extracted image must reference an existing video asset.");
      if (source.permission !== "authorized" || ref.permission !== "authorized") {
        throw new TypeError("Video and extracted frames must both be authorized before provider processing.");
      }
    }
  }
  if (!building.designBrief && !building.architecturalStyle && references.length === 0) {
    throw new TypeError("Provide a designBrief/style or at least one image, video, drawing or blueprint reference.");
  }
  if (!Object.keys(dimensions).length && references.length === 0 && !building.designBrief && !building.architecturalStyle) {
    throw new TypeError("Provide measurable dimensions, a design brief, or reference assets.");
  }
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    building,
    references,
    quality: value.quality,
    allowExternalProviderProcessing: value.allowExternalProviderProcessing,
  };
}

export function planBuildingGeneration(requestValue) {
  const request = normalizeBuildingGenerationRequest(requestValue);
  const refs = request.references;
  const actualImages = refs.filter((ref) => ref.kind === "image" && ref.purpose === "actual-building");
  const actualVideos = refs.filter((ref) => ref.kind === "video" && ref.purpose === "actual-building" && ref.permission === "authorized");
  const authorizedImages = refs.filter((ref) => ref.kind === "image" && ref.purpose === "actual-building" && ref.permission === "authorized");
  const authorizedActualImages = actualImages.filter((ref) => ref.permission === "authorized");
  const planImages = refs.filter((ref) => ["floor-plan", "elevation", "blueprint"].includes(ref.kind));
  const hasRectangle = Boolean(request.building.footprint?.widthMeters && request.building.footprint?.depthMeters);
  const hasPolygon = Boolean(request.building.footprint?.polygonXYMeters);
  const hasFootprint = hasRectangle || hasPolygon;
  const hasHeight = request.building.dimensions.totalHeightMeters !== undefined ||
    (request.building.dimensions.aboveGroundFloors !== undefined && request.building.dimensions.floorToFloorHeightMeters !== undefined);
  const canGenerateParametricBase = hasFootprint && hasHeight;
  const warnings = [];
  const missingInputs = [];
  const qualityNotes = [];
  const externalProviderRequired = request.quality === "reference-assisted" || request.quality === "multi-view-reconstruction";

  if (!hasFootprint) missingInputs.push("A measured footprint (width/depth or a local-metre polygon) is needed for a dimension-controlled base model.");
  if (!hasHeight) missingInputs.push("Provide totalHeightMeters or aboveGroundFloors plus floorToFloorHeightMeters for a dimension-controlled base model.");
  if (request.building.dimensions.totalHeightMeters === undefined &&
      request.building.dimensions.aboveGroundFloors !== undefined &&
      request.building.dimensions.floorToFloorHeightMeters !== undefined) {
    qualityNotes.push("Total height is derived from floor count and floor-to-floor height; roof/parapet can change the final height.");
  }
  if (!authorizedActualImages.length && !actualVideos.length) qualityNotes.push("No authorized actual-building photo/video is supplied; model appearance must not be claimed as a verified reconstruction.");
  if (refs.some((ref) => ref.permission !== "authorized") && request.allowExternalProviderProcessing) {
    warnings.push("Some references are not marked authorized. Only explicitly authorized assets may be sent to an external generation provider.");
  }
  if (!request.allowExternalProviderProcessing && externalProviderRequired) {
    warnings.push("External model generation was requested but external processing is not approved; continue with a procedural base or wait for approval.");
  }
  if (planImages.length) qualityNotes.push("Plans/elevations are retained as constraints and references; they are not automatically treated as a valid editable BIM model.");

  const stages = ["validate-inputs", "prepare-reference-assets"];
  if (actualVideos.length) {
    stages.push("extract-video-keyframes", "select-and-label-frames");
    qualityNotes.push("Video must be decoded to selected frames before image/multiview AI. For metric reconstruction, selected frames need sufficient overlap and a scale/georeference control.");
  }

  const distinctViews = new Set(authorizedActualImages.map((ref) => ref.view).filter((view) => ["front", "left", "back", "right"].includes(view)));
  const hasMultipleAuthorizedViews = distinctViews.size >= 2 && authorizedActualImages.length >= 2;
  const enoughReconstructionViews = distinctViews.size >= 3 && authorizedActualImages.length >= 3;

  if (request.quality === "multi-view-reconstruction") {
    if (!request.allowExternalProviderProcessing) {
      return {
        strategy: canGenerateParametricBase ? "parametric-only" : "needs-more-inputs",
        stages: [...stages, ...(canGenerateParametricBase ? ["generate-parametric-base"] : []), "admin-review"],
        canGenerateParametricBase, externalProviderRequired: true, blocked: true,
        warnings, missingInputs, qualityNotes,
      };
    }
    if (!enoughReconstructionViews && !actualVideos.length) {
      missingInputs.push("For reconstruction, provide an overlapping image set from multiple labelled views with rights cleared; a single image cannot recover hidden surfaces.");
      return {
        strategy: canGenerateParametricBase ? "parametric-only" : "needs-more-inputs",
        stages: [...stages, ...(canGenerateParametricBase ? ["generate-parametric-base"] : []), "admin-review"],
        canGenerateParametricBase, externalProviderRequired: true, blocked: true,
        warnings, missingInputs, qualityNotes,
      };
    }
    if (!hasFootprint || !hasHeight) missingInputs.push("A measured footprint and height strategy (or external scale control) are needed before metric alignment.");
    stages.push("reconstruct-photogrammetry", "align-to-authoritative-dimensions", "mesh-cleanup-and-optimize", "validate-glb", "admin-review");
    qualityNotes.push("Photogrammetry is a candidate reconstruction, not guaranteed to recover occluded facades; Admin review remains mandatory.");
    return {
      strategy: "photogrammetry-candidate", stages, canGenerateParametricBase,
      externalProviderRequired: true, blocked: !hasFootprint || !hasHeight, warnings, missingInputs, qualityNotes,
    };
  }

  if (request.quality === "massing" || request.quality === "parametric-facade") {
    if (!canGenerateParametricBase) {
      missingInputs.push("Massing generation is blocked until both a footprint and a height strategy are supplied.");
      return { strategy: "needs-more-inputs", stages: [...stages, "admin-review"], canGenerateParametricBase, externalProviderRequired: false, blocked: true, warnings, missingInputs, qualityNotes };
    }
    stages.push("generate-parametric-base", "mesh-cleanup-and-optimize", "validate-glb", "admin-review");
    return { strategy: "parametric-only", stages, canGenerateParametricBase, externalProviderRequired: false, blocked: false, warnings, missingInputs, qualityNotes };
  }

  if (!request.allowExternalProviderProcessing) {
    const allowed = canGenerateParametricBase;
    if (allowed) stages.push("generate-parametric-base");
    stages.push("admin-review");
    return {
      strategy: allowed ? "parametric-only" : "needs-more-inputs",
      stages, canGenerateParametricBase: allowed, externalProviderRequired: true,
      blocked: true, warnings, missingInputs, qualityNotes,
    };
  }

  if (authorizedImages.length === 0 && actualVideos.length === 0) {
    warnings.push("No reference is explicitly authorized for external generation.");
    if (canGenerateParametricBase) {
      stages.push("generate-parametric-base", "mesh-cleanup-and-optimize", "validate-glb", "admin-review");
      return { strategy: "parametric-only", stages, canGenerateParametricBase, externalProviderRequired: false, blocked: false, warnings, missingInputs, qualityNotes };
    }
    missingInputs.push("Authorize source media for external processing or supply a measured footprint and height strategy.");
    return { strategy: "needs-more-inputs", stages: [...stages, "admin-review"], canGenerateParametricBase, externalProviderRequired: true, blocked: true, warnings, missingInputs, qualityNotes };
  }

  if (actualVideos.some((ref) => ref.permission === "authorized")) {
    stages.push("submit-ai-generation", "poll-ai-task", "align-to-authoritative-dimensions", "mesh-cleanup-and-optimize", "validate-glb", "admin-review");
    qualityNotes.push("Video must be converted to reviewed keyframes first. Keyframe-based AI output is not the same as calibrated photogrammetry.");
    return { strategy: "video-keyframes-then-ai", stages, canGenerateParametricBase, externalProviderRequired: true, blocked: false, warnings, missingInputs, qualityNotes };
  }

  if (hasMultipleAuthorizedViews) {
    stages.push(...(canGenerateParametricBase ? ["generate-parametric-base"] : []), "submit-ai-generation", "poll-ai-task", "align-to-authoritative-dimensions", "mesh-cleanup-and-optimize", "validate-glb", "admin-review");
    qualityNotes.push("Multiview AI can improve appearance coverage, but generated geometry still needs footprint, scale and orientation QA.");
    return { strategy: "parametric-plus-ai-multiview", stages, canGenerateParametricBase, externalProviderRequired: true, blocked: false, warnings, missingInputs, qualityNotes };
  }

  if (authorizedActualImages.length > 1 && !hasMultipleAuthorizedViews) {
    missingInputs.push("Multiple building photos are present but are not labelled as at least two distinct views (front/left/back/right). Label the views or select one image for the single-photo pipeline.");
    return {
      strategy: "needs-more-inputs",
      stages: [...stages, "admin-review"],
      canGenerateParametricBase,
      externalProviderRequired: true,
      blocked: true,
      warnings, missingInputs, qualityNotes,
    };
  }

  if (authorizedImages.length > 0) {
    stages.push(
      "submit-image-to-multiview",
      "poll-image-to-multiview",
      "submit-multiview-to-model",
      "poll-multiview-to-model",
      "align-to-authoritative-dimensions",
      "mesh-cleanup-and-optimize",
      "validate-glb",
      "admin-review",
    );
    qualityNotes.push("Single-photo generation first synthesizes additional views. Those views are AI-inferred, not measured; hidden surfaces and dimensions must be reviewed.");
    return { strategy: "parametric-plus-ai-image-multiview", stages, canGenerateParametricBase, externalProviderRequired: true, blocked: false, warnings, missingInputs, qualityNotes };
  }

  if (canGenerateParametricBase) {
    stages.push("generate-parametric-base", "mesh-cleanup-and-optimize", "validate-glb", "admin-review");
    return { strategy: "parametric-only", stages, canGenerateParametricBase, externalProviderRequired: false, blocked: false, warnings, missingInputs, qualityNotes };
  }
  missingInputs.push("Supply authorized reference media or a footprint plus height strategy.");
  return { strategy: "needs-more-inputs", stages: [...stages, "admin-review"], canGenerateParametricBase, externalProviderRequired, blocked: true, warnings, missingInputs, qualityNotes };
}

export const BUILDING_GENERATION_POLICY = Object.freeze({
  maxReferences: 100,
  maxFootprintPoints: 1000,
  maxDimensionsMeters: 1000,
  supportedQuality: Object.freeze([...QUALITIES]),
});
