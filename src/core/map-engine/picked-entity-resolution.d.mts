type CesiumEntity = import("cesium").Entity;

/**
 * Resolve an entity/primitive/string ID returned by Scene.pick to the entity
 * owned by the current data source.
 */
export function resolvePickedEntity(
  picked: unknown,
  isEntity: (candidate: unknown) => candidate is CesiumEntity,
  getById: (id: string) => CesiumEntity | undefined | null,
): CesiumEntity | null;
