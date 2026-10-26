import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pack = JSON.parse(await readFile(new URL("../data/heritage/bangabhaban-reference-pack.json", import.meta.url), "utf8"));

test("Bangabhaban reference downloader is wired as an explicit package command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["fetch:bangabhaban-reference"], "node scripts/fetch-bangabhaban-reference.mjs");
  const downloader = await readFile(new URL("../scripts/fetch-bangabhaban-reference.mjs", import.meta.url), "utf8");
  assert.match(downloader, /createHash\("sha256"\)/);
  assert.match(downloader, /expectedByteLength/);
  assert.match(downloader, /expectedSha1/);
  assert.match(downloader, /verified: true/);
  assert.match(downloader, /process\.exitCode = 1/);
  assert.match(downloader, /Existing reference file differs from the verified source/);
  assert.match(downloader, /Existing reference manifest differs from the newly verified manifest/);
  assert.match(downloader, /writeFile\(imagePath, bytes, \{ flag: "wx" \}\)/);
  assert.match(downloader, /writeFile\(manifestPath, manifestText, \{ flag: "wx" \}\)/);
  assert.match(downloader, /existingSha256/);
});

test("Bangabhaban pilot keeps public references and geometry claims provenance-gated", () => {
  assert.equal(pack.schemaVersion, "1.0.0");
  assert.equal(pack.id, "bangabhaban-dhaka-reference-pack");
  assert.equal(pack.reconstructionStatus, "reference-intake-only");
  assert.equal(pack.geometryPolicy.dimensions.status, "unknown");
  assert.equal(pack.geometryPolicy.footprint.status, "not-traced");
  assert.equal(pack.geometryPolicy.model.status, "not-generated");
  assert.equal(pack.geometryPolicy.model.publicationEligible, false);
  assert.ok(pack.sources.some((source) => source.id === "official-location" && source.kind === "official-text"));
  const aerial = pack.sources.find((source) => source.id === "licensed-aerial-2006");
  assert.equal(aerial.license, "CC BY-SA 4.0");
  assert.equal(aerial.downloaded, false);
  assert.equal(aerial.sha256, null, "do not pretend the image was downloaded or hash-pinned");
  const exterior = pack.sources.find((source) => source.id === "licensed-exterior-2017");
  assert.equal(exterior.license, "CC BY 2.0");
  assert.equal(exterior.downloaded, false);
  assert.equal(exterior.sha256, null, "published SHA-1 metadata is not a locally computed SHA-256");
  assert.equal(exterior.viewAssessment.cameraCalibration, "unknown");
  assert.equal(exterior.viewAssessment.captureCoordinates, "unknown");
  assert.ok(exterior.viewAssessment.occlusions.length > 0);
  assert.ok(exterior.viewAssessment.notSufficientFor.includes("multi-view photogrammetry"));
  assert.ok(pack.acceptanceGates.some((gate) => gate.includes("approximate camera pose") && gate.includes("visible occlusion")), "reference review gate must cover camera pose and occlusion classification");
  const video = pack.sources.find((source) => source.id === "official-video-2016");
  assert.equal(video.downloaded, false);
  assert.match(video.license, /not established/i);
  assert.ok(video.notUsableFor.includes("texture baking or redistribution without permission"));
  assert.ok(pack.acceptanceGates.some((gate) => gate.includes("Compound area is never substituted")));
  assert.ok(pack.acceptanceGates.some((gate) => gate.includes("independent reference review")));
  for (const source of pack.sources) {
    assert.ok(source.url.startsWith("https://"), source.id + " needs a source URL");
    assert.ok(source.id && source.title, "every source needs an ID and title");
  }
});
