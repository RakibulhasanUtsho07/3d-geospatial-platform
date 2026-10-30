import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "prepare-source-bound-geometry-review.mjs");

test("documents geometry-review preparation and keeps private signing keys off the server", () => {
  const result = spawnSync(process.execPath, [script, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidate-bound geometry QA report/);
  assert.match(result.stdout, /access a private key/);
  assert.match(result.stdout, /authenticated review API/);
});

test("rejects incomplete geometry-review CLI arguments", () => {
  const result = spawnSync(process.execPath, [script, "workspace", "building-a"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage:/);
});
