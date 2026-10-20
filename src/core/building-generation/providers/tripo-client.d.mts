export type TripoTaskStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type TripoTaskResult = { taskId: string; status: TripoTaskStatus; progress: number | null; modelUrl?: string; previewUrl?: string; message?: string };
export declare function createTripoGenerationClient(options?: { apiKey?: string; fetchImpl?: typeof fetch; model?: string }): {
  uploadImage(options: { bytes: Uint8Array; filename?: string; contentType?: "image/jpeg" | "image/png"; signal?: AbortSignal }): Promise<{ fileToken: string }>;
  submitImage(options: { input: string; texture?: boolean; pbr?: boolean; signal?: AbortSignal }): Promise<{ taskId: string }>;
  submitMultiview(options: { views: Partial<Record<"front" | "left" | "back" | "right", string>>; texture?: boolean; pbr?: boolean; signal?: AbortSignal }): Promise<{ taskId: string }>;
  getTask(taskId: string, options?: { signal?: AbortSignal }): Promise<TripoTaskResult>;
};
export declare const TRIPO_GENERATION_DEFAULTS: Readonly<{ baseUrl: string; model: string }>;
