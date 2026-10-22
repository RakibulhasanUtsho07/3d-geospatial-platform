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
