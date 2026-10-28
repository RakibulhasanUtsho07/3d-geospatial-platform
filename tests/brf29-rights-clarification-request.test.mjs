import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "benchmarks/building-reconstruction/brf-29-tum2twin-rights-clarification.json");
const docPath = path.join(root, "docs/research/BRF-29-TUM2TWIN-RIGHTS-CLARIFICATION-REQUEST.md");
const md5 = /^[a-f0-9]{32}$/;

test("BRF-29 packet inventories the exact public-record files without assuming permission", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.recordType, "brf-29-tum2twin-rights-clarification-request");
  assert.equal(manifest.status, "draft-not-sent");
  assert.equal(manifest.sourceRecord.doi, "10.5281/zenodo.15282970");
  assert.equal(manifest.sourceRecord.version, "1.2.0");
  assert.match(manifest.sourceRecord.latestVisibleRightsField, /no license value/i);

  assert.equal(manifest.assets.length, 14);
  const filenames = manifest.assets.map((asset) => asset.filename);
  assert.equal(new Set(filenames).size, filenames.length);
  for (const asset of manifest.assets) {
    assert.match(asset.filename, /^[A-Za-z0-9_.-]+$/);
    assert.match(asset.publisherMd5, md5, asset.filename + " has a malformed publisher MD5 reference");
    assert.equal(asset.localAcquisitionStatus, "not-acquired");
    assert.equal(asset.localByteSize, null);
    assert.equal(asset.localSha256, null);
    assert.equal(asset.rightsDecision, "pending");
    assert.equal(asset.requestedScopes.length, manifest.requestedScopes.length);
    assert.deepEqual(asset.requestedScopes, manifest.requestedScopes);
  }

  const scopes = new Set(manifest.requestedScopes);
  for (const scope of [
    "download-and-store-for-private-inspection",
    "use-for-scientific-and-metric-validation",
    "derive-geometry-and-reconstructed-models",
    "use-source-images-for-texture-baking",
    "public-display-in-interactive-web-platform",
    "commercial-use",
    "redistribute-original-source-bytes",
    "redistribute-derived-models-and-textures",
    "redistribute-renders-and-visualizations",
  ]) assert.ok(scopes.has(scope), "Missing requested permission scope: " + scope);

  assert.equal(manifest.permissionsMustBeAnsweredSeparatelyPerAssetFamily, true);
  assert.equal(manifest.policy.inferPermissionFromPublicAvailability, false);
  assert.equal(manifest.policy.inferPermissionFromDatasetOpenLabel, false);
  assert.equal(manifest.policy.inferPermissionFromPaperPublicationLicence, false);
  assert.equal(manifest.policy.inferRightsFromRelatedRepository, false);
  assert.equal(manifest.policy.requireExactAssetByteBindingAfterAcquisition, true);
  assert.equal(manifest.policy.requireHumanRightsReview, true);
  assert.ok(Object.values(manifest.releaseFlags).every((value) => value === false));

  const external = manifest.additionalAssetFamiliesOutsideZenodoRecord;
  assert.equal(external.length, 1);
  assert.equal(external[0].family, "TUM2TWIN CityGML/LOD2/LOD3 building models and source projects");
  assert.equal(external[0].sourceFilesPinned, false);
  assert.equal(external[0].rightsDecision, "pending");
  assert.ok(external[0].requestedScopes.includes("commercial-use"));
});

test("BRF-29 email draft asks for exact-file commercial and derivative-use rights", async () => {
  const doc = await readFile(docPath, "utf8");
  assert.match(doc, /DRAFT — NOT SENT/);
  assert.match(doc, /benedikt\.schwab@tum\.de/);
  assert.match(doc, /olaf\.wysocki@tum\.de/);
  assert.match(doc, /info\.rsa@ed\.tum\.de/);
  for (const expected of [
    "commercial use",
    "public interactive display",
    "redistribution of original source bytes",
    "derived models",
    "share-alike",
    "grantor",
    "exact asset",
    "not assume",
    "permission evidence",
  ]) assert.ok(doc.toLowerCase().includes(expected.toLowerCase()), "Request draft missing: " + expected);
});
