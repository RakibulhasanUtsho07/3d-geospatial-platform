export type NearbyPlaceCategory =
  | "pharmacy"
  | "hospital"
  | "medical_center"
  | "supermarket"
  | "market";

export type NearbyPlacesRequest = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  categories: NearbyPlaceCategory[];
  limit: number;
};

export type NearbyPlace = {
  id: string;
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string;
  category: NearbyPlaceCategory;
  categoryLabel: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  address: string | null;
  openingHours: string | null;
  phone: string | null;
  website: string | null;
  operator: string | null;
  tags: Record<string, string>;
  osmUrl: string;
};

export type NearbyPlacesParseResult =
  | { ok: true; value: NearbyPlacesRequest }
  | { ok: false; error: string };

export declare const NEARBY_PLACE_CATEGORIES: Readonly<
  Record<NearbyPlaceCategory, { label: string; color: string }>
>;

export declare const NEARBY_PLACE_LIMITS: Readonly<{
  defaultRadiusMeters: number;
  minRadiusMeters: number;
  maxRadiusMeters: number;
  defaultResultLimit: number;
  maxResultLimit: number;
}>;

export declare function parseNearbyPlacesParams(
  params: URLSearchParams,
): NearbyPlacesParseResult;

export declare function buildOverpassQuery(
  request: NearbyPlacesRequest,
): string;

export declare function normalizeOverpassElements(
  elements: unknown[],
  request: NearbyPlacesRequest,
): NearbyPlace[];
