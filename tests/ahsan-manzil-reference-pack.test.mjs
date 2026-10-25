import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pack = JSON.parse(await readFile(new URL("../data/heritage/ahsan-manzil-reference-pack.json", import.meta.url), "utf8"));

test("Ahsan Manzil reference pack uses fixed, permission-documented Wikimedia sources", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["fetch:ahsan-manzil-reference-pack"], "node scripts/fetch-ahsan-manzil-reference-pack.mjs");
  assert.equal(packageJson.scripts["test:ahsan-manzil-reference-pack"], "node --test tests/ahsan-manzil-reference-pack.test.mjs");
  const downloader = await readFile(new URL("../scripts/fetch-ahsan-manzil-reference-pack.mjs", import.meta.url), "utf8");
  assert.match(downloader, /createHash\("sha256"\)/);
  assert.match(downloader, /createHash\("sha1"\)/);
  assert.match(downloader, /expectedByteLength/);
  assert.match(downloader, /publishedSha1/);
  assert.match(downloader, /upload\.wikimedia\.org/);
  assert.match(downloader, /Existing reference file differs from its verified source/);
  assert.match(downloader, /Existing reference manifest differs from the newly verified manifest/);
  assert.match(downloader, /verified: true/);
  assert.match(downloader, /process\.exitCode = 1/);
});

test("three distinct views are explicitly rights-cleared but not treated as survey control", () => {
  assert.equal(pack.schemaVersion, "1.0.0");
  assert.equal(pack.id, "ahsan-manzil-dhaka-reference-pack");
  assert.equal(pack.reconstructionStatus, "reference-intake-only");
  assert.equal(pack.geometryPolicy.dimensions.status, "published-reference-only");
  assert.equal(pack.geometryPolicy.footprint.status, "not-traced");
  assert.equal(pack.geometryPolicy.model.publicationEligible, false);
  assert.equal(pack.sources.filter((source) => source.kind === "image").length, 3);
  assert.deepEqual(new Set(pack.sources.map((source) => source.viewRole)), new Set([
    "south-front-elevation", "side-facade", "oblique-front-side"
  ]));
  for (const source of pack.sources) {
    assert.ok(source.url.startsWith("https://commons.wikimedia.org/wiki/File:"));
    assert.ok(source.originalFileUrl.startsWith("https://upload.wikimedia.org/wikipedia/commons/"));
    assert.equal(source.license, "CC BY-SA 4.0");
    assert.equal(source.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
    assert.equal(source.attributionRequired, true);
    assert.equal(source.modificationDisclosureRequired, true);
    assert.ok(Number.isSafeInteger(source.expectedByteLength) && source.expectedByteLength > 100000);
    assert.match(source.publishedSha1, /^[a-f0-9]{40}$/);
    assert.equal(source.sha256, null, "do not invent a local SHA-256 before downloading the original bytes");
    assert.equal(source.downloaded, false);
    assert.equal(source.viewAssessment.cameraCalibration, "unknown");
    assert.ok(source.notUsableFor.includes("independent dimension survey"));
    assert.ok(source.viewAssessment.notSufficientFor.some((value) => value.includes("survey-grade")));
  }
  assert.ok(pack.acceptanceGates.some((gate) => gate.includes("Compute and store SHA-256 locally")));
  assert.ok(pack.acceptanceGates.some((gate) => gate.includes("independent surveyed dimensions")));
});
