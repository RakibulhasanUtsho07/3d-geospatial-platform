export interface RoadNetworkRequest {
  west: number;
  south: number;
  east: number;
  north: number;
  limit: number;
}

export interface RoadFeature {
  id: string;
  osmWayId: string;
  name: string | null;
  highway: string;
  roadClass: "arterial" | "collector" | "local" | "path";
  surface: string | null;
  lanes: number | null;
  maxSpeed: string | null;
  widthMeters: number;
  widthSource: "tagged" | "lanes-estimate" | "highway-class-estimate";
  layer: number | null;
  bridge: boolean;
  tunnel: boolean;
  oneway: boolean;
  coordinates: number[][];
  source: string;
  license: string;
  attribution: string;
}

export function parseRoadNetworkParams(params: URLSearchParams):
  | { ok: true; value: RoadNetworkRequest }
  | { ok: false; error: string };
export function buildOverpassRoadQuery(request: RoadNetworkRequest): string;
export function normalizeOverpassRoadElements(elements: unknown[], request: RoadNetworkRequest): RoadFeature[];
export const ROAD_NETWORK_LIMITS: Readonly<{
  minSpanDegrees: number;
  maxSpanDegrees: number;
  defaultLimit: number;
  maxLimit: number;
}>;
