export const SOURCE_OPERATION_SCOPES = Object.freeze([
  "private-media-ingestion",
  "private-image-quality-preflight",
  "video-frame-extraction",
  "procedural-model-derivation",
  "single-image-ai-reconstruction",
  "photogrammetry-reconstruction",
  "texture-baking",
]);

export function normalizeSourceOperationScopes(value, label = "permittedOperations") {
  if (!Array.isArray(value) || value.length < 1 || value.length > SOURCE_OPERATION_SCOPES.length) {
    throw new TypeError(label + " must explicitly list one or more recognized operation scopes");
  }
  const normalized = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 80) {
      throw new TypeError(label + "[" + index + "] must be a non-empty scope string of at most 80 characters");
    }
    const scope = item.trim();
    if (!SOURCE_OPERATION_SCOPES.includes(scope)) {
      throw new TypeError(label + " contains an unsupported operation scope: " + scope);
    }
    return scope;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(label + " must not contain duplicate operation scopes");
  }
  return normalized.sort();
}
