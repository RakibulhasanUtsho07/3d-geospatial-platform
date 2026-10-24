export type BuildingLodPolicyRecord = {
  center: unknown | null;
  wallPositions: readonly unknown[] | null;
  isPart?: boolean;
};

export declare function shouldRecomputeBuildingLod(input: {
  force?: boolean;
  originMoved?: boolean;
  previousBudget?: number | null;
  detailBudget: number;
}): boolean;

export declare function selectDetailedBuildingRecords<
  T extends BuildingLodPolicyRecord,
>(
  records: T[],
  limit: number,
  getDistance: (record: T) => number | null | undefined,
  selectedRecord?: T | null,
): Set<T>;
