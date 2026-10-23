import { selectNearestLodRecords } from "./lod-record-selection.mjs";

/**
 * Keep the adapter's LOD update scheduling independent from Cesium graphics.
 * A zero facade budget is valid: distant buildings stay lightweight.
 */
export function shouldRecomputeBuildingLod({
  force = false,
  originMoved = false,
  previousBudget = null,
  detailBudget,
}) {
  if (!Number.isSafeInteger(detailBudget) || detailBudget < 0) {
    throw new RangeError("Building LOD budget must be a non-negative safe integer.");
  }

  return force || originMoved || previousBudget !== detailBudget;
}

/**
 * Select the bounded nearest-detail set and keep a selected, renderable
 * building detailed even when it falls outside the current camera budget.
 */
export function selectDetailedBuildingRecords(
  records,
  limit,
  getDistance,
  selectedRecord = null,
) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Building LOD selection limit must be a non-negative safe integer.");
  }
  if (!Array.isArray(records)) {
    throw new TypeError("Building LOD records must be an array.");
  }
  if (typeof getDistance !== "function") {
    throw new TypeError("Building LOD distance accessor must be a function.");
  }

  // The existing nearest-record selector intentionally requires a positive
  // limit. At high altitude a zero budget is expected, not an exceptional case.
  const selectedRecords = limit === 0
    ? []
    : selectNearestLodRecords(records, limit, getDistance);
  const desiredDetailed = new Set(selectedRecords);

  if (selectedRecord?.center && selectedRecord.wallPositions) {
    desiredDetailed.add(selectedRecord);
  }

  return desiredDetailed;
}
