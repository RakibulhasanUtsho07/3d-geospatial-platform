import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pack = JSON.parse(await readFile(new URL("../data/heritage/bangabhaban-reference-pack.json", import.meta.url), "utf8"));

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
