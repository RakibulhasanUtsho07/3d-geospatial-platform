import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts/sign-survey-observation-attribution.mjs");

function run(args, env = process.env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

test("survey attribution signing CLI help is local and does not require keys or registry", () => {
  const env = { ...process.env };
  delete env.SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON;
  const result = run(["--help"], env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sign:survey-observation-attribution/);
  assert.match(result.stdout, /SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON/);
  assert.match(result.stdout, /not survey certification/i);
  assert.equal(result.stderr, "");
});

test("survey attribution signing CLI fails closed when the external registry is missing", () => {
  const env = { ...process.env };
  delete env.SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON;
  const privateKeyPath = path.join(ROOT, "not-a-real-private-key.pem");
  const result = run([
    path.join(ROOT, "not-a-real-smoke-workspace"),
    "smoke-job-001",
    privateKeyPath,
    "--surveyor-id",
    "surveyor-001",
  ], env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted-surveyor-registry-secret-missing/);
  assert.doesNotMatch(result.stdout + result.stderr, /BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY/);
  assert.doesNotMatch(result.stdout + result.stderr, /not-a-real-private-key\.pem/);
});

test("survey attribution signing CLI rejects unsafe surveyor IDs before reading credentials", () => {
  const env = { ...process.env };
  delete env.SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON;
  const result = run([
    "workspace",
    "job-001",
    "private.pem",
    "--surveyor-id",
    "../surveyor",
  ], env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /trusted-surveyor-registry-secret-missing/);
});
