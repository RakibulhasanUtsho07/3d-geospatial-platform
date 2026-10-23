import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolvePickedEntity } from "../src/core/map-engine/picked-entity-resolution.mjs";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const [adapter] = await Promise.all([readFile(adapterUrl, "utf8")]);

function entity(id) {
  return { kind: "cesium-entity", id };
}

function fixture() {
  const sourceA = entity("building-a");
  const sourceB = entity("building-b");
  const byId = new Map([[sourceA.id, sourceA], [sourceB.id, sourceB]]);
  const isEntity = (value) => Boolean(value && value.kind === "cesium-entity");
  const getById = (id) => byId.get(id);
  return { sourceA, sourceB, isEntity, getById };
}

test("direct Entity pick resolves to the canonical entity in the data source", () => {
  const { sourceA, isEntity, getById } = fixture();
  const detachedPickEntity = entity("building-a");
  assert.notStrictEqual(detachedPickEntity, sourceA);
  assert.strictEqual(
    resolvePickedEntity(detachedPickEntity, isEntity, getById),
    sourceA,
  );
});

test("picked id string resolves to the data-source entity", () => {
  const { sourceB, isEntity, getById } = fixture();
  assert.strictEqual(
    resolvePickedEntity({ id: "building-b" }, isEntity, getById),
    sourceB,
  );
});

test("primitive Entity id resolves to canonical data-source entity", () => {
  const { sourceA, isEntity, getById } = fixture();
  assert.strictEqual(
    resolvePickedEntity({ primitive: { id: entity("building-a") } }, isEntity, getById),
    sourceA,
  );
});

test("primitive string id resolves to canonical data-source entity", () => {
  const { sourceB, isEntity, getById } = fixture();
  assert.strictEqual(
    resolvePickedEntity({ primitive: { id: "building-b" } }, isEntity, getById),
    sourceB,
  );
});

test("an unresolved first candidate falls through to the primitive id", () => {
  const { sourceB, isEntity, getById } = fixture();
  assert.strictEqual(
    resolvePickedEntity(
      { id: "not-in-this-source", primitive: { id: "building-b" } },
      isEntity,
      getById,
    ),
    sourceB,
  );
});

test("invalid picks and ids outside the current data source resolve to null", () => {
  const { isEntity, getById } = fixture();
  for (const picked of [null, undefined, false, 42, "building-a", {}, { id: "missing" }, { primitive: { id: "missing" } }]) {
    assert.strictEqual(resolvePickedEntity(picked, isEntity, getById), null);
  }
});

test("direct Entity pick with no canonical source match does not resolve another candidate", () => {
  const { isEntity } = fixture();
  const direct = entity("removed-building");
  const pickedWithFallback = { id: direct, primitive: { id: "building-a" } };
  assert.strictEqual(resolvePickedEntity(pickedWithFallback, isEntity, () => undefined), null);
});

test("CesiumAdapter delegates pick normalization and keeps data-source ownership", () => {
  assert.match(adapter, /from "\.\/picked-entity-resolution\.mjs"/);
  const start = adapter.indexOf("private getEntityFromPick(");
  const end = adapter.indexOf("\n  onRoadSelected(", start);
  assert.ok(start >= 0 && end > start);
  const wrapper = adapter.slice(start, end);
  assert.match(wrapper, /resolvePickedEntity\(/);
  assert.match(wrapper, /candidate instanceof Cesium\.Entity/);
  assert.match(wrapper, /dataSource\.entities\.getById\(id\)/);
  assert.doesNotMatch(wrapper, /pickedObject\.primitive/);
  assert.doesNotMatch(wrapper, /handler\.setInputAction/);
});
