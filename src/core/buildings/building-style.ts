export type FacadePattern = "balcony" | "vertical-glass" | "urban-grid" | "compact" | "heritage-arches" | "painted-balcony" | "biophilic-balcony" | "brick-modernist";

export type RoofDetail = "water-tank" | "hvac-unit" | "none";

export type BuildingVisualStyle = {
  id: string;
  facadeColor: string;
  roofColor: string;
  accentColor: string;
  pattern: FacadePattern;
  roofDetail: RoofDetail;
  repeatWidthMeters: number;
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
      pattern: "brick-modernist",
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
    roofDetail: chooseRoofDetail(properties, heightMeters, seed >>> 5),
    repeatWidthMeters: heightMeters >= 60 ? 8.5 : heightMeters >= 24 ? 7.2 : 6.2,
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
export function createBuildingFacadeTexture(
  style: BuildingVisualStyle,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cacheKey = [
    style.id,
    style.facadeColor,
    style.accentColor,
    style.pattern,
  ].join(":");
  const cached = textureCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 192;
  // One texture tile represents approximately one 3 m floor.
  canvas.height = 96;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.fillStyle = style.facadeColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Per-floor slab bands and fine architectural reveals.
  context.fillStyle = style.accentColor;
  context.fillRect(0, 0, canvas.width, 5);
  context.fillRect(0, 90, canvas.width, 6);

  context.fillStyle = "rgba(255, 255, 255, 0.38)";
  context.fillRect(0, 6, canvas.width, 2);

  const frameColor = "#e4e8e8";

  if (style.pattern === "heritage-arches") {
    for (const x of [18, 76, 134]) {
      drawArchedWindow(context, x, 11, 40, 75, "#e3d6c1");
    }
    context.fillStyle = style.accentColor;
    context.fillRect(0, 9, canvas.width, 3);
    context.fillRect(0, 88, canvas.width, 4);
  } else if (style.pattern === "painted-balcony") {
    for (const x of [13, 106]) {
      drawWindow(context, x, 10, 69, 49, frameColor);
      drawBalcony(context, x - 2, 62, 73, style.accentColor);
    }
    context.fillStyle = style.accentColor;
    context.fillRect(0, 5, canvas.width, 4);
  } else if (style.pattern === "biophilic-balcony") {
    for (const x of [13, 106]) {
      drawWindow(context, x, 10, 69, 49, frameColor);
      drawBalcony(context, x - 2, 62, 73, "#b5b0a5");
    }
    context.fillStyle = style.accentColor;
    for (const x of [30, 55, 125, 155]) {
      context.fillRect(x, 62, 5, 5);
      context.fillRect(x + 1, 67, 2, 18);
    }
  } else if (style.pattern === "brick-modernist") {
    for (const x of [22, 90, 146]) {
      drawWindow(context, x, 16, 30, 68, "#d4c8b8");
    }
    context.fillStyle = style.accentColor;
    context.fillRect(0, 15, canvas.width, 4);
    context.fillRect(0, 84, canvas.width, 5);
  } else if (style.pattern === "vertical-glass") {
    for (const x of [12, 72, 132]) {
      drawWindow(context, x, 11, 48, 75, frameColor);
    }

    context.fillStyle = style.accentColor;
    for (const x of [7, 66, 126, 185]) {
      context.fillRect(x, 8, 4, 81);
    }
  } else if (style.pattern === "balcony") {
    for (const x of [13, 106]) {
      drawWindow(context, x, 10, 69, 49, frameColor);
      drawBalcony(context, x - 2, 62, 73, style.accentColor);
    }
  } else if (style.pattern === "urban-grid") {
    for (const x of [12, 72, 132]) {
      drawWindow(context, x, 15, 46, 66, frameColor);
    }
  } else {
    for (const x of [15, 74, 133]) {
      drawWindow(context, x, 23, 43, 57, frameColor);
    }
  }

  // Slim vertical joints keep the surface from looking like one flat slab.
  context.fillStyle = "rgba(65, 78, 82, 0.14)";
  context.fillRect(0, 7, 2, 82);
  context.fillRect(canvas.width - 2, 7, 2, 82);

  if (textureCache.size >= 48) {
    const oldestKey = textureCache.keys().next().value;

    if (oldestKey) {
      textureCache.delete(oldestKey);
    }
  }

  textureCache.set(cacheKey, canvas);
  return canvas;
}
