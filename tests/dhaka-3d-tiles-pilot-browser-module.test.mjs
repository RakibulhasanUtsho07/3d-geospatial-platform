import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDhaka3DTilesPilotBrowserModule } from "../scripts/build-dhaka-3d-tiles-pilot-browser-module.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "p3-6-browser-module-"));
  const source = path.join(root, "src/core/map-engine/dhaka-3d-tiles-pilot-controller.mjs");
  const output = path.join(root, "public/experimental/dhaka-3d-tiles-pilot-controller.mjs");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'export const controllerSource = "authoritative";\n', "utf8");
  return { root, source, output };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("copies the authoritative controller byte-for-byte and reports its hash", async () => {
  const item = await fixture();
  try {
    const result = await buildDhaka3DTilesPilotBrowserModule({ rootDirectory: item.root });
    const sourceBytes = await readFile(item.source);
    const outputBytes = await readFile(item.output);
    assert.deepEqual(outputBytes, sourceBytes);
    assert.equal(result.bytes, sourceBytes.length);
    assert.equal(result.sha256, sha256(sourceBytes));
    assert.equal(result.output, "public/experimental/dhaka-3d-tiles-pilot-controller.mjs");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("refuses a symlink as the authoritative controller source", async () => {
  const item = await fixture();
  try {
    const outside = path.join(item.root, "outside.mjs");
    await writeFile(outside, "export const unsafe = true;\n", "utf8");
    await rm(item.source);
    await symlink(outside, item.source);
    await assert.rejects(
      buildDhaka3DTilesPilotBrowserModule({ rootDirectory: item.root }),
      /regular source file/,
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("refuses to overwrite a symlink at the generated browser module path", async () => {
  const item = await fixture();
  try {
    await mkdir(path.dirname(item.output), { recursive: true });
    const outside = path.join(item.root, "outside-output.mjs");
    await writeFile(outside, "keep this target unchanged\n", "utf8");
    await symlink(outside, item.output);
    await assert.rejects(
      buildDhaka3DTilesPilotBrowserModule({ rootDirectory: item.root }),
      /non-regular asset/,
    );
    const targetInfo = await lstat(outside);
    assert.equal(targetInfo.isSymbolicLink(), false);
    assert.equal(await readFile(outside, "utf8"), "keep this target unchanged\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
