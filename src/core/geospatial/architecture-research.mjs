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
  const profile = reference?.designProfile ?? {};
  const family = String(profile.styleFamily ?? "").toLowerCase();
  const facadeFeatures = Array.isArray(profile.facadeFeatures) ? profile.facadeFeatures : [];
  const roofFeatures = Array.isArray(profile.roofFeatures) ? profile.roofFeatures : [];
  const features = facadeFeatures.join(" ").toLowerCase();
  const roofDescription = roofFeatures.join(" ").toLowerCase();
  const buildingMetadataText = reference?.reportedBuildingMetadata && typeof reference.reportedBuildingMetadata === "object"
    ? JSON.stringify(reference.reportedBuildingMetadata).toLowerCase()
    : "";
  const roofEvidence = roofDescription + " " + buildingMetadataText;
  const colors = Array.isArray(profile.colorPalette) ? profile.colorPalette : [];
  const paletteNames = colors.map((swatch) => String(swatch?.name ?? "")).join(" ").toLowerCase();
  const materialHints = family + " " + features + " " + paletteNames;
  const colorBy = (pattern, fallback) => colors.find((swatch) =>
    pattern.test(String(swatch?.name ?? "")) && /^#[0-9a-f]{6}$/i.test(String(swatch?.hex ?? ""))
  )?.hex ?? fallback;
  const facade = colors.find((swatch) => /^#[0-9a-f]{6}$/i.test(String(swatch?.hex ?? "")))?.hex ?? "#D9DFE0";
  const roof = colorBy(/roof|concrete|stone|trim|shadow/, colors[1]?.hex ?? "#A9AFB2");
  const accent = colorBy(/green|plant|metal|window|balcony|ochre|yellow|wood/, colors[2]?.hex ?? "#91A8B5");
  let pattern = "urban-grid";
  if (/heritage|historic|courtyard|old-dhaka|mansion/.test(family) || /arched|corinthian|fluted columns|ornamental|tracery/.test(features)) {
    pattern = "heritage-arches";
  } else if (/biophilic|climate-responsive|green-facade|vine/.test(family) || /planter|creeper|vine|potted plants|green screen/.test(features)) {
    pattern = "biophilic-balcony";
  } else if (/painted|blue-ochre|mugda/.test(family) || /blue\/yellow|blue\/yellow|yellow facade zoning|symmetrical bay rhythm/.test(features)) {
    pattern = "painted-balcony";
  } else if (/modernist|brick/.test(family) || /fair-faced brick|exposed brick/.test(features)) {
    pattern = "brick-modernist";
  } else if (/apartment|residential|balcony|tower/.test(family) || /balcon/.test(features)) {
    pattern = "balcony";
  } else if (/glass/.test(family) || /glass/.test(features)) {
    pattern = "vertical-glass";
  }

  const materialPattern =
    /brick|masonry|terracotta|fair-faced-red-brick|brick-cladding/.test(materialHints) ? "brick"
      : /weathered|aged-plaster/.test(materialHints) ? "weathered"
        : /white.*glass|glass.*white|vertical-glass/.test(family) ? "glass"
          : /light-stone|stone-like|stone/.test(family + " " + features) ? "stone"
            : /painted-mid-rise|blue.*yellow/.test(materialHints) ? "painted"
              : "plaster";

  const hasArches = /arched|arches|arch openings/.test(features);
  const hasColumns = /column|corinthian|fluted|pilaster/.test(features);
  const hasVines = /planter|creeper|vine|green screen|potted plant|landscaped/.test(features);
  const hasLouvres = /louvre|louver|sunshade|sun-shading|vertical shade/.test(features);
  const hasGrilles = /grille|grilled|grill/.test(features);
  const hasBalconies = /balcon|terrace/.test(features);
  const hasRoofGarden = /rooftop garden|roof garden|green roof|shared rooftop green|roof garden and|rooftop.*green zone/.test(roofEvidence);
  const hasRoofTerrace = /roof.?terrace|roof.?deck|shared rooftop space|landscaped terrace/.test(roofEvidence);
  const isVideoContext = reference?.mediaType === "video";

  return {
    id: "research-preview-" + String(reference?.id ?? "unknown"),
    facadeColor: facade,
    roofColor: roof,
    accentColor: accent,
    pattern,
    roofDetail: hasRoofGarden ? "roof-garden" : hasRoofTerrace ? "roof-terrace" : "none",
    repeatWidthMeters: /high-rise|tower|condominium/.test(family) ? 8.5 : 6.2,
    materialPattern,
    windowFrameColor: colorBy(/frame|trim|ornamental|aged-plaster|off-white/, "#E5DED0"),
    slabColor: colorBy(/concrete|slab|trim|stone/, accent),
    windowBayCount: /mansion|rose-garden|palace/.test(family) ? 3 : /mid-rise|tower|condominium/.test(family) ? 4 : 3,
    decorativeColumns: hasColumns,
    verticalLouvres: hasLouvres,
    greenery: hasVines,
    grilles: hasGrilles,
    groundFloorArches: hasArches && /ground-floor|veranda|entrance arches/.test(features),
    upperFloorPattern: hasArches && /upper-level openings|upper.*window/.test(features) ? "heritage-arches" : "urban-grid",
    balconyProjectionMeters: hasBalconies ? (/wide|deep|stacked|staggered|cantilever/.test(features) ? 1.6 : 0.9) : undefined,
    fullHeightTexture: !isVideoContext,
  };
}

export function resolveArchitectureMediaPreview(reference) {
  if (!reference || typeof reference !== "object" || typeof reference.sourceUrl !== "string") {
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }

  let source;
  try {
    source = new URL(reference.sourceUrl);
  } catch {
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }
  if (source.protocol !== "https:" || source.username || source.password) {
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }

  if (reference.mediaType === "video") {
    if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(source.hostname)) {
      return { mediaPreviewUrl: null, mediaPreviewKind: null };
    }
    const videoId = source.searchParams.get("v");
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return { mediaPreviewUrl: null, mediaPreviewKind: null };
    }
    return {
      mediaPreviewUrl: "https://www.youtube-nocookie.com/embed/" + videoId,
      mediaPreviewKind: "video",
    };
  }

  if (reference.mediaType !== "image") {
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }
  const usageStatus = stringValue(reference.usageStatus).toLowerCase();
  const license = stringValue(reference.license).toLowerCase();
  if (
    source.hostname !== "commons.wikimedia.org" ||
    !source.pathname.startsWith("/wiki/File:") ||
    !usageStatus.includes("open-licence-candidate") ||
    !/^cc by(?:-sa)?\s/i.test(license)
  ) {
    // Only previews from the catalogue's explicit Wikimedia Commons, open-
    // licence candidate set are embedded. Other photos remain source links.
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }

  let filename;
  try {
    filename = decodeURIComponent(source.pathname.slice("/wiki/File:".length));
  } catch {
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }
  if (!filename || filename.length > 240 || filename.includes("/") || filename.includes("\\")) {
    return { mediaPreviewUrl: null, mediaPreviewKind: null };
  }

  return {
    mediaPreviewUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(filename) + "?width=720",
    mediaPreviewKind: "image",
  };
}
