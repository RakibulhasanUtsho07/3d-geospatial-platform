const API_BASE_URL = "https://openapi.tripo3d.ai/v3";
const DEFAULT_MODEL = "v3.1-20260211";
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{4,200}$/;
const FILE_TOKEN_PATTERN = /^file_[A-Za-z0-9_-]{4,240}$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerInput(value, name = "input") {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || value !== value.trim()) {
    throw new TypeError(name + " must be a provider file token or HTTPS asset URL.");
  }
  if (FILE_TOKEN_PATTERN.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new TypeError(name + " must be a provider file token or HTTPS URL."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new TypeError(name + " must be a provider file token or HTTPS URL without credentials.");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    throw new TypeError(name + " cannot reference a local host.");
  }
  return url.toString();
}

function providerInputObject(value, name) {
  const normalized = providerInput(value, name);
  return normalized.startsWith("file_") ? { file_token: normalized } : { url: normalized };
}

async function readResponse(response) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch {
    throw new Error("Tripo API returned a non-JSON response (HTTP " + response.status + ").");
  }
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.message === "string" ? payload.message : "Request failed.";
    throw new Error("Tripo API request failed (HTTP " + response.status + "): " + detail.slice(0, 400));
  }
  if (isRecord(payload) && typeof payload.code === "number" && payload.code !== 0) {
    const detail = typeof payload.message === "string" ? payload.message : "Provider rejected the request.";
    throw new Error("Tripo API rejected the request: " + detail.slice(0, 400));
  }
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error("Tripo API response is missing data.");
  return payload.data;
}

function normalizeTask(data, expectedTaskId) {
  if (typeof data.task_id !== "string" || !TASK_ID_PATTERN.test(data.task_id)) throw new Error("Tripo API returned an invalid task ID.");
  if (expectedTaskId && data.task_id !== expectedTaskId) throw new Error("Tripo task ID does not match the requested task.");
  if (!["queued", "running", "success", "failed", "cancelled"].includes(data.status)) throw new Error("Tripo API returned an unsupported task status.");
  const result = {
    taskId: data.task_id,
    status: data.status,
    progress: typeof data.progress === "number" && Number.isFinite(data.progress) ? Math.max(0, Math.min(100, data.progress)) : null,
  };
  if (isRecord(data.output)) {
    if (typeof data.output.model_url === "string" && data.output.model_url.startsWith("https://")) result.modelUrl = data.output.model_url;
    if (typeof data.output.rendered_image_url === "string" && data.output.rendered_image_url.startsWith("https://")) result.previewUrl = data.output.rendered_image_url;
  }
  if (typeof data.message === "string") result.message = data.message.slice(0, 500);
  return result;
}

/** Server-side async client. Never pass a browser-provided API key. */
export function createTripoGenerationClient({ apiKey, fetchImpl = fetch, model = DEFAULT_MODEL } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("TRIPO_API_KEY is not configured.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (typeof model !== "string" || !model.trim() || model.length > 100) throw new TypeError("model must be a valid pinned model version.");

  async function request(path, init) {
    const response = await fetchImpl(API_BASE_URL + path, {
      ...init,
      headers: { Authorization: "Bearer " + apiKey, ...(init && init.headers ? init.headers : {}) },
    });
    return readResponse(response);
  }

  return Object.freeze({
    async submitImage({ input, texture = true, pbr = true, signal } = {}) {
      const source = providerInput(input);
      const data = await request("/generation/image-to-model", {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: source, model, texture, pbr }),
      });
      if (typeof data.task_id !== "string" || !TASK_ID_PATTERN.test(data.task_id)) throw new Error("Tripo API did not return a valid task ID.");
      return { taskId: data.task_id };
    },

    async submitMultiview({ views, texture = true, pbr = true, signal } = {}) {
      if (!isRecord(views)) throw new TypeError("views must map front/left/back/right to provider inputs.");
      if (!views.front) throw new TypeError("Multiview generation requires a front view.");
      const inputs = [];
      for (const view of ["front", "left", "back", "right"]) {
        if (views[view]) inputs.push({ [view]: providerInputObject(views[view], view) });
      }
      if (inputs.length < 2) throw new TypeError("Multiview generation requires at least two views.");
      const data = await request("/generation/multiview-to-model", {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs, model, texture, pbr }),
      });
      if (typeof data.task_id !== "string" || !TASK_ID_PATTERN.test(data.task_id)) throw new Error("Tripo API did not return a valid task ID.");
      return { taskId: data.task_id };
    },

    async getTask(taskId, { signal } = {}) {
      if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) throw new TypeError("taskId is invalid.");
      const data = await request("/tasks/" + encodeURIComponent(taskId), { method: "GET", signal });
      return normalizeTask(data, taskId);
    },
  });
}

export const TRIPO_GENERATION_DEFAULTS = Object.freeze({ baseUrl: API_BASE_URL, model: DEFAULT_MODEL });
