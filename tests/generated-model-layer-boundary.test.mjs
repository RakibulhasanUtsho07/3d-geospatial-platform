import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const adapterPath = path.join(root, "src/core/map-engine/cesium-adapter.ts");
const layerPath = path.join(root, "src/core/map-engine/generated-model-layer.ts");

test("CesiumAdapter delegates generated-model lifecycle to GeneratedModelLayer", async () => {
  const source = await readFile(adapterPath, "utf8");
  assert.match(source, /import\s+\{\s*GeneratedModelLayer\s*\}\s+from\s+["']\.\/generated-model-layer["']/);
  assert.match(source, /private readonly generatedModelLayer\s*=\s*new GeneratedModelLayer/);
  assert.match(source, /async addGeneratedModel\(definition: GeneratedModelDefinition\): Promise<void>\s*\{\s*return this\.generatedModelLayer\.add\(definition\);/);
  assert.match(source, /async updateGeneratedModel\(id: string, patch: GeneratedModelUpdate\): Promise<void>\s*\{\s*return this\.generatedModelLayer\.update\(id, patch\);/);
  assert.match(source, /setGeneratedModelVisibility\(id: string, visible: boolean\): boolean\s*\{\s*return this\.generatedModelLayer\.setVisibility\(id, visible\);/);
  assert.match(source, /removeGeneratedModel\(id: string\): boolean\s*\{\s*return this\.generatedModelLayer\.remove\(id\);/);
  assert.match(source, /getGeneratedModelIds\(\): string\[\]\s*\{\s*return this\.generatedModelLayer\.getIds\(\);/);
  assert.doesNotMatch(source, /private readonly generatedModels\s*=\s*new Map/);
  assert.doesNotMatch(source, /this\.generatedModels/);
});

test("GeneratedModelLayer retains race protection, URL policy, and staged replacement semantics", async () => {
  const source = await readFile(layerPath, "utf8");
  assert.match(source, /normalizeGeneratedModelDefinition/);
  assert.match(source, /this\.getViewer\(\)\s*!==\s*viewer/);
  assert.match(source, /this\.records\.get\(normalized\.id\)\s*!==\s*record/);
  assert.match(source, /record\.revision\s*!==\s*revision/);
  assert.match(source, /Stage a replacement asset before removing the old model primitive/);
  assert.match(source, /const previous = record\.model/);
  assert.match(source, /this\.records\.clear\(\)/);
});
