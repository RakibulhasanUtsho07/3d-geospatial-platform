export type GlbValidationResult = {
  valid: true;
  contentType: "model/gltf-binary";
  bytes: number;
  jsonChunkBytes: number;
  meshCount: number;
  primitiveCount: number;
  triangleCount: number;
  vertexCount: number;
  nodeCount: number;
  materialCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  warnings: string[];
};
export declare function inspectGeneratedGlb(value: Buffer | Uint8Array, options?: {
  maxBytes?: number;
  maxJsonChunkBytes?: number;
  maxVertices?: number;
}): GlbValidationResult;
export declare function downloadGeneratedGlb(value: string, options?: {
  fetchImpl?: typeof fetch;
  allowedHosts?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ glb: Buffer; validation: GlbValidationResult }>;
export declare const GLB_VALIDATION_DEFAULTS: Readonly<{
  maxBytes: number;
  maxJsonChunkBytes: number;
  maxVertices: number;
  timeoutMs: number;
  allowedHosts: readonly string[];
}>;
