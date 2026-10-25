import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("Bangabhaban geometry dimensions and orientation stay explicitly provisional", async () => {
  const p = JSON.parse(await readFile(path.join(root, "data/heritage/bangabhaban.parameters.json"), "utf8"));
  assert.equal(p.id, "bangabhaban-dhaka");
  assert.ok(Object.values(p.provisionalDimensions).every(v => v.confidence === "estimated"));
  assert.match(p.geometryPolicy.sourceAreaPolicy, /Do not use compound area/i);
  assert.match(p.geometryPolicy.dimensions, /not be advertised as measured/i);
  assert.match(p.geometryPolicy.reconstruction, /no photogrammetry is claimed/i);
});
