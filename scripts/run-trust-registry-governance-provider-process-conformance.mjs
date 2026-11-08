import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { runTrustRegistryGovernanceProviderConformance } from "../tests/helpers/trust-registry-governance-provider-conformance.mjs";
import {
  createProcessIsolatedTrustRegistryGovernanceProvider,
  createProviderProcessMetrics,
} from "../src/core/building-generation/trust-registry-governance-provider-process-isolation.mjs";

function usage() {
  return [
    "Usage: node scripts/run-trust-registry-governance-provider-process-conformance.mjs --provider-module FILE [options]",
    "",
    "Options:",
    "  --provider-module FILE   Trusted adapter module exporting createProvider()",
    "  --allow-env NAME         Allow one environment variable into worker processes (repeatable)",
    "  --timeout-ms NUMBER      Per-operation worker timeout (100..120000; default 15000)",
    "  --source-sha SHA         Bind report to a 40-character source commit",
    "  --provider-instance-fingerprint-sha256 SHA256   Bind report to a privacy-safe provider instance fingerprint",
    "  --provider-namespace-fingerprint-sha256 SHA256  Bind report to an isolated namespace fingerprint",
    "  --report FILE            Write a sanitized, create-once JSON report",
    "  --help                   Show this help",
    "",
    "The adapter module executes with the explicitly allowlisted environment. Never pass secrets as command-line values.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { allowedEnvironmentKeys: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--provider-module" || arg === "--timeout-ms" ||
        arg === "--source-sha" || arg === "--report" || arg === "--allow-env" ||
        arg === "--provider-instance-fingerprint-sha256" ||
        arg === "--provider-namespace-fingerprint-sha256") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg + ".");
      index += 1;
      if (arg === "--provider-module") result.modulePath = value;
      else if (arg === "--timeout-ms") result.timeoutMs = Number(value);
      else if (arg === "--source-sha") result.sourceSha = value;
      else if (arg === "--report") result.reportPath = value;
      else if (arg === "--provider-instance-fingerprint-sha256") result.providerInstanceFingerprintSha256 = value;
      else if (arg === "--provider-namespace-fingerprint-sha256") result.providerNamespaceFingerprintSha256 = value;
      else result.allowedEnvironmentKeys.push(value);
    } else {
      throw new Error("Unknown option: " + arg + ".");
    }
  }
  if (!result.modulePath) throw new Error("--provider-module is required.");
  if (!result.sourceSha) throw new Error("--source-sha is required so the report cannot guess provenance.");
  if (!/^[a-f0-9]{40}$/.test(result.sourceSha)) {
    throw new Error("--source-sha must be a 40-character lowercase commit SHA.");
  }
  const hasInstanceFingerprint = Boolean(result.providerInstanceFingerprintSha256);
  const hasNamespaceFingerprint = Boolean(result.providerNamespaceFingerprintSha256);
  if (hasInstanceFingerprint !== hasNamespaceFingerprint) {
    throw new Error("Provider instance and namespace fingerprints must be supplied together.");
  }
  for (const [label, value] of [
    ["provider instance", result.providerInstanceFingerprintSha256],
    ["provider namespace", result.providerNamespaceFingerprintSha256],
  ]) {
    if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error("The " + label + " fingerprint must be a 64-character lowercase SHA-256 digest.");
    }
  }
  return result;
}

async function assertNoSymlinkParents(absolutePath) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new Error("Report path must not contain symbolic links.");
  }
}

async function validateReportTarget(reportPath) {
  const absolutePath = path.resolve(reportPath);
  await assertNoSymlinkParents(path.dirname(absolutePath));
  const parent = await realpath(path.dirname(absolutePath));
  if (parent !== path.dirname(absolutePath)) throw new Error("Report directory must use its canonical path.");
  try {
    await lstat(absolutePath);
    throw new Error("Report file already exists; reports are write-once.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return absolutePath;
}

async function writeReportOnce(reportPath, report) {
  const absolutePath = await validateReportTarget(reportPath);
  const handle = await open(absolutePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600);
  try {
    await handle.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const sourceSha = options.sourceSha;
  if (options.reportPath) await validateReportTarget(options.reportPath);
  const metrics = createProviderProcessMetrics();
  const makeProvider = () => createProcessIsolatedTrustRegistryGovernanceProvider({
    modulePath: options.modulePath,
    timeoutMs: options.timeoutMs,
    allowedEnvironmentKeys: options.allowedEnvironmentKeys,
    metrics,
  });
  const provider = await makeProvider();
  if (typeof provider.adapterDeclaredSyntheticOnly !== "boolean") {
    throw new Error("Provider adapter must explicitly declare syntheticOnly as true or false for the D3M-27 report.");
  }
  if (provider.adapterDeclaredSyntheticOnly === false &&
      (!options.providerInstanceFingerprintSha256 || !options.providerNamespaceFingerprintSha256)) {
    throw new Error("A non-synthetic provider report requires both provider instance and namespace fingerprints.");
  }
  const suite = await runTrustRegistryGovernanceProviderConformance({
    provider,
    reopenProvider: makeProvider,
  });
  const stats = provider.processStats;
  if (stats.workerProcessesStarted < 30 ||
      stats.uniqueWorkerInstances !== stats.workerProcessesStarted ||
      stats.uniqueWorkerProcessIds < 2 ||
      stats.uniqueWorkerProcessIds > stats.workerProcessesStarted) {
    throw new Error("Provider process isolation did not meet the minimum distinct-worker and OS-process evidence threshold.");
  }
  const report = {
    schemaVersion: "1.1.0",
    sourceCommitSha: sourceSha,
    providerId: provider.providerId,
    adapterModuleSha256: provider.adapterModuleSha256,
    adapterDeclaredSyntheticOnly: provider.adapterDeclaredSyntheticOnly,
    providerInstanceFingerprintSha256: options.providerInstanceFingerprintSha256 ?? null,
    providerNamespaceFingerprintSha256: options.providerNamespaceFingerprintSha256 ?? null,
    executionMode: "fresh-node-child-process-per-provider-operation",
    processIsolationVerified: true,
    workerProcessesStarted: stats.workerProcessesStarted,
    uniqueWorkerInstances: stats.uniqueWorkerInstances,
    uniqueWorkerProcessIds: stats.uniqueWorkerProcessIds,
    conformance: suite,
    trustBoundary: "Software conformance only. Adapter declarations are not independently authenticated. This report does not prove provider deployment, independent anchor custody, rollback resistance, security controls or production durability.",
  };
  if (options.reportPath) await writeReportOnce(options.reportPath, report);
  process.stdout.write(JSON.stringify({
    status: "passed",
    providerId: report.providerId,
    adapterModuleSha256: report.adapterModuleSha256,
    executionMode: report.executionMode,
    workerProcessesStarted: report.workerProcessesStarted,
    uniqueWorkerInstances: report.uniqueWorkerInstances,
    sourceCommitSha: report.sourceCommitSha,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write((error?.message || "Provider conformance runner failed.") + "\n");
  process.exitCode = 1;
});
