import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_RENDER_REVIEW_PROFILE,
  validateRenderReviewProfile,
} from "../src/core/building-generation/render-review-profile.mjs";

test("provides a generic whole-model default with no node-name filtering", () => {
  const profile = validateRenderReviewProfile(DEFAULT_RENDER_REVIEW_PROFILE);
  assert.equal(profile.profileId, "generic-whole-model-v1");
  assert.deepEqual(profile.excludeNodeNamePrefixes, []);
  assert.deepEqual(profile.frontView.includeNodeNames, []);
  assert.deepEqual(profile.frontView.excludeNodeNames, []);
  assert.equal(profile.frontView.framingLabel, "whole-model-generic-front");
});

test("accepts an explicit heritage review profile without coupling it to the renderer implementation", async () => {
  const source = await readFile(new URL("../data/heritage/rangmahal-render-review-profile.json", import.meta.url), "utf8");
  const profile = validateRenderReviewProfile(JSON.parse(source));
  assert.equal(profile.profileId, "rangmahal-south-facade-review");
  assert.deepEqual(profile.excludeNodeNamePrefixes, ["Site_"]);
  assert.ok(profile.frontView.includeNodeNames.includes("Dome"));
  assert.ok(profile.frontView.excludeNodeNames.includes("RoofDeck"));
  assert.equal(profile.frontView.elevationDegrees, 5);
});

test("rejects unknown fields, duplicate selectors, wildcard names and invalid elevation", () => {
  assert.throws(() => validateRenderReviewProfile({
    schemaVersion: "1.0.0", profileId: "generic", unexpected: true,
  }), /unsupported render review profile field/);
  assert.throws(() => validateRenderReviewProfile({
    schemaVersion: "1.0.0", profileId: "generic",
    excludeNodeNamePrefixes: ["Site_", "Site_"],
  }), /must not contain duplicates/);
  assert.throws(() => validateRenderReviewProfile({
    schemaVersion: "1.0.0", profileId: "generic",
    frontView: { includeNodeNames: ["Wall*"] },
  }), /without wildcards/);
  assert.throws(() => validateRenderReviewProfile({
    schemaVersion: "1.0.0", profileId: "generic",
    frontView: { elevationDegrees: 90 },
  }), /between 0 and 60/);
});

test("rejects node names listed for both inclusion and exclusion", () => {
  assert.throws(() => validateRenderReviewProfile({
    schemaVersion: "1.0.0", profileId: "generic",
    frontView: { includeNodeNames: ["Facade"], excludeNodeNames: ["Facade"] },
  }), /both included and excluded/);
});
