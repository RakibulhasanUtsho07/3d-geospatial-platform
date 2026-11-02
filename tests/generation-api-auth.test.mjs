import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeGenerationApiRequest,
  getGenerationWorkspaceRoot,
} from "../src/core/building-generation/generation-api-auth.mjs";

const TOKEN = "test-only-generation-api-token-which-is-long-enough";

function request(authorization) {
  return new Request("http://localhost/api/building-generation/jobs", {
    headers: authorization ? { authorization } : {},
  });
}

test("generation API authorization fails closed when the token is missing or too short", () => {
  assert.equal(authorizeGenerationApiRequest(request("Bearer " + TOKEN), {}).status, 503);
  assert.equal(authorizeGenerationApiRequest(request("Bearer short"), {
    GENERATION_API_TOKEN: "short",
  }).status, 503);
});

test("generation API requires a bearer token and rejects wrong tokens", () => {
  const env = { GENERATION_API_TOKEN: TOKEN };
  assert.deepEqual(authorizeGenerationApiRequest(request(null), env), {
    allowed: false, status: 401, error: "Unauthorized.",
  });
  assert.equal(authorizeGenerationApiRequest(request("Bearer incorrect-token-that-is-long-enough"), env).status, 401);
  assert.equal(authorizeGenerationApiRequest(request("Basic " + TOKEN), env).status, 401);
});

test("generation API accepts only the exact configured bearer token", () => {
  assert.deepEqual(authorizeGenerationApiRequest(request("Bearer " + TOKEN), {
    GENERATION_API_TOKEN: TOKEN,
  }), { allowed: true, status: 200 });
});

test("workspace configuration is explicit and can be read from an injected environment", () => {
  assert.throws(() => getGenerationWorkspaceRoot({}), /BUILDING_ENGINE_WORKSPACE/);
  assert.equal(getGenerationWorkspaceRoot({ BUILDING_ENGINE_WORKSPACE: "  /srv/building-engine  " }), "/srv/building-engine");
});


test("generation review API requires its own token and cannot reuse the generation token", () => {
  const reviewToken = "review-only-test-token-at-least-thirty-two-characters";
  const env = {
    GENERATION_API_TOKEN: TOKEN,
    GENERATION_REVIEW_API_TOKEN: reviewToken,
  };
  assert.equal(authorizeGenerationApiRequest(request("Bearer " + TOKEN), env, {
    tokenEnvName: "GENERATION_REVIEW_API_TOKEN",
    serviceName: "Generation review API",
  }).status, 401);
  assert.deepEqual(authorizeGenerationApiRequest(request("Bearer " + reviewToken), env, {
    tokenEnvName: "GENERATION_REVIEW_API_TOKEN",
    serviceName: "Generation review API",
  }), { allowed: true, status: 200 });
  assert.equal(authorizeGenerationApiRequest(request("Bearer " + reviewToken), {
    GENERATION_API_TOKEN: TOKEN,
  }, {
    tokenEnvName: "GENERATION_REVIEW_API_TOKEN",
    serviceName: "Generation review API",
  }).status, 503);
});


const OPERATOR_LOGIN = "operator-login-token-for-generation-ui-with-32-characters";
const OPERATOR_SIGNING = "server-only-hmac-signing-secret-for-generation-session";

test("operator login token is checked separately from the server-only session signing key", async () => {
  const {
    verifyGenerationOperatorLoginToken,
  } = await import("../src/core/building-generation/generation-api-auth.mjs");
  assert.equal(verifyGenerationOperatorLoginToken(OPERATOR_LOGIN, {}).status, 503);
  const env = {
    GENERATION_OPERATOR_LOGIN_TOKEN: OPERATOR_LOGIN,
    GENERATION_OPERATOR_SESSION_SECRET: OPERATOR_SIGNING,
  };
  assert.equal(verifyGenerationOperatorLoginToken("wrong-login-token-with-32-characters-minimum", env).status, 401);
  assert.deepEqual(verifyGenerationOperatorLoginToken(OPERATOR_LOGIN, env), { allowed: true, status: 200 });
});

test("signed operator session cookie is HttpOnly-compatible, time limited and tamper evident", async () => {
  const {
    createGenerationOperatorSessionValue,
    verifyGenerationOperatorSession,
    GENERATION_OPERATOR_SESSION_COOKIE,
    GENERATION_OPERATOR_SESSION_SECONDS,
  } = await import("../src/core/building-generation/generation-api-auth.mjs");
  const env = {
    GENERATION_OPERATOR_LOGIN_TOKEN: OPERATOR_LOGIN,
    GENERATION_OPERATOR_SESSION_SECRET: OPERATOR_SIGNING,
  };
  const now = new Date("2026-11-02T04:00:00.000Z");
  const value = createGenerationOperatorSessionValue({ env, now });
  const requestWithCookie = (cookieValue) => new Request("https://example.test/api/building-generation/jobs", {
    headers: { cookie: GENERATION_OPERATOR_SESSION_COOKIE + "=" + cookieValue },
  });
  const valid = verifyGenerationOperatorSession(requestWithCookie(value), { env, now });
  assert.equal(valid.allowed, true);
  assert.equal(valid.expiresAt - Math.floor(now.getTime() / 1000), GENERATION_OPERATOR_SESSION_SECONDS);
  assert.equal(verifyGenerationOperatorSession(requestWithCookie(value + "x"), { env, now }).status, 401);
  assert.equal(verifyGenerationOperatorSession(requestWithCookie(value), {
    env, now: new Date(now.getTime() + (GENERATION_OPERATOR_SESSION_SECONDS + 1) * 1000),
  }).status, 401);
});

test("cookie-authenticated generation writes require a same-origin request", async () => {
  const {
    authorizeGenerationOperatorRequest,
    createGenerationOperatorSessionValue,
    GENERATION_OPERATOR_SESSION_COOKIE,
  } = await import("../src/core/building-generation/generation-api-auth.mjs");
  const env = {
    GENERATION_OPERATOR_SESSION_SECRET: OPERATOR_SIGNING,
  };
  const session = createGenerationOperatorSessionValue({ env });
  const cookie = GENERATION_OPERATOR_SESSION_COOKIE + "=" + session;
  const sameOrigin = new Request("https://example.test/api/building-generation/jobs", {
    method: "POST",
    headers: { cookie, origin: "https://example.test" },
  });
  const crossOrigin = new Request("https://example.test/api/building-generation/jobs", {
    method: "POST",
    headers: { cookie, origin: "https://attacker.test" },
  });
  const missingOrigin = new Request("https://example.test/api/building-generation/jobs", {
    method: "POST",
    headers: { cookie },
  });
  const readRequest = new Request("https://example.test/api/building-generation/jobs", {
    method: "GET",
    headers: { cookie },
  });
  assert.equal(authorizeGenerationOperatorRequest(sameOrigin, env).allowed, true);
  assert.equal(authorizeGenerationOperatorRequest(crossOrigin, env).status, 403);
  assert.equal(authorizeGenerationOperatorRequest(missingOrigin, env).status, 403);
  assert.equal(authorizeGenerationOperatorRequest(readRequest, env).allowed, true);
});

test("legacy generation bearer tokens remain available to local CLI clients", async () => {
  const { authorizeGenerationOperatorRequest } = await import("../src/core/building-generation/generation-api-auth.mjs");
  assert.deepEqual(authorizeGenerationOperatorRequest(request("Bearer " + TOKEN), {
    GENERATION_API_TOKEN: TOKEN,
  }), { allowed: true, status: 200 });
});
