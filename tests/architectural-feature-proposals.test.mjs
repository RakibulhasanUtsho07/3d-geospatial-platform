import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArchitecturalFeatureOverlaySvg, evaluateArchitecturalFeatureProposals,
  proposeArchitecturalFeatures,
} from "../src/core/building-generation/architectural-feature-proposals.mjs";

const hash = (n) => n.toString(16).padStart(64, "0");
function fixture(withEdges = true) {
  const width = 20, height = 20;
  const pixels = new Uint8Array(width * height);
  for (let y = 2; y <= 17; y += 1) for (let x = 3; x <= 16; x += 1) pixels[y * width + x] = 255;
  const edges = new Uint8Array(width * height);
  if (withEdges) {
    for (const y of [10]) for (let x = 3; x <= 16; x += 1) edges[y * width + x] = 255;
    for (const [x1,y1,x2,y2] of [[6,5,8,7],[11,5,13,7],[7,12,10,17]]) {
      for (let x=x1; x<=x2; x+=1) { edges[y1*width+x]=255; edges[y2*width+x]=255; }
      for (let y=y1; y<=y2; y+=1) { edges[y*width+x1]=255; edges[y*width+x2]=255; }
    }
  }
  return {
    buildingId: "building-a", viewId: "front", generatedAt: "2026-10-26T10:00:00Z",
    source: { id: "capture-front", sha256: hash(1), width, height },
    mask: { sha256: hash(2), width, height, pixels },
    edgeMap: withEdges ? { sha256: hash(3), width, height, pixels: edges } : null,
  };
}
const run = (input, generatedAt = "2026-10-26T10:00:00Z") => proposeArchitecturalFeatures({
  ...input, generatedAt, options: { edgeThreshold: 160, horizontalBandDensityThreshold: 0.58 },
});

test("proposes deterministic source-bound silhouette, roofline, corner and opening cues", () => {
  const input = fixture(true);
  const first = run(input);
  const second = run(input);
  assert.equal(first.status, "proposal-review-required");
  assert.equal(first.publishable, false);
  assert.deepEqual(first.observations, second.observations);
  assert.ok(first.observations.some((x) => x.category === "silhouette-bounds"));
  assert.ok(first.observations.some((x) => x.category === "roofline-segment"));
  assert.equal(first.observations.filter((x) => x.category === "outer-corner").length, 4);
  assert.ok(first.observations.some((x) => x.category === "floor-band" && x.visibility === "visible"));
  assert.ok(first.observations.some((x) => x.category === "window-candidate" && x.geometry));
  assert.ok(first.observations.some((x) => x.category === "door-candidate" && x.geometry));
  assert.ok(first.observations.every((x) => x.sourceSha256 === input.source.sha256 && x.evidence.maskSha256 === input.mask.sha256));
});

test("marks incomplete edge evidence and no-foreground masks without inventing geometry", () => {
  const noEdges = run(fixture(false));
  assert.equal(noEdges.status, "incomplete");
  assert.ok(noEdges.warnings.some((warning) => warning.includes("No same-resolution edge map")));
  assert.ok(noEdges.observations.some((x) => x.category === "window-candidate" && x.visibility === "not-detected"));

  const empty = fixture(true);
  empty.mask.pixels.fill(0);
  const none = run(empty);
  assert.equal(none.status, "incomplete");
  assert.equal(none.observations.length, 0);
  assert.equal(none.maskStatistics.boundingBox, null);
});

test("rejects stale hashes, mismatched raster sizes, non-binary masks and unbounded image work", () => {
  const stale = fixture();
  stale.edgeMap.sha256 = "stale";
  assert.throws(() => run(stale), /edgeMap SHA-256/);
  const wrongSize = fixture();
  wrongSize.edgeMap.width = 19;
  assert.throws(() => run(wrongSize), /exact source dimensions/);
  const nonBinary = fixture();
  nonBinary.mask.pixels[0] = 127;
  assert.throws(() => run(nonBinary), /not binary/);
  const huge = fixture();
  huge.source.width = 10000;
  huge.source.height = 10000;
  assert.throws(() => run(huge), /8,000,000-pixel/);
});

test("creates a review overlay and reports category precision/recall against human-reviewed features", () => {
  const input = fixture();
  const report = run(input);
  const svg = buildArchitecturalFeatureOverlaySvg(report);
  assert.match(svg, /<svg/);
  assert.match(svg, /roofline-envelope/);
  const roof = report.observations.find((x) => x.category === "roofline-segment");
  const reviewed = { ...roof, status: "reviewed", reviewedBy: "architect-a", reviewedAt: "2026-10-26T12:00:00Z" };
  const metrics = evaluateArchitecturalFeatureProposals({ predicted: [roof], reviewed: [reviewed],
    sourceSha256: input.source.sha256, viewId: "front" });
  const row = metrics.metrics.find((x) => x.category === "roofline-segment");
  assert.equal(row.tp, 1);
  assert.equal(row.fp, 0);
  assert.equal(row.fn, 0);
  assert.equal(row.precision, 1);
  assert.equal(row.recall, 1);
  assert.equal(metrics.acceptanceEligible, false);
});

test("refuses feature accuracy scoring without reviewed ground truth and source/view agreement", () => {
  const input = fixture();
  const report = run(input);
  const empty = evaluateArchitecturalFeatureProposals({ predicted: report.observations, reviewed: [],
    sourceSha256: input.source.sha256, viewId: "front" });
  assert.equal(empty.status, "incomplete");
  assert.equal(empty.acceptanceEligible, false);
  assert.throws(() => evaluateArchitecturalFeatureProposals({ predicted: [], reviewed: [], sourceSha256: "bad", viewId: "front" }), /required/);
});
