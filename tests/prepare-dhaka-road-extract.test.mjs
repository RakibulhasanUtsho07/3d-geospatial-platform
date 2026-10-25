import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOfflineRoadExtract } from "../src/core/geospatial/offline-road-extract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/prepare-dhaka-road-extract.mjs");
const sourceUrl = "https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf";
const sourceSha = "b".repeat(64);
const inputData = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature", id: "way/501",
      properties: { osm_id: 501, highway: "primary", name: "Fixture Primary", lanes: 2 },
      geometry: { type: "LineString", coordinates: [[90.405, 23.710], [90.415, 23.720]] },
    },
    {
      type: "Feature", id: "way/502",
      properties: { osm_id: 502, highway: "footway", name: null },
      geometry: { type: "LineString", coordinates: [[90.410, 23.712], [90.412, 23.714]] },
    },
  ],
};

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
}

test("prepares and reloads an offline extract with the upstream PBF hash and transformed-input hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prepare-dhaka-roads-"));
  const inputPath = path.join(directory, "roads.geojson");
  const outputPath = path.join(directory, "roads.normalized.json");
  try {
    const input = JSON.stringify(inputData);
    await writeFile(inputPath, input);
    const inputHash = createHash("sha256").update(input).digest("hex");
    const run = runCli([
      "--input", inputPath,
      "--output", outputPath,
      "--source-url", sourceUrl,
      "--source-date", "2026-09-19",
      "--source-sha256", sourceSha,
      "--west", "90.30", "--south", "23.60", "--east", "90.55", "--north", "23.90",
    ]);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "prepared");
    assert.equal(report.sourceSha256, sourceSha);
    assert.equal(report.normalizationInputSha256, inputHash);
    const extract = await loadOfflineRoadExtract(outputPath);
    assert.equal(extract.source.sourceSha256, sourceSha);
    assert.equal(extract.source.normalizationInputSha256, inputHash);
    assert.equal(extract.featureCount, 2);
    assert.equal(extract.source.license, "ODbL 1.0");
    assert.match(extract.source.attribution, /OpenStreetMap contributors/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid source SHA, non-HTTPS URLs, missing metadata, and invalid dates", () => {
  const base = ["--input", "unused.geojson", "--source-url", sourceUrl, "--source-date", "2026-09-19"];
  assert.match(runCli([...base, "--source-sha256", "not-a-hash"]).stderr, /source-sha256/);
  assert.match(runCli(["--input", "unused.geojson", "--source-url", "http://unsafe.invalid/roads", "--source-date", "2026-09-19"]).stderr, /HTTPS/);
  assert.match(runCli(["--input", "unused.geojson", "--source-url", sourceUrl]).stderr, /required/);
  assert.match(runCli(["--input", "unused.geojson", "--source-url", sourceUrl, "--source-date", "2026-02-30"]).stderr, /real YYYY-MM-DD/);
});

test("rejects unsupported input geometry and zero supported road features", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prepare-dhaka-roads-invalid-"));
  const inputPath = path.join(directory, "no-roads.geojson");
  const outputPath = path.join(directory, "roads.json");
  try {
    await writeFile(inputPath, JSON.stringify({ type: "FeatureCollection", features: [] }));
    const run = runCli([
      "--input", inputPath, "--output", outputPath,
      "--source-url", sourceUrl, "--source-date", "2026-09-19",
    ]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /No supported road features/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
