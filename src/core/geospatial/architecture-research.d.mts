export type ArchitectureResearchMediaType = "image" | "video";
export type ArchitectureResearchUsage = "all" | "open" | "research-only";

export interface ArchitectureResearchParams {
  query: string;
  area: string;
  style: string;
  mediaType: "all" | ArchitectureResearchMediaType;
  usage: ArchitectureResearchUsage;
  limit: number;
}

export interface ArchitectureResearchReference {
  id: string;
  mediaType: ArchitectureResearchMediaType;
  title: string;
  sourceUrl: string;
  sourceName?: string | null;
  author?: string | null;
  capturedAt?: string | null;
  locationText: string;
  license?: string | null;
  usageStatus: string;
  attributionText?: string | null;
  observedFeatures?: string[];
  limitations?: string[];
  designProfile: {
    styleFamily: string;
    colorPalette: Array<{ name: string; hex: string }>;
    facadeFeatures: string[];
    roofFeatures: string[];
    siteContext: string[];
    locationPrecision: string;
    paletteConfidence: string;
    reconstructionUse: string;
  };
  locationConfidence: string;
  paletteMethod?: string;
  latitude?: number;
  longitude?: number;
  coordinateMeaning?: string;
  coordinateConfidence?: string;
  reportedBuildingMetadata?: Record<string, unknown>;
}

export interface ArchitectureResearchSummary {
  totalReferences: number;
  imageCount: number;
  videoCount: number;
  styles: string[];
  areas: string[];
}

export function parseArchitectureResearchParams(params: URLSearchParams):
  | { ok: true; value: ArchitectureResearchParams }
  | { ok: false; error: string };
export function filterArchitectureReferences(
  references: ArchitectureResearchReference[],
  request: ArchitectureResearchParams,
): ArchitectureResearchReference[];
export function summarizeArchitectureReferences(
  references: ArchitectureResearchReference[],
): ArchitectureResearchSummary;

export type ArchitecturePreviewPattern =
  | "balcony"
  | "vertical-glass"
  | "urban-grid"
  | "compact"
  | "heritage-arches"
  | "painted-balcony"
  | "biophilic-balcony"
  | "brick-modernist";

export interface ArchitectureStylePreview {
  id: string;
  facadeColor: string;
  roofColor: string;
  accentColor: string;
  pattern: ArchitecturePreviewPattern;
  roofDetail: "water-tank" | "hvac-unit" | "none";
  repeatWidthMeters: number;
}

export function createArchitectureStylePreview(
  reference: ArchitectureResearchReference,
): ArchitectureStylePreview;
