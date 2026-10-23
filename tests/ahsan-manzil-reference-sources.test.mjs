import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = JSON.parse(await readFile(new URL("../data/heritage/ahsan-manzil-reference-sources.json", import.meta.url), "utf8"));

test("pins two Ahsan Manzil photographs with auditable source, attribution and source-byte hash", () => {
  assert.equal(sources.schemaVersion, "1.0.0");
  assert.equal(sources.buildingId, "ahsan-manzil-kumartuli-dhaka");
  assert.equal(sources.modelCoordinateConvention, "Y-up; +X east; +Z south / riverfront");
  assert.equal(sources.references.length, 2);
  for (const reference of sources.references) {
    assert.match(reference.expectedSha1, /^[a-f0-9]{40}$/);
    assert.ok(reference.expectedBytes > 10000);
    assert.ok(reference.expectedWidth >= 1000 && reference.expectedHeight >= 700);
    assert.equal(reference.license, "CC BY-SA 4.0");
    assert.equal(reference.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
    assert.ok(reference.sourcePageUrl.startsWith("https://commons.wikimedia.org/wiki/File:"));
    assert.ok(reference.attribution.includes(reference.author));
    assert.ok(reference.attribution.includes(reference.license));
    assert.equal(reference.captureHeadingBasis, "unknown");
  }
});

test("maps the photographed south-front and east-side viewpoints to Y-up render views without claiming calibrated camera poses", () => {
  const front = sources.references.find((reference) => reference.id === "ahsan-manzil-front-mahosha-2012");
  const east = sources.references.find((reference) => reference.id === "ahsan-manzil-east-side-parvezahmed-2019");
  assert.equal(front.mappedRenderViewId, "front");
  assert.equal(front.facadeLabel, "south-riverfront-front-facade");
  assert.equal(east.mappedRenderViewId, "right");
  assert.equal(east.facadeLabel, "east-side-facade-viewpoint-east-of-site");
  assert.equal(front.comparisonBasis, "pose-estimated");
  assert.equal(east.comparisonBasis, "pose-estimated");
  assert.equal(front.captureHeadingDegrees, undefined);
  assert.equal(east.captureHeadingDegrees, undefined);
});
