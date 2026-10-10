export type StreetImageryRequest = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  limit: number;
};

export type StreetImageryParseResult =
  | { ok: true; value: StreetImageryRequest }
  | { ok: false; error: string };

export type StreetImageryReference = {
  id: string;
  sequenceId: string | null;
  videoId: string | null;
  latitude: number;
  longitude: number;
  headingDegrees: number | null;
  distanceMeters: number;
  captureDate: string | null;
  username: string | null;
  mediaKind: "photo" | "video-frame";
  thumbnailUrl: string;
  imageUrl: string | null;
  sourceUrl: string;
  license: "CC BY-SA 4.0";
  attribution: string;
};

export declare function parseStreetImageryParams(params: URLSearchParams): StreetImageryParseResult;
export declare function haversineDistanceMeters(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number;
export declare function normalizeKartaViewPhotos(payload: unknown, request: StreetImageryRequest): StreetImageryReference[];
export declare function assessReconstructionReadiness(photos: StreetImageryReference[]): {
  level: "estimated" | "reference-only" | "multi-view-candidate";
  title: string;
  detail: string;
  distinctCapturePoints: number;
};
export declare const STREET_IMAGERY_LIMITS: Readonly<{
  defaultRadiusMeters: number;
  minRadiusMeters: number;
  maxRadiusMeters: number;
  defaultLimit: number;
  maxLimit: number;
}>;
