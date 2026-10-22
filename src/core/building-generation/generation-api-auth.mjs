import { timingSafeEqual } from "node:crypto";

const MIN_TOKEN_LENGTH = 32;

export function authorizeGenerationApiRequest(request, env = process.env) {
  const expected = typeof env.GENERATION_API_TOKEN === "string"
    ? env.GENERATION_API_TOKEN
    : "";

  if (expected.length < MIN_TOKEN_LENGTH) {
    return { allowed: false, status: 503, error: "Generation API authentication is not configured." };
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
