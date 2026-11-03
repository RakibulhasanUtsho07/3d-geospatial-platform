import { createHmac, timingSafeEqual } from "node:crypto";

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


export const GENERATION_OPERATOR_SESSION_COOKIE = "generation_operator_session";
export const GENERATION_OPERATOR_SESSION_SECONDS = 30 * 60;

function constantTimeTextEqual(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

/** Validate the one-time operator passphrase used to mint an HttpOnly session. */
export function verifyGenerationOperatorLoginToken(supplied, env = process.env) {
  const expected = typeof env.GENERATION_OPERATOR_LOGIN_TOKEN === "string"
    ? env.GENERATION_OPERATOR_LOGIN_TOKEN
    : "";
  const signingSecret = typeof env.GENERATION_OPERATOR_SESSION_SECRET === "string"
    ? env.GENERATION_OPERATOR_SESSION_SECRET
    : "";
  if (expected.length < MIN_TOKEN_LENGTH || signingSecret.length < MIN_TOKEN_LENGTH) {
    return { allowed: false, status: 503, error: "Generation operator session authentication is not configured." };
  }
  if (typeof supplied !== "string" || supplied.length > 4096 ||
      !constantTimeTextEqual(expected, supplied)) {
    return { allowed: false, status: 401, error: "Invalid operator credentials." };
  }
  return { allowed: true, status: 200 };
}

function signSessionPayload(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a signed short-lived cookie value. The signing key never leaves the server. */
export function createGenerationOperatorSessionValue({
  env = process.env,
  now = new Date(),
} = {}) {
  const secret = typeof env.GENERATION_OPERATOR_SESSION_SECRET === "string"
    ? env.GENERATION_OPERATOR_SESSION_SECRET
    : "";
  if (secret.length < MIN_TOKEN_LENGTH) {
    throw new Error("Generation operator session signing is not configured.");
  }
  const issuedAt = Math.floor(new Date(now).getTime() / 1000);
  if (!Number.isFinite(issuedAt)) throw new TypeError("now must be a valid timestamp.");
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    scope: "generation:operator",
    issuedAt,
    expiresAt: issuedAt + GENERATION_OPERATOR_SESSION_SECONDS,
  }), "utf8").toString("base64url");
  return payload + "." + signSessionPayload(payload, secret);
}

function readCookie(request, name) {
  const header = request?.headers?.get?.("cookie") ?? "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return "";
}

/** Validate the HttpOnly cookie and its bounded lifetime. */
export function verifyGenerationOperatorSession(request, {
  env = process.env,
  now = new Date(),
} = {}) {
  const secret = typeof env.GENERATION_OPERATOR_SESSION_SECRET === "string"
    ? env.GENERATION_OPERATOR_SESSION_SECRET
    : "";
  if (secret.length < MIN_TOKEN_LENGTH) {
    return { allowed: false, status: 503, error: "Generation operator session authentication is not configured." };
  }
  const value = readCookie(request, GENERATION_OPERATOR_SESSION_COOKIE);
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined || payload.length > 2048 || signature.length > 256) {
    return { allowed: false, status: 401, error: "Operator session is missing or invalid." };
  }
  const expectedSignature = signSessionPayload(payload, secret);
  if (!constantTimeTextEqual(expectedSignature, signature)) {
    return { allowed: false, status: 401, error: "Operator session is invalid." };
  }

  let record;
  try {
    record = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { allowed: false, status: 401, error: "Operator session payload is invalid." };
  }
  const nowSeconds = Math.floor(new Date(now).getTime() / 1000);
  if (!Number.isFinite(nowSeconds) || !record || record.version !== 1 ||
      record.scope !== "generation:operator" ||
      !Number.isInteger(record.issuedAt) || !Number.isInteger(record.expiresAt) ||
      record.issuedAt > nowSeconds + 60 ||
      record.expiresAt <= nowSeconds ||
      record.expiresAt - record.issuedAt > GENERATION_OPERATOR_SESSION_SECONDS) {
    return { allowed: false, status: 401, error: "Operator session has expired or is invalid." };
  }
  return { allowed: true, status: 200, expiresAt: record.expiresAt };
}

export function isSameOriginGenerationRequest(request) {
  const origin = request?.headers?.get?.("origin");
  if (typeof origin !== "string" || !origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Generation intake/status routes accept either the legacy bearer token for
 * scripts or a short-lived HttpOnly operator session for the browser UI.
 * Cookie-authenticated writes must carry a same-origin Origin header.
 */
export function authorizeGenerationOperatorRequest(request, env = process.env) {
  const session = verifyGenerationOperatorSession(request, { env });
  if (session.allowed) {
    const method = request?.method?.toUpperCase?.() ?? "GET";
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !isSameOriginGenerationRequest(request)) {
      return { allowed: false, status: 403, error: "Cross-origin generation requests are not allowed." };
    }
    return session;
  }
  const bearer = authorizeGenerationApiRequest(request, env);
  if (bearer.allowed) return bearer;
  if (bearer.status === 503) return session.status === 503 ? bearer : session;
  return bearer;
}
