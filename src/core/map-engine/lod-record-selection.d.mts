export function selectNearestLodRecords<T extends { isPart?: boolean }>(
  records: T[],
  limit: number,
  getDistance: (record: T) => number | null | undefined,
): T[];
