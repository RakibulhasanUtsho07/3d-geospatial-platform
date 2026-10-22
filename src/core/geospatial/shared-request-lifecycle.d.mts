export interface SharedRequestConsumerEntry {
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export function attachSharedRequestConsumer(
  entry: SharedRequestConsumerEntry,
  signal: AbortSignal,
): () => void;
