import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTrustRegistryGovernanceProviderConformance } from "./helpers/trust-registry-governance-provider-conformance.mjs";
import {
  createProcessIsolatedTrustRegistryGovernanceProvider,
  createProviderProcessMetrics,
} from "../src/core/building-generation/trust-registry-governance-provider-process-isolation.mjs";

const fixtureModule = fileURLToPath(new URL("./fixtures/trust-registry-governance-file-backed-provider.mjs", import.meta.url));
const runnerScript = fileURLToPath(new URL("../scripts/run-trust-registry-governance-provider-process-conformance.mjs", import.meta.url));

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "d3m26-provider-process-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("process-isolated adapter passes the full D3M-24 suite across fresh OS processes", async () => {
  await withTempDirectory(async (directory) => {
    const previous = process.env.D3M26_TEST_PROVIDER_STATE_FILE;
    process.env.D3M26_TEST_PROVIDER_STATE_FILE = path.join(directory, "provider-state.json");
    const metrics = createProviderProcessMetrics();
    try {
      const createProvider = () => createProcessIsolatedTrustRegistryGovernanceProvider({
        modulePath: fixtureModule,
        timeoutMs: 15000,
        allowedEnvironmentKeys: ["D3M26_TEST_PROVIDER_STATE_FILE"],
        metrics,
      });
      const provider = await createProvider();
      assert.equal(provider.providerId, "d3m26-file-backed-test-provider");
      assert.equal(provider.adapterDeclaredSyntheticOnly, true);
      const report = await runTrustRegistryGovernanceProviderConformance({
        provider,
        reopenProvider: createProvider,
      });
      assert.equal(report.initializeWinners, 1);
      assert.equal(report.casWinners, 1);
      assert.equal(report.freshProviderReopened, true);
      assert.equal(report.freshReadMatched, true);
      assert.equal(report.ambiguousCommitRecovered, true);
      assert.equal(report.preCommitTimeoutSafeRetry, true);
      assert.equal(report.ambiguousCompetingWinnerDetected, true);
      assert.equal(report.identityIsolationVerified, true);
      assert.equal(report.finalRevision, 4);
      assert.equal(report.finalMinimumAcceptedSequence, 9);
      assert.ok(metrics.workerProcessesStarted > 30,
        "the provider suite must execute many operations in separate child processes");
      assert.equal(metrics.workerInstanceIds.size, metrics.workerProcessesStarted,
        "every worker operation must have a distinct process-instance nonce");
      assert.ok(metrics.workerProcessIds.size > 1,
        "concurrent provider operations must execute in multiple OS processes");
    } finally {
      if (previous === undefined) delete process.env.D3M26_TEST_PROVIDER_STATE_FILE;
      else process.env.D3M26_TEST_PROVIDER_STATE_FILE = previous;
    }
  });
});

test("provider process isolation rejects adapter module symlinks", async () => {
  await withTempDirectory(async (directory) => {
    const alias = path.join(directory, "provider-adapter.mjs");
    await symlink(fixtureModule, alias);
    await assert.rejects(
      createProcessIsolatedTrustRegistryGovernanceProvider({ modulePath: alias }),
      /symbolic links/i,
    );
  });
});

test("provider process isolation rejects an adapter without createProvider", async () => {
  await withTempDirectory(async (directory) => {
    const adapter = path.join(directory, "invalid-provider.mjs");
    await writeFile(adapter, "export const syntheticOnly = true;\n", { mode: 0o600 });
    await assert.rejects(
      createProcessIsolatedTrustRegistryGovernanceProvider({ modulePath: adapter }),
      /D3M26_ADAPTER_CREATE_PROVIDER_REQUIRED/,
    );
  });
});

test("provider worker timeout terminates a hung child process", async () => {
  await withTempDirectory(async (directory) => {
    const adapter = path.join(directory, "hanging-provider.mjs");
    const source = [
      "export const syntheticOnly = true;",
      "export async function createProvider() {",
      "  return {",
      "    providerId: 'd3m26-hanging-provider',",
      "    readState: async () => new Promise(() => {}),",
      "    initializeStateIfAbsent: async () => { throw new Error('unused'); },",
      "    compareAndSetState: async () => { throw new Error('unused'); },",
      "  };",
      "}",
      "",
    ].join("\n");
    await writeFile(adapter, source, { mode: 0o600 });
    const provider = await createProcessIsolatedTrustRegistryGovernanceProvider({
      modulePath: adapter,
      timeoutMs: 250,
    });
    await assert.rejects(provider.readState({
      registrySetId: "d3m26-timeout-test",
      governanceKeyFingerprintSha256: "a".repeat(64),
    }), /timed out/i);
  });
});

test("provider worker bounds serialized response size", async () => {
  await withTempDirectory(async (directory) => {
    const adapter = path.join(directory, "oversized-provider.mjs");
    const source = [
      "export const syntheticOnly = true;",
      "export async function createProvider() {",
      "  return {",
      "    providerId: 'd3m26-oversized-provider',",
      "    readState: async () => 'x'.repeat(950 * 1024),",
      "    initializeStateIfAbsent: async () => null,",
      "    compareAndSetState: async () => null,",
      "  };",
      "}",
      "",
    ].join("\n");
    await writeFile(adapter, source, { mode: 0o600 });
    const provider = await createProcessIsolatedTrustRegistryGovernanceProvider({
      modulePath: adapter,
    });
    await assert.rejects(provider.readState({
      registrySetId: "d3m26-size-test",
      governanceKeyFingerprintSha256: "b".repeat(64),
    }), /D3M26_WORKER_RESPONSE_TOO_LARGE/);
  });
});

test("provider worker does not disclose adapter exception messages", async () => {
  await withTempDirectory(async (directory) => {
    const adapter = path.join(directory, "throwing-provider.mjs");
    const source = [
      "export const syntheticOnly = true;",
      "export async function createProvider() {",
      "  return {",
      "    providerId: 'd3m26-throwing-provider',",
      "    readState: async () => { throw new Error('TOP_SECRET_PROVIDER_TOKEN_123'); },",
      "    initializeStateIfAbsent: async () => null,",
      "    compareAndSetState: async () => null,",
      "  };",
      "}",
      "",
    ].join("\n");
    await writeFile(adapter, source, { mode: 0o600 });
    const provider = await createProcessIsolatedTrustRegistryGovernanceProvider({
      modulePath: adapter,
    });
    await assert.rejects(provider.readState({
      registrySetId: "d3m26-error-test",
      governanceKeyFingerprintSha256: "c".repeat(64),
    }), (error) => {
      assert.match(error.message, /D3M26_PROVIDER_OPERATION_FAILED/);
      assert.doesNotMatch(error.message, /TOP_SECRET_PROVIDER_TOKEN_123/);
      return true;
    });
  });
});

test("provider worker environment allowlist rejects runtime injection variables", async () => {
  await assert.rejects(
    createProcessIsolatedTrustRegistryGovernanceProvider({
      modulePath: fixtureModule,
      allowedEnvironmentKeys: ["NODE_OPTIONS"],
    }),
    /unsafe variable name/i,
  );
});

test("provider process runner help explains the explicit adapter contract", () => {
  const result = spawnSync(process.execPath, [runnerScript, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--provider-module FILE/);
  assert.match(result.stdout, /--allow-env NAME/);
  assert.match(result.stdout, /Never pass secrets as command-line values/i);
});
