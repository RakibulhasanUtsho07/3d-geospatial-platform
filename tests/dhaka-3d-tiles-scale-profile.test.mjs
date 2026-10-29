import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseFeatureCounts,
  runDhaka3DTilesScaleProfile,
} from "../scripts/benchmark-dhaka-3d-tiles-scale-profile.mjs";

function squareFeature(id, west, south) {
  const east = west + 0.0001;
  const north = south + 0.0001;
  return {
    type: "Feature",
    id,
    properties: { class: "building" },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}

function sourceFixture() {
  return {
    type: "FeatureCollection",
    features: [
      squareFeature("scale-test-01", 90.4100, 23.7800),
      squareFeature("scale-test-02", 90.4105, 23.7805),
      squareFeature("scale-test-03", 90.4110, 23.7810),
      squareFeature("scale-test-04", 90.4115, 23.7815),
    ],
  };
}

test("parses only unique, increasing bounded integer feature counts", () => {
  assert.deepEqual(parseFeatureCounts("32, 64,128"), [32, 64, 128]);
  assert.deepEqual(parseFeatureCounts("1"), [1]);
  for (const invalid of ["", "0", "129", "1.5,2", "32,32", "64,32", "1,,2", "-1,2"]) {
    assert.throws(() => parseFeatureCounts(invalid), undefined, "must reject " + JSON.stringify(invalid));
  }
});

test("profiles small packages with integrity/alignment evidence and false release flags", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "p3-6-scale-profile-test-"));
  try {
    const sourcePath = path.join(temp, "source.geojson");
    const reportPath = path.join(temp, "scale-profile.json");
    await writeFile(sourcePath, JSON.stringify(sourceFixture()) + "\n");
    const report = await runDhaka3DTilesScaleProfile({
      sourcePath,
      featureCounts: [1, 2],
      reportPath,
    });

    assert.equal(report.status, "pass");
    assert.match(report.source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.samples.length, 2);
    assert.deepEqual(report.samples.map((sample) => sample.requestedMaxFeatures), [1, 2]);
    assert.deepEqual(report.samples.map((sample) => sample.emittedFeatureCount), [1, 2]);
    for (const sample of report.samples) {
      assert.equal(sample.status, "pass");
      assert.equal(sample.buildIntegrityStatus, "pass");
      assert.equal(sample.integrity.status, "pass");
      assert.equal(sample.alignment.status, "pass");
      assert.ok(sample.packageBytes > 0);
      assert.ok(sample.packageFileCount >= 3);
      assert.ok(sample.glbBytes.min > 0);
      assert.ok(sample.wallTimeMs.buildAndEmbeddedIntegrity >= 0);
      assert.ok(sample.wallTimeMs.standaloneIntegrity >= 0);
      assert.ok(sample.wallTimeMs.alignment >= 0);
      assert.equal(sample.alignment.degenerateTriangleCountMaximumAcrossTiles, 0);
    }
    assert.deepEqual(report.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
    assert.match(report.reportSha256, /^[a-f0-9]{64}$/);
    const saved = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(saved.reportSha256, report.reportSha256);
    assert.equal(saved.status, "pass");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
