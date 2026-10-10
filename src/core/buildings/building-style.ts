export type FacadePattern = "balcony" | "vertical-glass" | "urban-grid" | "compact" | "heritage-arches" | "painted-balcony" | "biophilic-balcony" | "brick-modernist";

export type RoofDetail =
  | "water-tank"
  | "hvac-unit"
  | "roof-garden"
  | "roof-terrace"
  | "none";

export type FacadeMaterialPattern = "brick" | "plaster" | "glass" | "stone" | "weathered" | "painted";

export type BuildingVisualStyle = {
  id: string;
  facadeColor: string;
  roofColor: string;
  accentColor: string;
  pattern: FacadePattern;
  roofDetail: RoofDetail;
  repeatWidthMeters: number;
  /** Extra details are evidence-led; absent flags leave the procedural default unchanged. */
  materialPattern?: FacadeMaterialPattern;
  windowFrameColor?: string;
  slabColor?: string;
  windowBayCount?: number;
  decorativeColumns?: boolean;
  verticalLouvres?: boolean;
  greenery?: boolean;
  grilles?: boolean;
  groundFloorArches?: boolean;
  upperFloorPattern?: FacadePattern;
  balconyProjectionMeters?: number;
  fullHeightTexture?: boolean;
};

type BuildingProperties = Record<string, unknown>;

type StylePalette = {
  id: string;
  facade: string;
  roof: string;
  accent: string;
};

const LOW_RISE_PALETTES: StylePalette[] = [
  { id: "sandstone", facade: "#e6d8c7", roof: "#9e9b91", accent: "#c6b49f" },
  { id: "warm-stucco", facade: "#e7d2bd", roof: "#a69a8e", accent: "#c98f69" },
  { id: "sage-concrete", facade: "#d2ddd4", roof: "#909f98", accent: "#9dafaa" },
  { id: "pale-concrete", facade: "#d9dfe0", roof: "#9ca6aa", accent: "#b5c0c4" },
  { id: "ivory", facade: "#eee5d6", roof: "#aaa69c", accent: "#d0c4b2" },
];

const MID_RISE_PALETTES: StylePalette[] = [
  { id: "urban-silver", facade: "#d4dcdf", roof: "#87979e", accent: "#9eafb6" },
  { id: "warm-modern", facade: "#d9cbb9", roof: "#978a7e", accent: "#b78967" },
  { id: "blue-grey", facade: "#c7d6de", roof: "#7b929e", accent: "#8ca8b7" },
  { id: "mineral", facade: "#d8d5cb", roof: "#928f86", accent: "#b4b0a4" },
  { id: "sage-modern", facade: "#cbd7d0", roof: "#83968c", accent: "#9eafa5" },
];

const HIGH_RISE_PALETTES: StylePalette[] = [
  { id: "glass-blue", facade: "#c4d9e2", roof: "#788f9a", accent: "#779cab" },
  { id: "pearl-glass", facade: "#dce4e5", roof: "#89979c", accent: "#aabdc4" },
  { id: "graphite-glass", facade: "#c6d0d5", roof: "#6e7e86", accent: "#718995" },
  { id: "cool-steel", facade: "#d0dbe1", roof: "#7c909b", accent: "#8fa8b5" },
];

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const NAMED_SOURCE_COLORS: Record<string, string> = {
  white: "#FFFFFF",
  ivory: "#EEE5D6",
  cream: "#E7D2BD",
  beige: "#D9CBB9",
  grey: "#A9AFB2",
  gray: "#A9AFB2",
  "light gray": "#D9DFE0",
  "light grey": "#D9DFE0",
  "dark gray": "#454D52",
  "dark grey": "#454D52",
  black: "#24292D",
  red: "#B94B3A",
  brown: "#8B5E45",
  brick: "#9A4D34",
  blue: "#2F6C96",
  yellow: "#D8B044",
  green: "#47744D",
  tan: "#C7B59C",
};

type ResearchPalette = StylePalette & { pattern: FacadePattern };

function normalizedStyleHint(properties: BuildingProperties): string {
  return readText(properties, [
    "architecture_style",
    "style_family",
    "facade_style",
    "design_family",
    "render_style_family",
  ]).replace(/[_:]+/g, "-");
}

function resolveResearchPalette(
  properties: BuildingProperties,
): ResearchPalette | null {
  const family = normalizedStyleHint(properties);
  const material = readText(properties, [
    "facade_material",
    "facade:material",
    "building:material",
    "material",
  ]);

  if (/old-dhaka|heritage|historic|courtyard|mansion/.test(family)) {
    return {
      id: "research-heritage-courtyard",
      facade: "#c5b18c",
      roof: "#696357",
      accent: "#9b543c",
      pattern: "heritage-arches",
    };
  }

  if (/biophilic|climate-responsive|green-facade|vine/.test(family)) {
    return {
      id: "research-brick-biophilic",
      facade: "#a35338",
      roof: "#b5b0a5",
      accent: "#3b7544",
      pattern: "biophilic-balcony",
    };
  }

  if (/painted.*blue.*ochre|blue.*ochre|mugda-painted/.test(family)) {
    return {
      id: "research-painted-blue-ochre",
      facade: "#2f6c96",
      roof: "#bcb7a9",
      accent: "#d8b044",
      pattern: "painted-balcony",
    };
  }

  if (/modernist|brick-house|fair-faced-brick/.test(family)) {
    return {
      id: "research-brick-modernist",
      facade: "#9a4d34",
      roof: "#b5b0a5",
      accent: "#c7c1b4",
      pattern: "brick-modernist",
    };
  }

  if (/contemporary-white-glass|white-glass-apartment/.test(family)) {
    return {
      id: "research-contemporary-white-glass",
      facade: "#f1f0ea",
      roof: "#c9c9c1",
      accent: "#91a8b5",
      pattern: "vertical-glass",
    };
  }

  // A sourced brick-material attribute can influence the procedural facade,
  // but it does not imply a named building or a heritage/biophilic style.
  if (/brick|terracotta/.test(material)) {
    return {
      id: "source-material-brick",
      facade: "#a35338",
      roof: "#a7a69e",
      accent: "#c7b5a0",
      pattern: "urban-grid",
    };
  }

  return null;
}

function normalizeSourceColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, " ");
  if (HEX_COLOR.test(normalized)) {
    if (normalized.length === 4) {
      return "#" + normalized.slice(1).split("").map((digit) => digit + digit).join("");
    }
    return normalized;
  }
  return NAMED_SOURCE_COLORS[normalized] ?? null;
}

function firstSourceColor(
  properties: BuildingProperties,
  keys: string[],
): string | null {
  for (const key of keys) {
    const color = normalizeSourceColor(properties[key]);
    if (color) return color;
  }
  return null;
}
const textureCache = new Map<string, HTMLCanvasElement>();

function stableHash(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function readText(properties: BuildingProperties, keys: string[]): string {
  for (const key of keys) {
    const value = properties[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase();
    }

    if (typeof value === "object" && value !== null) {
      const primary = (value as Record<string, unknown>).primary;

      if (typeof primary === "string" && primary.trim()) {
        return primary.trim().toLowerCase();
      }
    }
  }

  return "";
}

function choosePattern(
  properties: BuildingProperties,
  heightMeters: number,
  seed: number,
  researchPattern?: FacadePattern,
): FacadePattern {
  if (researchPattern) return researchPattern;
  const use = readText(properties, [
    "subtype",
    "class",
    "use",
    "building",
    "building_use",
    "function",
  ]);

  if (/industrial|warehouse|factory|hangar/.test(use)) {
    return "compact";
  }

  if (/office|commercial|retail|hotel|mixed/.test(use) || heightMeters >= 65) {
    return "vertical-glass";
  }

  if (/residential|apartments|apartment|house|dormitory/.test(use)) {
    return heightMeters >= 18 ? "balcony" : "compact";
  }

  const patterns: FacadePattern[] = [
    "balcony",
    "vertical-glass",
    "urban-grid",
    "compact",
  ];

  return patterns[seed % patterns.length];
}

function chooseRoofDetail(
  properties: BuildingProperties,
  heightMeters: number,
  seed: number,
): RoofDetail {
  const use = readText(properties, [
    "subtype",
    "class",
    "use",
    "building",
    "building_use",
    "function",
  ]);

  // Rooftop equipment is a visual hint, not a claim about actual fixtures.
  if (/industrial|warehouse|factory|hangar/.test(use)) {
    return seed % 3 === 0 ? "hvac-unit" : "none";
  }

  if (heightMeters >= 60) {
    return seed % 3 === 0 ? "none" : "hvac-unit";
  }

  if (
    /residential|apartments|apartment|house|dormitory/.test(use) ||
    heightMeters < 24
  ) {
    return seed % 4 === 0 ? "water-tank" : "none";
  }

  return seed % 5 === 0 ? "hvac-unit" : "none";
}

/**
 * Pick a stable facade palette and facade pattern from available metadata.
 * The same feature id always gets the same visual style on every reload.
 */
export function resolveBuildingVisualStyle(
  properties: BuildingProperties,
  featureId: string,
  heightMeters: number,
): BuildingVisualStyle {
  const seed = stableHash(featureId || "overture-building");
  const palettes =
    heightMeters >= 60
      ? HIGH_RISE_PALETTES
      : heightMeters >= 24
        ? MID_RISE_PALETTES
        : LOW_RISE_PALETTES;
  const researchPalette = resolveResearchPalette(properties);
  const palette = researchPalette ?? palettes[seed % palettes.length];

  const explicitFacade = firstSourceColor(properties, [
    "facade_color",
    "facade:colour",
    "facade_colour",
    "building:colour",
    "building:color",
    "building_color",
    "building_colour",
  ]);
  const explicitRoof = firstSourceColor(properties, [
    "roof_color",
    "roof:colour",
    "roof_colour",
    "building:roof:colour",
  ]);
  const explicitAccent = firstSourceColor(properties, [
    "facade_accent_color",
    "facade_accent_colour",
    "facade_accent:colour",
  ]);
  const facadeColor = explicitFacade ?? palette.facade;
  const roofColor = explicitRoof ?? palette.roof;

  const facadeMaterial = readText(properties, [
    "facade_material",
    "facade:material",
    "building:material",
    "material",
  ]);
  const facadeColourTag = readText(properties, ["facade:colour", "building:colour", "facade_color"]);
  const isBrick = /brick|masonry|terracotta/.test(facadeMaterial);
  const materialPattern: FacadeMaterialPattern | undefined =
    isBrick ? "brick"
      : /glass|glazing/.test(facadeMaterial) ? "glass"
        : /stone|granite|marble/.test(facadeMaterial) ? "stone"
          : /plaster|stucco|render|concrete/.test(facadeMaterial) ? "plaster"
            : /paint/.test(facadeColourTag) ? "painted"
              : undefined;

  const sourceFeatures = readText(properties, [
    "facade_features",
    "architecture_features",
    "feature_description",
  ]);
  const sourceRoof = readText(properties, [
    "roof_features",
    "roof:shape",
    "roof_material",
    "roof:material",
  ]);

  return {
    id: palette.id,
    facadeColor,
    roofColor,
    accentColor: explicitAccent ?? palette.accent,
    pattern: choosePattern(
      properties,
      heightMeters,
      seed >>> 3,
      researchPalette?.pattern,
    ),
    roofDetail: /roof.?garden|rooftop.?garden|green.?roof/.test(sourceRoof)
      ? "roof-garden"
      : /roof.?terrace|roof.?deck|terrace/.test(sourceRoof)
        ? "roof-terrace"
        : chooseRoofDetail(properties, heightMeters, seed >>> 5),
    repeatWidthMeters: heightMeters >= 60 ? 8.5 : heightMeters >= 24 ? 7.2 : 6.2,
    materialPattern,
    windowFrameColor: /white|ivory|cream/.test(facadeColourTag) ? "#EDE8DE" : undefined,
    slabColor: explicitAccent ?? palette.accent,
    windowBayCount: /heritage|historic|courtyard|mansion/.test(normalizedStyleHint(properties)) ? 3 : heightMeters >= 45 ? 4 : 3,
    decorativeColumns: /column|pilaster|corinthian|fluted/.test(sourceFeatures),
    verticalLouvres: /louvre|louver|sun.?shade|vertical.?shade/.test(sourceFeatures),
    greenery: /planter|creeper|vine|green.?screen|biophilic|landscaped/.test(sourceFeatures),
    grilles: /grille|grill|security.?bar/.test(sourceFeatures),
  };
}

function drawArchedWindow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  frameColor: string,
): void {
  const springLine = y + width * 0.34;
  context.fillStyle = frameColor;
  context.beginPath();
  context.moveTo(x, y + height);
  context.lineTo(x, springLine);
  context.quadraticCurveTo(x + width / 2, y - width * 0.24, x + width, springLine);
  context.lineTo(x + width, y + height);
  context.closePath();
  context.fill();

  const inset = Math.max(3, Math.round(width * 0.09));
  const innerX = x + inset;
  const innerWidth = width - inset * 2;
  const innerSpring = springLine + inset;
  context.fillStyle = "#203b4a";
  context.beginPath();
  context.moveTo(innerX, y + height - inset);
  context.lineTo(innerX, innerSpring);
  context.quadraticCurveTo(innerX + innerWidth / 2, y + inset, innerX + innerWidth, innerSpring);
  context.lineTo(innerX + innerWidth, y + height - inset);
  context.closePath();
  context.fill();

  context.fillStyle = "rgba(198, 226, 239, 0.5)";
  context.fillRect(innerX + 2, innerSpring + 3, Math.max(2, innerWidth * 0.1), Math.max(3, height * 0.24));
  context.fillStyle = frameColor;
  context.fillRect(x + width * 0.5 - 1, innerSpring, 2, height - (innerSpring - y));
  context.fillRect(innerX, y + height * 0.68, innerWidth, 2);
}

function drawWindow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  frameColor: string,
): void {
  context.fillStyle = frameColor;
  context.fillRect(x, y, width, height);

  const inset = Math.max(3, Math.round(Math.min(width, height) * 0.09));
  const glass = context.createLinearGradient(x, y, x + width, y + height);
  glass.addColorStop(0, "#315b70");
  glass.addColorStop(0.42, "#17384d");
  glass.addColorStop(1, "#0e2535");

  context.fillStyle = glass;
  context.fillRect(
    x + inset,
    y + inset,
    width - inset * 2,
    height - inset * 2,
  );

  context.fillStyle = "rgba(198, 226, 239, 0.55)";
  context.fillRect(x + inset + 2, y + inset + 2, Math.max(2, width * 0.07), height * 0.46);

  context.fillStyle = "rgba(140, 173, 189, 0.7)";
  context.fillRect(x + width * 0.5 - 1, y + inset, 2, height - inset * 2);
  context.fillRect(x + inset, y + height * 0.62, width - inset * 2, 2);
}

function drawBalcony(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  accent: string,
): void {
  context.fillStyle = accent;
  context.fillRect(x - 4, y, width + 8, 5);
  context.fillStyle = "#e1e6e7";
  context.fillRect(x - 2, y + 5, width + 4, 2);
  context.fillStyle = "#819ba8";

  for (let offset = 2; offset < width; offset += 8) {
    context.fillRect(x + offset, y + 5, 1.5, 9);
  }

  context.fillRect(x - 2, y + 13, width + 4, 2);
}

/**
 * Generate a cached, repeatable facade tile. It is deliberately procedural:
 * no network images or external texture assets are required.
 */
function drawFacadeTile(style: BuildingVisualStyle): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const facade = style.facadeColor;
  const slab = style.slabColor ?? style.accentColor;
  const frame = style.windowFrameColor ?? "#e4e8e8";
  const bays = Math.max(2, Math.min(5, Math.round(style.windowBayCount ?? 3)));

  context.fillStyle = facade;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Materials are procedural and generated locally: no unlicensed external
  // image textures are copied into the project.
  if (style.materialPattern === "brick") {
    context.fillStyle = "rgba(54, 37, 28, 0.28)";
    for (let y = 7; y < canvas.height; y += 12) {
      context.fillRect(0, y, canvas.width, 1.5);
      const offset = Math.floor(y / 12) % 2 === 0 ? 0 : 14;
      for (let x = offset; x < canvas.width; x += 28) context.fillRect(x, y - 11, 1, 11);
    }
    context.fillStyle = "rgba(255, 220, 195, 0.14)";
    for (let y = 10; y < canvas.height; y += 24) context.fillRect(0, y, canvas.width, 1);
  } else if (style.materialPattern === "weathered") {
    context.fillStyle = "rgba(103, 82, 51, 0.12)";
    for (const [x, y, w, h] of [[12, 12, 20, 4], [118, 26, 25, 6], [42, 72, 35, 5], [150, 81, 18, 3]]) {
      context.fillRect(x, y, w, h);
    }
    context.fillStyle = "rgba(245, 227, 190, 0.14)";
    context.fillRect(0, 22, canvas.width, 2);
    context.fillRect(0, 66, canvas.width, 2);
  } else if (style.materialPattern === "stone") {
    context.strokeStyle = "rgba(75, 82, 83, 0.22)";
    context.lineWidth = 1;
    for (let y = 12; y < canvas.height; y += 24) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
      context.stroke();
    }
    for (let y = 0; y < canvas.height; y += 24) {
      const offset = Math.floor(y / 24) % 2 ? 24 : 0;
      for (let x = offset; x < canvas.width; x += 48) context.fillRect(x, y, 1, 24);
    }
  } else if (style.materialPattern === "glass") {
    context.fillStyle = "rgba(219, 241, 249, 0.18)";
    context.fillRect(0, 0, 10, canvas.height);
    for (let x = 38; x < canvas.width; x += 58) context.fillRect(x, 7, 2, 82);
  }

  context.fillStyle = slab;
  context.fillRect(0, 0, canvas.width, 5);
  context.fillRect(0, 90, canvas.width, 6);
  context.fillStyle = "rgba(255, 255, 255, 0.32)";
  context.fillRect(0, 6, canvas.width, 2);

  const bayWidth = (canvas.width - 20) / bays;
  const windowWidth = Math.max(19, Math.min(45, bayWidth * 0.72));
  const windowHeight = style.pattern === "vertical-glass" ? 75 : 51;
  const windowX = (index: number) => 10 + index * bayWidth + (bayWidth - windowWidth) / 2;
  const drawWindowBays = (withBalcony: boolean) => {
    for (let index = 0; index < bays; index += 1) {
      const x = windowX(index);
      drawWindow(context, x, style.pattern === "vertical-glass" ? 10 : 12, windowWidth, windowHeight, frame);
      if (withBalcony) {
        drawBalcony(context, x - 2, 63, windowWidth + 4, slab);
      }
    }
  };

  if (style.pattern === "heritage-arches") {
    for (let index = 0; index < bays; index += 1) {
      const x = windowX(index);
      drawArchedWindow(context, x, 11, windowWidth, 75, frame);
    }
    context.fillStyle = style.accentColor;
    context.fillRect(0, 9, canvas.width, 3);
    context.fillRect(0, 88, canvas.width, 4);
  } else if (style.pattern === "painted-balcony") {
    // Symmetrical colour zoning echoes the Mugda reference; it remains a
    // visual profile, not a claim that the selected building is that house.
    context.fillStyle = style.accentColor;
    context.fillRect(0, 7, 9, 81);
    context.fillRect(canvas.width - 9, 7, 9, 81);
    context.fillRect(canvas.width * 0.48, 7, 8, 81);
    drawWindowBays(true);
  } else if (style.pattern === "biophilic-balcony") {
    drawWindowBays(true);
  } else if (style.pattern === "brick-modernist") {
    for (let index = 0; index < bays; index += 1) {
      const x = windowX(index);
      drawWindow(context, x, 14, windowWidth * 0.78, 68, frame);
    }
    context.fillStyle = slab;
    context.fillRect(0, 14, canvas.width, 4);
    context.fillRect(0, 84, canvas.width, 5);
  } else if (style.pattern === "vertical-glass") {
    for (let index = 0; index < bays; index += 1) {
      drawWindow(context, windowX(index), 10, windowWidth, 75, frame);
    }
    context.fillStyle = style.accentColor;
    for (let x = 6; x < canvas.width; x += 48) context.fillRect(x, 8, 4, 81);
  } else if (style.pattern === "balcony") {
    drawWindowBays(true);
  } else if (style.pattern === "urban-grid") {
    for (let index = 0; index < bays; index += 1) {
      drawWindow(context, windowX(index), 15, windowWidth, 66, frame);
    }
  } else {
    drawWindowBays(false);
  }

  if (style.decorativeColumns) {
    context.fillStyle = frame;
    for (const x of [7, canvas.width - 11]) {
      context.fillRect(x, 10, 4, 76);
      context.fillRect(x - 2, 10, 8, 4);
      context.fillRect(x - 2, 83, 8, 4);
    }
  }

  if (style.verticalLouvres) {
    context.fillStyle = slab;
    for (const x of [2, 6, 10, canvas.width - 14, canvas.width - 10, canvas.width - 6]) {
      context.fillRect(x, 11, 2, 74);
    }
  }

  if (style.grilles) {
    context.strokeStyle = "#41464B";
    context.lineWidth = 1.3;
    for (let x = 16; x < canvas.width; x += 12) {
      context.beginPath();
      context.moveTo(x, 14);
      context.lineTo(x, 82);
      context.stroke();
    }
  }

  if (style.greenery || style.pattern === "biophilic-balcony") {
    context.fillStyle = "#456F43";
    context.fillRect(0, 61, canvas.width, 4);
    for (const x of [23, 47, 77, 118, 148, 171]) {
      context.beginPath();
      context.moveTo(x, 62);
      context.bezierCurveTo(x - 2, 68, x + 5, 74, x + 2, 84);
      context.lineWidth = 2.5;
      context.strokeStyle = "#3F7546";
      context.stroke();
      context.fillStyle = "#5D8D50";
      context.beginPath();
      context.ellipse(x - 3, 71, 3, 1.5, -0.5, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.ellipse(x + 3, 78, 3, 1.5, 0.5, 0, Math.PI * 2);
      context.fill();
    }
  }

  // Subtle joints preserve perceived scale without turning a wall into a flat slab.
  context.fillStyle = "rgba(45, 56, 61, 0.13)";
  context.fillRect(0, 7, 2, 82);
  context.fillRect(canvas.width - 2, 7, 2, 82);
  return canvas;
}

/**
 * Generate cached facade materials from the building's source attributes or
 * from a selected reference's architectural feature profile.
 *
 * A full-height texture is used only for the single selected preview so
 * ground-floor arch treatment and upper-floor fenestration can differ. Normal
 * background buildings retain the low-memory repeating-floor texture.
 */
export function createBuildingFacadeTexture(
  style: BuildingVisualStyle,
  buildingHeightMeters = 3,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const fullHeight = style.fullHeightTexture === true && buildingHeightMeters <= 90;
  const floorCount = fullHeight
    ? Math.max(1, Math.min(30, Math.round(buildingHeightMeters / 3)))
    : 1;
  const cacheKey = [
    style.id,
    style.facadeColor,
    style.roofColor,
    style.accentColor,
    style.pattern,
    style.materialPattern ?? "",
    style.windowFrameColor ?? "",
    style.slabColor ?? "",
    style.windowBayCount ?? "",
    style.decorativeColumns ?? "",
    style.verticalLouvres ?? "",
    style.greenery ?? "",
    style.grilles ?? "",
    style.groundFloorArches ?? "",
    style.upperFloorPattern ?? "",
    style.balconyProjectionMeters ?? "",
    fullHeight ? floorCount : "repeat",
  ].join(":");

  const cached = textureCache.get(cacheKey);
  if (cached) return cached;

  const tile = drawFacadeTile(style);
  if (!tile) return null;

  let texture = tile;
  if (fullHeight && floorCount > 1) {
    texture = document.createElement("canvas");
    texture.width = tile.width;
    texture.height = tile.height * floorCount;
    const context = texture.getContext("2d");
    if (!context) return null;

    for (let floor = 0; floor < floorCount; floor += 1) {
      let floorStyle = style;
      if (style.groundFloorArches && floor === 0) {
        floorStyle = { ...style, pattern: "heritage-arches", groundFloorArches: false };
      } else if (floor > 0 && style.upperFloorPattern) {
        floorStyle = { ...style, pattern: style.upperFloorPattern, groundFloorArches: false };
      }
      const floorTexture = floorStyle === style ? tile : drawFacadeTile(floorStyle);
      if (!floorTexture) continue;
      // The canvas is ordered bottom-to-top by floor; the wall shader may flip
      // the texture coordinate, so the ground/upper-floor split is approximate.
      context.drawImage(floorTexture, 0, texture.height - (floor + 1) * tile.height);
    }
  }

  if (textureCache.size >= 48) {
    const oldestKey = textureCache.keys().next().value;
    if (oldestKey) textureCache.delete(oldestKey);
  }
  textureCache.set(cacheKey, texture);
  return texture;
}
