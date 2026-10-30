import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/experimental/source-bound-evidence-bundle.html", import.meta.url), "utf8");
const script = await readFile(new URL("../public/experimental/source-bound-evidence-bundle.js", import.meta.url), "utf8");

test("local bundle wizard exposes the four exact source artifacts without a server upload path", () => {
  for (const id of ["source-file", "mask-file", "mask-manifest", "observations"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /files are not uploaded/i);
  assert.doesNotMatch(script, /fetch\s*\(|XMLHttpRequest|sendBeacon/);
});

test("wizard verifies source bytes, mask bytes, manifest bytes and decoded pixel dimensions", () => {
  assert.match(script, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(script, /createImageBitmap\(file\)/);
  assert.match(script, /binary alpha values/);
  assert.match(script, /exact selected source-image bytes/);
  assert.match(script, /Mask PNG bytes, dimensions or encoding do not match/);
});

test("wizard links the exact mask hash into the normalized per-view observation batch", () => {
  assert.match(script, /b\.source\?\.id!==src\.sourceId/);
  assert.match(script, /b\.source\?\.sha256\?\.toLowerCase\(\)!==sourceSha256/);
  assert.match(script, /mask:\{sha256:maskSha256,width:sourceSize\.width,height:sourceSize\.height\}/);
  assert.match(script, /maskAndObservationsShareExactSource:true/);
  assert.match(script, /observationsReferenceExactMask:true/);
});

test("wizard explicitly prevents acceptance, publication and map-ready promotion", () => {
  assert.match(script, /assertFalse\(m\.policy/);
  assert.match(script, /assertFalse\(b\.policy/);
  assert.match(script, /groundTruth:false,acceptanceEligible:false,publicationEligible:false,publishable:false,mapReady:false,automaticApproval:false/);
});
