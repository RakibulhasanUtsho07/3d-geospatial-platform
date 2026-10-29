/**
 * TypeScript contract for the browser-safe floor-plan review payload module.
 * The implementation is JavaScript so its validation rules can also be tested
 * directly by Node's built-in test runner.
 */
export type FloorPlanReviewRecord = Record<string, unknown>;

export function canonicalFloorPlanReviewJson(value: unknown): string;

export function validateFloorPlanReviewProposal(
  proposalReport: unknown,
): {
  source: Record<string, unknown>;
  raster: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>;
  candidateIds: Set<string>;
};

export function buildFloorPlanRasterReviewPayload(
  options: Record<string, unknown>,
): Record<string, unknown>;
