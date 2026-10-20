export type BuildingReferenceKind = "image" | "video" | "floor-plan" | "elevation" | "blueprint";
export type BuildingReferenceView = "front" | "left" | "back" | "right" | "oblique" | "top" | "unknown";
export type BuildingReferencePurpose = "actual-building" | "style-reference" | "plan";
export type BuildingReferencePermission = "authorized" | "research-only" | "unknown";

export type BuildingGenerationQuality =
  | "massing"
  | "parametric-facade"
  | "reference-assisted"
  | "multi-view-reconstruction";

export type FootprintSpec = {
  widthMeters?: number;
  depthMeters?: number;
  polygonXYMeters?: Array<[number, number]>;
};

export type BuildingDimensions = {
  totalHeightMeters?: number;
  aboveGroundFloors?: number;
  floorToFloorHeightMeters?: number;
  basementFloors?: number;
};

export type BalconyFeatureSpec = {
  enabled?: boolean;
  /** Storey numbers are 1-based. By default balconies are placed from storey 2 upwards. */
  floors?: number[];
  count?: number;
  widthRatio?: number;
  depthMeters?: number;
  railing?: boolean;
};

export type ColumnFeatureSpec = {
  frontCount: number;
  widthMeters?: number;
  heightMeters?: number;
};

export type BuildingArchitecturalFeatures = {
  windowStyle?: "rectangular" | "arched";
  entranceStyle?: "single-door" | "double-door" | "arched";
  balconies?: BalconyFeatureSpec;
  columns?: ColumnFeatureSpec;
};

export type BuildingGenerationReference = {
  id: string;
  kind: BuildingReferenceKind;
  purpose: BuildingReferencePurpose;
  permission: BuildingReferencePermission;
  view?: BuildingReferenceView;
  assetId: string;
  providerFileToken?: string;
  /** For a reviewed frame extracted from a video, points to the original video reference ID. */
  derivedFromReferenceId?: string;
  /** Source-video time in seconds for an extracted frame. */
  timestampSeconds?: number;
  sourceLabel?: string;
  licence?: string;
};

export type BuildingGenerationRequest = {
  schemaVersion: 1;
  requestId: string;
  building: {
    name?: string;
    buildingType: string;
    architecturalStyle?: string;
    designBrief?: string;
    dimensions: BuildingDimensions;
    footprint?: FootprintSpec;
    frontAzimuthDegrees?: number;
    roofType?: string;
    facadeMaterials?: string[];
    facadeColours?: string[];
    architecturalFeatures?: BuildingArchitecturalFeatures;
  };
  references: BuildingGenerationReference[];
  quality: BuildingGenerationQuality;
  allowExternalProviderProcessing: boolean;
};

export type GenerationStrategy =
  | "parametric-only"
  | "parametric-plus-ai-image"
  | "parametric-plus-ai-text"
  | "parametric-plus-ai-image-multiview"
  | "parametric-plus-ai-multiview"
  | "video-keyframes-then-ai"
  | "photogrammetry-candidate"
  | "needs-more-inputs";

export type GenerationStage =
  | "validate-inputs"
  | "prepare-reference-assets"
  | "extract-video-keyframes"
  | "select-and-label-frames"
  | "generate-parametric-base"
  | "submit-ai-generation"
  | "poll-ai-task"
  | "submit-image-to-multiview"
  | "poll-image-to-multiview"
  | "submit-multiview-to-model"
  | "poll-multiview-to-model"
  | "reconstruct-photogrammetry"
  | "align-to-authoritative-dimensions"
  | "mesh-cleanup-and-optimize"
  | "validate-glb"
  | "admin-review";

export type BuildingGenerationPlan = {
  strategy: GenerationStrategy;
  stages: GenerationStage[];
  canGenerateParametricBase: boolean;
  externalProviderRequired: boolean;
  blocked: boolean;
  warnings: string[];
  missingInputs: string[];
  qualityNotes: string[];
};
