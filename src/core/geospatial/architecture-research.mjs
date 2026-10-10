const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

function boundedInteger(params, key, fallback, min, max) {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: key + " must be a whole number between " + min + " and " + max + "." };
  }
  return { ok: true, value };
}

function boundedText(params, key, maxLength, minimum = 0) {
  const raw = params.get(key);
  if (raw === null) return { ok: true, value: "" };
  const value = raw.trim();
  if (value.length > maxLength) return { ok: false, error: key + " must not exceed " + maxLength + " characters." };
  if (value.length > 0 && value.length < minimum) return { ok: false, error: key + " must contain at least " + minimum + " characters." };
  return { ok: true, value };
}

export function parseArchitectureResearchParams(params) {
  const query = boundedText(params, "q", 100, 2);
  if (!query.ok) return query;
  const area = boundedText(params, "area", 100);
  if (!area.ok) return area;
  const style = boundedText(params, "style", 100);
  if (!style.ok) return style;
  const mediaType = boundedText(params, "mediaType", 16);
  if (!mediaType.ok) return mediaType;
  const usage = boundedText(params, "usage", 24);
  if (!usage.ok) return usage;

  const limit = boundedInteger(params, "limit", DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  if (!limit.ok) return limit;
  if (mediaType.value && !["image", "video", "all"].includes(mediaType.value)) {
    return { ok: false, error: "mediaType must be image, video, or all." };
  }
  if (usage.value && !["all", "open", "research-only"].includes(usage.value)) {
    return { ok: false, error: "usage must be all, open, or research-only." };
  }

  return {
    ok: true,
    value: {
      query: query.value.toLowerCase(),
      area: area.value.toLowerCase(),
      style: style.value.toLowerCase(),
      mediaType: mediaType.value || "all",
      usage: usage.value || "all",
      limit: limit.value,
    },
  };
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function referenceSearchText(reference) {
  const profile = reference.designProfile ?? {};
  const features = Array.isArray(reference.observedFeatures) ? reference.observedFeatures.join(" ") : "";
  const profileFeatures = Array.isArray(profile.facadeFeatures) ? profile.facadeFeatures.join(" ") : "";
  const palette = Array.isArray(profile.colorPalette)
    ? profile.colorPalette.map((color) => [color.name, color.hex].join(" ")).join(" ")
    : "";
  const reported = reference.reportedBuildingMetadata && typeof reference.reportedBuildingMetadata === "object"
    ? JSON.stringify(reference.reportedBuildingMetadata)
    : "";
  return [
    reference.id,
    reference.title,
    reference.sourceName,
    reference.author,
    reference.locationText,
    reference.license,
    reference.usageStatus,
    profile.styleFamily,
    features,
    profileFeatures,
    palette,
    reported,
  ].map(stringValue).join(" ").toLowerCase();
}

function matchesUsage(reference, usage) {
  if (usage === "all") return true;
  const status = stringValue(reference.usageStatus).toLowerCase();
  if (usage === "open") return status.includes("open-licence") || status.includes("open-license");
  return status.includes("research-only") || status.includes("not established") || status.includes("not established.");
}

export function filterArchitectureReferences(references, request) {
  if (!Array.isArray(references)) return [];
  return references.filter((reference) => {
    if (!reference || typeof reference !== "object") return false;
    if (request.mediaType !== "all" && reference.mediaType !== request.mediaType) return false;
    if (request.query && !referenceSearchText(reference).includes(request.query)) return false;
    if (request.area && !stringValue(reference.locationText).toLowerCase().includes(request.area)) return false;
    if (request.style && !stringValue(reference.designProfile?.styleFamily).toLowerCase().includes(request.style)) return false;
    if (!matchesUsage(reference, request.usage)) return false;
    return true;
  });
}

export function summarizeArchitectureReferences(references) {
  const safeReferences = Array.isArray(references) ? references : [];
  const areaSet = new Set();
  const styleSet = new Set();
  for (const reference of safeReferences) {
    const area = stringValue(reference.locationText).trim();
    const style = stringValue(reference.designProfile?.styleFamily).trim();
    if (area) areaSet.add(area);
    if (style) styleSet.add(style);
  }
  return {
    totalReferences: safeReferences.length,
    imageCount: safeReferences.filter((reference) => reference.mediaType === "image").length,
    videoCount: safeReferences.filter((reference) => reference.mediaType === "video").length,
    styles: [...styleSet].sort((a, b) => a.localeCompare(b)),
    areas: [...areaSet].sort((a, b) => a.localeCompare(b)),
  };
}

export function createArchitectureStylePreview(reference) {
  const family = String(reference?.designProfile?.styleFamily ?? "").toLowerCase();
  const palette = Array.isArray(reference?.designProfile?.colorPalette)
    ? reference.designProfile.colorPalette
    : [];
  const facade = palette.find((swatch) => typeof swatch?.hex === "string")?.hex ?? "#D9DFE0";
  const roof = palette.find((swatch) => /roof|concrete|stone|trim/i.test(String(swatch?.name ?? "")) && /^#[0-9a-f]{6}$/i.test(String(swatch?.hex ?? "")))?.hex
    ?? palette[1]?.hex
    ?? "#A9AFB2";
  const accent = palette.find((swatch) => /green|plant|metal|window|balcony|ochre/i.test(String(swatch?.name ?? "")) && /^#[0-9a-f]{6}$/i.test(String(swatch?.hex ?? "")))?.hex
    ?? palette[2]?.hex
    ?? "#91A8B5";
  let pattern = "urban-grid";
  if (/heritage|historic|courtyard|old-dhaka|mansion/.test(family)) {
    pattern = "heritage-arches";
  } else if (/biophilic|climate-responsive|green-facade|vine/.test(family)) {
    pattern = "biophilic-balcony";
  } else if (/painted|blue-ochre|mugda/.test(family)) {
    pattern = "painted-balcony";
  } else if (/modernist|brick/.test(family)) {
    pattern = "brick-modernist";
  } else if (/apartment|residential|balcony/.test(family)) {
    pattern = "balcony";
  } else if (/glass/.test(family)) {
    pattern = "vertical-glass";
  }
  return {
    id: "research-preview-" + String(reference?.id ?? "unknown"),
    facadeColor: facade,
    roofColor: roof,
    accentColor: accent,
    pattern,
    roofDetail: "none",
    repeatWidthMeters: 6.2,
  };
}
