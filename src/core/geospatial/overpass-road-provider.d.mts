export type OverpassRoadDetailLevel = "full" | "reduced";
export type OverpassRoadProviderResult = {
  elements: unknown[];
  endpoint: string;
  attempts: number;
  detailLevel: OverpassRoadDetailLevel;
};
export function resolveOverpassEndpoints(env?: Record<string, string | undefined>): string[];
export function fetchOverpassElements(args: {
  endpoints: string[];
  queries: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}): Promise<OverpassRoadProviderResult>;
