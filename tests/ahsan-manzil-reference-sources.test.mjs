import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = JSON.parse(await readFile(new URL("../data/heritage/ahsan-manzil-reference-sources.json", import.meta.url), "utf8"));

const visualReview = JSON.parse(await readFile(new URL("../data/heritage/ahsan-manzil-visual-review.json", import.meta.url), "utf8"));

test("records the two inspected source/render disagreements and specific correction requests", () => {
  assert.equal(visualReview.schemaVersion, "1.0.0");
  assert.equal(visualReview.buildingId, sources.buildingId);
  assert.equal(visualReview.overallStatus, "needs-model-or-reference-correction");
  assert.equal(visualReview.publicationEligible, false);
  assert.equal(visualReview.humanAcceptance.status, "pending");
  assert.match(visualReview.reviewer, /AI-assisted visual triage/);
  assert.equal(visualReview.comparisons.length, 2);
  for (const assessment of visualReview.comparisons) {
    const source = sources.references.find((item) => item.id === assessment.referenceImageId);
    assert.ok(source, "review must refer to a known, checksum-pinned source photograph");
    assert.equal(assessment.viewId, source.mappedRenderViewId);
    assert.equal(assessment.comparisonBasis, "pose-estimated");
    assert.equal(assessment.outcome, "mismatch");
    assert.ok(assessment.notes.length > 80);
    assert.ok(assessment.correctionRequest.length > 80);
  }
  assert.equal(new Set(visualReview.comparisons.map((item) => item.referenceImageId)).size, 2);
  assert.ok(visualReview.unassessedViews.includes("back"));
  assert.ok(visualReview.limitations.some((item) => item.includes("camera heading/lens") || item.includes("camera")));
});


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
  assert.equal(east.mappedRenderViewId, "turntable-315");
  assert.equal(east.facadeLabel, "southeast-oblique-viewpoint-from-published-camera-location");
  assert.ok(east.mappingConfidence.includes("nearest available fixed azimuth is 315 degrees"));
  assert.equal(front.comparisonBasis, "pose-estimated");
  assert.equal(east.comparisonBasis, "pose-estimated");
  assert.equal(front.captureHeadingDegrees, undefined);
  assert.equal(east.captureHeadingDegrees, undefined);
});
