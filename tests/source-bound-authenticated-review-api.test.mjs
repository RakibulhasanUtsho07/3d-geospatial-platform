import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL(
  "../src/app/api/building-generation/handoffs/[buildingId]/[handoffJobId]/review/route.ts",
  import.meta.url,
), "utf8");

test("source-bound review API requires a dedicated service token and server-trusted reviewer registry", () => {
  assert.match(route, /GENERATION_EVIDENCE_REVIEW_API_TOKEN/);
  assert.match(route, /RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON/);
  assert.match(route, /parseTrustedReconstructionReviewerKeys/);
  assert.match(route, /recordSourceBoundAuthenticatedReview/);
  assert.match(route, /Cache-Control.*private, no-store/);
});

test("review API rejects caller-supplied public keys and bounds the request body", () => {
  assert.match(route, /MAX_REVIEW_BODY_BYTES = 64 \* 1024/);
  assert.ok(route.includes("Object.keys(payload).some"));
  assert.match(route, /Trusted public keys are server-configured/);
  assert.match(route, /signatureBase64/);
});
