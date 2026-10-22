import { timingSafeEqual } from "node:crypto";

const MIN_TOKEN_LENGTH = 32;

export function authorizeGenerationApiRequest(
  request,
  env = process.env,
  { tokenEnvName = "GENERATION_API_TOKEN", serviceName = "Generation API" } = {},
) {
  const token = env[tokenEnvName];
  const expected = typeof token === "string" ? token : "";

  if (expected.length < MIN_TOKEN_LENGTH) {
    return { allowed: false, status: 503, error: serviceName + " authentication is not configured." };
  }

  const header = request?.headers?.get?.("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match || match[1].length > 4096) {
    return { allowed: false, status: 401, error: "Unauthorized." };
  }

  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(match[1], "utf8");
  if (expectedBytes.length !== suppliedBytes.length ||
      !timingSafeEqual(expectedBytes, suppliedBytes)) {
    return { allowed: false, status: 401, error: "Unauthorized." };
  }

  return { allowed: true, status: 200 };
}

export function getGenerationWorkspaceRoot(env = process.env) {
  const value = typeof env.BUILDING_ENGINE_WORKSPACE === "string"
    ? env.BUILDING_ENGINE_WORKSPACE.trim()
    : "";
  if (!value) throw new Error("BUILDING_ENGINE_WORKSPACE is not configured.");
  return value;
}
