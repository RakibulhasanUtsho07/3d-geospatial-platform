type PointPickEntity = { point?: unknown };
type PolygonPickEntity = { polygon?: unknown };

export type FeaturePickRoute<TNearbyEntity, TPropertyEntity, TRoad, TBuildingEntity> =
  | { kind: "nearby-place"; entity: TNearbyEntity }
  | { kind: "property-listing"; entity: TPropertyEntity }
  | { kind: "road"; road: TRoad }
  | { kind: "building"; entity: TBuildingEntity }
  | { kind: "none" };

/**
 * Lazily resolve pick candidates in UI priority order. The first valid layer wins;
 * no selection state or event callbacks are invoked by this helper.
 */
export function resolveFeaturePickRoute<
  TNearbyEntity extends PointPickEntity,
  TPropertyEntity extends PointPickEntity,
  TRoad,
  TBuildingEntity extends PolygonPickEntity,
>(resolvers: {
  resolveNearbyPlace: () => TNearbyEntity | null;
  resolvePropertyListing: () => TPropertyEntity | null;
  resolveRoad: () => TRoad | null;
  resolveBuilding: () => TBuildingEntity | null;
}): FeaturePickRoute<TNearbyEntity, TPropertyEntity, TRoad, TBuildingEntity>;
