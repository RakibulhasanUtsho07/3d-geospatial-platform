/**
 * Resolves Cesium's heterogeneous pick results to a canonical data-source entity.
 * Selection and feature metadata remain owned by CesiumAdapter.
 */
export function resolvePickedEntity(picked, isEntity, getById) {
  if (!picked || typeof picked !== "object") {
    return null;
  }

  if (isEntity(picked)) {
    return getById(picked.id) ?? null;
  }

  const pickedObject = picked;
  for (const candidate of [pickedObject.id, pickedObject.primitive?.id]) {
    if (isEntity(candidate)) {
      const entity = getById(candidate.id);
      if (entity) return entity;
    }

    if (typeof candidate === "string") {
      const entity = getById(candidate);
      if (entity) return entity;
    }
  }

  return null;
}
