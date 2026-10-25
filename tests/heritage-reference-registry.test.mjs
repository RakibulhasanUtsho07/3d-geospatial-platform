import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { REQUIRED_HERITAGE_REFERENCE_ROLES, validateHeritageReferenceRegistry } from "../src/core/building-generation/heritage-reference-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(await readFile(path.join(root, "data/heritage/ahsan-manzil-reference-sources.json"), "utf8"));

test("checked-in Ahsan Manzil reference registry covers front, side and high-angle roof views", () => {
  const result = validateHeritageReferenceRegistry(registry);
  assert.equal(result.valid, true, result.errors.join(", "));
  assert.equal(result.sourceCount, 3);
  assert.deepEqual(result.requiredRoles, ["front-facade", "side-facade", "high-angle-roof"]);
  assert.deepEqual([...REQUIRED_HERITAGE_REFERENCE_ROLES], ["front-facade", "side-facade", "high-angle-roof"]);
  assert.deepEqual(result.pendingHashPins, ["ahsan-high-angle-rayhan9d-2020"]);
});

test("review-only photographic evidence cannot claim surveyed dimensions, ground control or release eligibility", () => {
  const altered = structuredClone(registry);
  altered.policy.establishesSurveyedDimensions = true;
  const result = validateHeritageReferenceRegistry(altered);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("evidence-policy-must-remain-review-only"));
});

test("rejects missing attribution, a non-Commons download host, and a wrong license", () => {
  const altered = structuredClone(registry);
  altered.sources[0].attribution = "";
  altered.sources[1].downloadUrl = "https://example.org/image.jpg";
  altered.sources[2].license = "CC BY 4.0";
  const result = validateHeritageReferenceRegistry(altered);
  assert.ok(result.errors.includes("source-0-attribution-missing"));
  assert.ok(result.errors.includes("source-1-download-host-invalid"));
  assert.ok(result.errors.includes("source-2-license-metadata-invalid"));
});

test("requires a pinned SHA-1 to be well formed and labels an unpinned image explicitly", () => {
  const altered = structuredClone(registry);
  altered.sources[0].expectedSha1 = "abc";
  altered.sources[2].hashPinStatus = "pinned";
  const result = validateHeritageReferenceRegistry(altered);
  assert.ok(result.errors.includes("source-0-pinned-sha1-invalid"));
  assert.ok(result.errors.includes("source-2-pinned-sha1-invalid"));
});

test("requires all expected view roles and forbids unsafe output names", () => {
  const altered = structuredClone(registry);
  altered.sources[2].viewRole = "front-facade";
  altered.sources[1].fileName = "../escape.jpg";
  const result = validateHeritageReferenceRegistry(altered);
  assert.ok(result.errors.includes("required-view-role-missing:high-angle-roof"));
  assert.ok(result.errors.includes("source-1-filename-invalid"));
});

test("rejects non-HTTPS or external source-page URLs and invalid model hash binding", () => {
  const altered = structuredClone(registry);
  altered.sources[0].sourcePageUrl = "http://commons.wikimedia.org/file";
  altered.candidateModel.sha256 = "0".repeat(63);
  const result = validateHeritageReferenceRegistry(altered);
  assert.ok(result.errors.includes("source-0-source-page-host-invalid"));
  assert.ok(result.errors.includes("candidate-model-sha256-invalid"));
});
