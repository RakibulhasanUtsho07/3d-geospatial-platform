function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("LOD selection limit must be a positive safe integer.");
  }
}

function compareCandidates(left, right) {
  if (left.isPart !== right.isPart) return left.isPart ? -1 : 1;
  if (left.distance !== right.distance) return left.distance - right.distance;
  return left.index - right.index;
}

function siftUpWorstFirst(heap, startIndex) {
  let index = startIndex;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareCandidates(heap[index], heap[parent]) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDownWorstFirst(heap, startIndex) {
  let index = startIndex;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;

    if (left < heap.length && compareCandidates(heap[left], heap[worst]) > 0) worst = left;
    if (right < heap.length && compareCandidates(heap[right], heap[worst]) > 0) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

/**
 * Keep only the best bounded set of building records. Parts retain priority
 * over complete shells, then distance and source order provide stable ties.
 */
export function selectNearestLodRecords(records, limit, getDistance) {
  assertLimit(limit);
  if (!Array.isArray(records)) throw new TypeError("LOD records must be an array.");
  if (typeof getDistance !== "function") throw new TypeError("LOD distance accessor must be a function.");

  const heap = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const distance = getDistance(record);
    if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) continue;

    const isPart = record?.isPart === true;
    const currentWorst = heap[0];
    const isBetterThanWorst = currentWorst && (
      (isPart && !currentWorst.isPart)
      || (isPart === currentWorst.isPart && (
        distance < currentWorst.distance
        || (distance === currentWorst.distance && index < currentWorst.index)
      ))
    );
    if (heap.length >= limit && !isBetterThanWorst) continue;

    const candidate = { record, distance, isPart, index };
    if (heap.length < limit) {
      heap.push(candidate);
      siftUpWorstFirst(heap, heap.length - 1);
    } else {
      heap[0] = candidate;
      siftDownWorstFirst(heap, 0);
    }
  }

  return heap.sort(compareCandidates).map((candidate) => candidate.record);
}
