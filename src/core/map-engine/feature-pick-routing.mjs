/**
 * Applies the existing feature-layer priority to lazily resolved Cesium pick candidates.
 * Resolvers only read the current data-source/entity indexes; state changes and events stay in the adapter.
 */
export function resolveFeaturePickRoute(resolvers) {
  const nearbyEntity = resolvers.resolveNearbyPlace();
  if (nearbyEntity?.point) {
    return { kind: "nearby-place", entity: nearbyEntity };
  }

  const propertyEntity = resolvers.resolvePropertyListing();
  if (propertyEntity?.point) {
    return { kind: "property-listing", entity: propertyEntity };
  }

  const road = resolvers.resolveRoad();
  if (road) {
    return { kind: "road", road };
  }

  const buildingEntity = resolvers.resolveBuilding();
  if (buildingEntity?.polygon) {
    return { kind: "building", entity: buildingEntity };
  }

  return { kind: "none" };
}
