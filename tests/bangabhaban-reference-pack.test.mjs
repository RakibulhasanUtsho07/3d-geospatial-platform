import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const pack = JSON.parse(await readFile(new URL("../data/heritage/bangabhaban-reference-pack.json", import.meta.url), "utf8"));
test("Bangabhaban source pack preserves per-file rights and unknown camera calibration", () => {
  assert.equal(pack.id, "bangabhaban-dhaka-reference-pack");
  for (const id of ["licensed-aerial-2006", "licensed-exterior-2017", "licensed-aerial-2017"]) {
    const source = pack.sources.find(s => s.id === id);
    assert.ok(source, "missing " + id);
    assert.ok(source.attributionRequired);
    assert.ok(source.modificationDisclosureRequired);
    assert.equal(source.downloaded, false);
    assert.equal(source.sha256, null, "static pack must not pretend the source bytes were downloaded");
    assert.equal(source.viewAssessment.cameraCalibration, "unknown");
  }
  assert.equal(pack.sources.find(s => s.id === "licensed-aerial-2006").license, "CC BY-SA 4.0");
  assert.equal(pack.sources.find(s => s.id === "licensed-exterior-2017").license, "CC BY 2.0");
  assert.equal(pack.sources.find(s => s.id === "licensed-aerial-2017").license, "CC BY 2.0");
  assert.equal(pack.geometryPolicy.dimensions.status, "unknown");
  assert.equal(pack.geometryPolicy.footprint.status, "not-traced");
  assert.equal(pack.geometryPolicy.model.publicationEligible, false);
  assert.ok(pack.acceptanceGates.some(g => g.includes("independent reference review")));
});
test("Bangabhaban reference downloader validates image bytes and published checksum where available", async () => {
  const downloader = await readFile(new URL("../scripts/fetch-bangabhaban-reference-pack.mjs", import.meta.url), "utf8");
  assert.match(downloader, /createHash/);
  assert.match(downloader, /expectedSha1/);
  assert.match(downloader, /expectedByteLength/);
  assert.match(downloader, /image\/jpeg/);
  assert.match(downloader, /verified: true/);
  assert.match(downloader, /redirect: "follow"/);
  assert.match(downloader, /async function fetchSource/);
  assert.match(downloader, /retry-after/);
  assert.match(downloader, /Special:FilePath/);
});
