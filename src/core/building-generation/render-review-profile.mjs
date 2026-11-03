export const DEFAULT_RENDER_REVIEW_PROFILE = Object.freeze({
  schemaVersion: "1.0.0",
  profileId: "generic-whole-model-v1",
  excludeNodeNamePrefixes: Object.freeze([]),
  frontView: Object.freeze({
    includeNodeNames: Object.freeze([]),
    excludeNodeNames: Object.freeze([]),
    elevationDegrees: 5,
    framingLabel: "whole-model-generic-front",
  }),
});

const PROFILE_KEYS = new Set(["schemaVersion", "profileId", "excludeNodeNamePrefixes", "frontView"]);
const FRONT_VIEW_KEYS = new Set(["includeNodeNames", "excludeNodeNames", "elevationDegrees", "framingLabel"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateNameList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(label + " must be an array of node-name strings");
  const names = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 200 || entry.includes("*")) {
      throw new TypeError(label + "[" + index + "] must be a non-empty exact node name without wildcards");
    }
    return entry.trim();
  });
  if (new Set(names).size !== names.length) throw new TypeError(label + " must not contain duplicates");
  return names;
}

/**
 * Validate a render-only profile. Profiles choose which already-authored GLB nodes
 * appear in review views; they never edit the GLB or assert that a part is accurate.
 */
export function validateRenderReviewProfile(value) {
  if (!isRecord(value)) throw new TypeError("render review profile must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!PROFILE_KEYS.has(key)) throw new TypeError("unsupported render review profile field: " + key);
  }
  if (value.schemaVersion !== "1.0.0") throw new TypeError("render review profile schemaVersion must be 1.0.0");
  if (typeof value.profileId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(value.profileId)) {
    throw new TypeError("render review profile profileId must be a short stable identifier");
  }
  const excludeNodeNamePrefixes = validateNameList(value.excludeNodeNamePrefixes ?? [], "excludeNodeNamePrefixes");
  const inputFront = value.frontView ?? {};
  if (!isRecord(inputFront)) throw new TypeError("frontView must be an object");
  for (const key of Object.keys(inputFront)) {
    if (!FRONT_VIEW_KEYS.has(key)) throw new TypeError("unsupported frontView field: " + key);
  }
  const includeNodeNames = validateNameList(inputFront.includeNodeNames ?? [], "frontView.includeNodeNames");
  const excludeNodeNames = validateNameList(inputFront.excludeNodeNames ?? [], "frontView.excludeNodeNames");
  const overlap = includeNodeNames.filter((name) => excludeNodeNames.includes(name));
  if (overlap.length) throw new TypeError("frontView node names cannot be both included and excluded: " + overlap.join(", "));
  const elevationDegrees = inputFront.elevationDegrees ?? 5;
  if (typeof elevationDegrees !== "number" || !Number.isFinite(elevationDegrees) ||
      elevationDegrees < 0 || elevationDegrees > 60) {
    throw new RangeError("frontView.elevationDegrees must be between 0 and 60");
  }
  const framingLabel = inputFront.framingLabel ?? "whole-model-generic-front";
  if (typeof framingLabel !== "string" || !/^[a-z0-9][a-z0-9._ -]{0,79}$/i.test(framingLabel)) {
    throw new TypeError("frontView.framingLabel must be a short human-readable label");
  }
  return {
    schemaVersion: "1.0.0",
    profileId: value.profileId,
    excludeNodeNamePrefixes,
    frontView: { includeNodeNames, excludeNodeNames, elevationDegrees, framingLabel },
  };
}
