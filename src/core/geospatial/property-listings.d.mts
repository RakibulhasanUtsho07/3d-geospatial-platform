export type PropertyType = "apartment" | "house" | "studio" | "office" | "shop";
export type FurnishingType = "unfurnished" | "semi-furnished" | "furnished";

export type PropertyListing = {
  id: string;
  title: string;
  propertyType: PropertyType;
  propertyTypeLabel: string;
  area: string;
  neighborhood: string;
  latitude: number;
  longitude: number;
  monthlyRentBdt: number;
  bedrooms: number;
  bathrooms: number;
  areaSqft: number;
  furnishing: FurnishingType;
  availableFrom: string;
  description: string;
  source: "illustrative-demo-seed";
  verified: false;
  liveAvailability: false;
  distanceMeters: number;
};

export type PropertySearchRequest = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  limit: number;
  minRentBdt: number;
  maxRentBdt: number;
  minBedrooms: number;
  propertyType: string;
  furnishing: string;
  query: string;
  savedOnly: boolean;
  savedIds: string[];
};

export type PropertySearchParseResult =
  | { ok: true; value: PropertySearchRequest }
  | { ok: false; error: string };

export declare const PROPERTY_TYPES: Readonly<Record<PropertyType, string>>;
export declare const PROPERTY_LISTING_LIMITS: Readonly<{
  defaultRadiusMeters: number;
  minRadiusMeters: number;
  maxRadiusMeters: number;
  defaultLimit: number;
  maxLimit: number;
  maxRentBdt: number;
  maxBedrooms: number;
}>;

export declare function parsePropertySearchParams(params: URLSearchParams): PropertySearchParseResult;
export declare function calculateDistanceMeters(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number;
export declare function searchPropertyListings(request: PropertySearchRequest): {
  totalMatches: number;
  returnedCount: number;
  radiusMeters: number;
  results: PropertyListing[];
};
export declare function matchNearbyServices(
  property: Pick<PropertyListing, "latitude" | "longitude">,
  places: Array<{ category: string; latitude: number; longitude: number; [key: string]: unknown }>,
  maxDistanceMeters?: number,
): Array<Record<string, unknown> & { category: string; distanceFromPropertyMeters: number }>;
