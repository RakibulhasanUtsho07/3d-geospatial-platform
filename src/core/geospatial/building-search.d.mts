export type BuildingSearchResult = {
  id: string;
  name: string;
  category: string;
  longitude: number;
  latitude: number;
  role: string;
  heightMeters: number | null;
  floors: number | null;
};

export type BuildingSearchDocument = BuildingSearchResult & {
  searchableText: string;
  normalizedName: string;
};

export type BuildingSearchMatch = {
  totalMatches: number;
  results: BuildingSearchResult[];
};

export declare function createBuildingSearchIndex(
  features: unknown[],
): BuildingSearchDocument[];

export declare function searchBuildingIndex(
  index: BuildingSearchDocument[],
  query: string,
  limit?: number,
): BuildingSearchMatch;

export declare const BUILDING_SEARCH_LIMITS: Readonly<{
  minQueryLength: number;
  maxQueryLength: number;
  defaultLimit: number;
  maxLimit: number;
}>;
