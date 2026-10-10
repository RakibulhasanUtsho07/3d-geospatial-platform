export type ViewportFeatureBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export declare function selectViewportFeatures<T>(
  features: T[],
  viewport: ViewportFeatureBounds,
  limit: number,
  getFeatureBounds: (feature: T) => ViewportFeatureBounds | null,
  getFeatureRole: (feature: T) => string,
): T[];
