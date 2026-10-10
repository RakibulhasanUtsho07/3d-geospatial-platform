export type FacadePattern = "balcony" | "vertical-glass" | "urban-grid" | "compact";

export type BuildingVisualStyle = {
  id: string;
  facadeColor: string;
  roofColor: string;
  accentColor: string;
  pattern: FacadePattern;
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

function validColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function choosePattern(
  properties: BuildingProperties,
  heightMeters: number,
  seed: number,
): FacadePattern {
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
  const palette = palettes[seed % palettes.length];

  const explicitFacade = properties.facade_color;
  const explicitRoof = properties.roof_color;
  const facadeColor = validColor(explicitFacade)
    ? explicitFacade
    : palette.facade;
  const roofColor = validColor(explicitRoof)
    ? explicitRoof
    : palette.roof;

  return {
    id: palette.id,
    facadeColor,
    roofColor,
    accentColor: palette.accent,
    pattern: choosePattern(properties, heightMeters, seed >>> 3),
    repeatWidthMeters: heightMeters >= 60 ? 8.5 : heightMeters >= 24 ? 7.2 : 6.2,
  };
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
  canvas.height = 128;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.fillStyle = style.facadeColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Per-floor slab bands and fine architectural reveals.
  context.fillStyle = style.accentColor;
  context.fillRect(0, 0, canvas.width, 7);
  context.fillRect(0, 121, canvas.width, 7);
  context.fillRect(0, 62, canvas.width, 3);

  context.fillStyle = "rgba(255, 255, 255, 0.38)";
  context.fillRect(0, 8, canvas.width, 2);
  context.fillRect(0, 65, canvas.width, 1.5);

  const frameColor = "#e4e8e8";

  if (style.pattern === "vertical-glass") {
    for (const x of [12, 72, 132]) {
      drawWindow(context, x, 14, 48, 99, frameColor);
    }

    context.fillStyle = style.accentColor;
    for (const x of [7, 66, 126, 185]) {
      context.fillRect(x, 8, 4, 112);
    }
  } else if (style.pattern === "balcony") {
    for (const x of [13, 106]) {
      drawWindow(context, x, 13, 69, 77, frameColor);
      drawBalcony(context, x - 2, 91, 73, style.accentColor);
    }
  } else if (style.pattern === "urban-grid") {
    for (const x of [12, 72, 132]) {
      drawWindow(context, x, 15, 46, 42, frameColor);
      drawWindow(context, x, 72, 46, 39, frameColor);
    }
  } else {
    for (const x of [15, 74, 133]) {
      drawWindow(context, x, 18, 43, 38, frameColor);
      drawWindow(context, x, 72, 43, 37, frameColor);
    }
  }

  // Slim vertical joints keep the surface from looking like one flat slab.
  context.fillStyle = "rgba(65, 78, 82, 0.14)";
  context.fillRect(0, 7, 2, 114);
  context.fillRect(canvas.width - 2, 7, 2, 114);

  if (textureCache.size >= 48) {
    const oldestKey = textureCache.keys().next().value;

    if (oldestKey) {
      textureCache.delete(oldestKey);
    }
  }

  textureCache.set(cacheKey, canvas);
  return canvas;
}
