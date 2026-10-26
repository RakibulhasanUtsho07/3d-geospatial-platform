const DEFAULT_RESOLUTION = 1024;
const DEFAULT_TIMEOUT_MS = 600000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 900000;

/** Parse bounded, repeatable options for the headless building review renderer. */
export function parseRenderOptions(args = [], env = process.env) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("renderer options must be an array of strings");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("renderer environment must be an object");
  }
  let resolution = DEFAULT_RESOLUTION;
  let blender = env.BLENDER_BIN || "blender";
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (const arg of args) {
    if (arg.startsWith("--resolution=")) resolution = Number(arg.slice("--resolution=".length));
    else if (arg.startsWith("--blender=")) blender = arg.slice("--blender=".length);
    else if (arg.startsWith("--timeout-ms=")) timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else throw new Error("Unknown option: " + arg);
  }

  if (!Number.isSafeInteger(resolution) || resolution < 256 || resolution > 2048 ||
      (resolution & (resolution - 1)) !== 0) {
    throw new RangeError("resolution must be a power-of-two integer between 256 and 2048");
  }
  if (typeof blender !== "string" || !blender.trim()) {
    throw new TypeError("Blender executable cannot be empty");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("timeout-ms must be an integer between 1000 and 900000");
  }
  return { resolution, blender: blender.trim(), timeoutMs };
}
