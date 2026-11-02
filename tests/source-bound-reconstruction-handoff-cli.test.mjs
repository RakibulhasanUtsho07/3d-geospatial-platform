import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "prepare-source-bound-reconstruction-handoff.mjs");

test("documents the required hand-off inputs without executing a worker", () => {
  const result = spawnSync(process.execPath, [script, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review-only candidate evidence hand-off/);
  assert.match(result.stdout, /--reconstruction-evidence/);
  assert.match(result.stdout, /never dispatches a worker/);
});

test("rejects an incomplete CLI invocation with usage instead of guessing input paths", () => {
  const result = spawnSync(process.execPath, [script, "workspace", "building-a"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage:/);
});
