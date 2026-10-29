import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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


test("fails closed on malformed source data and invalid profile bounds", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "p3-6-scale-profile-invalid-"));
  try {
    const malformedPath = path.join(temp, "malformed.geojson");
    await writeFile(malformedPath, "{not-json\\n");
    await assert.rejects(
      runDhaka3DTilesScaleProfile({ sourcePath: malformedPath, featureCounts: [1] }),
      SyntaxError,
    );

    const validPath = path.join(temp, "valid.geojson");
    await writeFile(validPath, JSON.stringify(sourceFixture()) + "\\n");
    await assert.rejects(
      runDhaka3DTilesScaleProfile({ sourcePath: validPath, featureCounts: [] }),
      /featureCounts must be a non-empty array/,
    );
    await assert.rejects(
      runDhaka3DTilesScaleProfile({ sourcePath: validPath, featureCounts: [1], syntheticHeightMeters: 0 }),
      /syntheticHeightMeters must be finite/,
    );
    await assert.rejects(
      runDhaka3DTilesScaleProfile({ sourcePath: validPath, featureCounts: [1], toleranceMeters: 6 }),
      /toleranceMeters must be finite/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects source files reached through symlinked parent directories", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "p3-6-scale-profile-symlink-parent-"));
  try {
    const realDirectory = path.join(temp, "real");
    const aliasDirectory = path.join(temp, "alias");
    await mkdir(realDirectory);
    const actualSource = path.join(realDirectory, "source.geojson");
    await writeFile(actualSource, JSON.stringify(sourceFixture()) + "\n");
    await symlink(realDirectory, aliasDirectory, "dir");

    await assert.rejects(
      runDhaka3DTilesScaleProfile({
        sourcePath: path.join(aliasDirectory, "source.geojson"),
        featureCounts: [1],
      }),
      /Source GeoJSON must not traverse symlinked or non-directory parents/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects report outputs reached through symlinked parents or symlink targets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "p3-6-scale-profile-report-symlink-"));
  try {
    const sourcePath = path.join(temp, "source.geojson");
    await writeFile(sourcePath, JSON.stringify(sourceFixture()) + "\n");

    const realDirectory = path.join(temp, "real-output");
    const aliasDirectory = path.join(temp, "alias-output");
    await mkdir(realDirectory);
    await symlink(realDirectory, aliasDirectory, "dir");
    await assert.rejects(
      runDhaka3DTilesScaleProfile({
        sourcePath,
        featureCounts: [1],
        reportPath: path.join(aliasDirectory, "report.json"),
      }),
      /Report output must not traverse symlinked or non-directory parents/,
    );

    const targetPath = path.join(temp, "actual-report.json");
    const aliasTargetPath = path.join(temp, "report-link.json");
    await writeFile(targetPath, "keep-me\n");
    await symlink(targetPath, aliasTargetPath, "file");
    await assert.rejects(
      runDhaka3DTilesScaleProfile({
        sourcePath,
        featureCounts: [1],
        reportPath: aliasTargetPath,
      }),
      /Report target must be a regular file and must not be a symbolic link/,
    );
    assert.equal(await readFile(targetPath, "utf8"), "keep-me\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
