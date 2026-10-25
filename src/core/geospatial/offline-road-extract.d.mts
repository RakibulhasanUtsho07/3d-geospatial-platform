import type { RoadFeature, RoadNetworkRequest } from "./road-network.mjs";
export interface OfflineRoadExtract {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    provider: string; url: string; extractDate: string;
    license: "ODbL 1.0"; attribution: "© OpenStreetMap contributors";
    sourceSha256: string | null; normalizationInputSha256?: string | null;
  };
  coverage: { west: number; south: number; east: number; north: number };
  featureCount: number;
  roads: RoadFeature[];
}
export function validateOfflineRoadExtract(value: unknown): OfflineRoadExtract;
export function loadOfflineRoadExtract(filePath: string): Promise<OfflineRoadExtract>;
export function queryOfflineRoadExtract(extract: OfflineRoadExtract | unknown, request: RoadNetworkRequest): {
  covered: boolean; roads: RoadFeature[]; sourceDate: string; sourceUrl: string;
};
export const OFFLINE_ROAD_EXTRACT_LIMITS: Readonly<{ maxBytes: number; maxRoads: number }>;
