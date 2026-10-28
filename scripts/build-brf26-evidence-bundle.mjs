#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessBrf26EvidenceBundle, BRF26_REQUIRED_ARTIFACT_KEYS } from "../src/core/building-generation/brf26-evidence-bundle.mjs";

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe project-relative path.");
  }
  return value;
}
function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
async function readSafe(root, relative, label, jsonRequired = true) {
  const safe = safeRelative(relative, label);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!within(root, resolved)) throw new TypeError(label + " resolves outside project root.");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symbolic links.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  const bytes = await readFile(resolved);
  const item = { path: safe, expectedSha256: null, actualSha256: digest(bytes), byteSize: bytes.byteLength, bytes, jsonRequired };
  if (jsonRequired) {
    try { item.value = JSON.parse(bytes.toString("utf8")); }
    catch (error) { item.parseError = error instanceof Error ? error.message : String(error); }
  }
  return item;
}
async function readArtifact(root, entry, key) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string") {
    return { path: null, expectedSha256: null, actualSha256: null, byteSize: null,
      jsonRequired: key !== "candidateGlb", error: "No safe artifact path was supplied.", errorKind: "missing" };
  }
  try {
    const item = await readSafe(root, entry.path, key, key !== "candidateGlb");
    item.expectedSha256 = entry.sha256 ?? null;
    return item;
  } catch (error) {
    return { path: entry.path, expectedSha256: entry.sha256 ?? null, actualSha256: null, byteSize: null,
      jsonRequired: key !== "candidateGlb", error: error instanceof Error ? error.message : String(error),
      errorKind: error?.code === "ENOENT" ? "missing" : "unsafe" };
  }
}
function pngDimensions(bytes, label) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new TypeError(label + " must be a PNG with an IHDR header.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new TypeError(label + " has invalid PNG dimensions.");
  return { width, height };
}
async function verifySiblingPng(root, reportPath, filename, expectedSha256, expectedBytes, expectedWidth, expectedHeight, label) {
  const verification = {
    path: null, expectedSha256: expectedSha256 ?? null, actualSha256: null,
    expectedByteSize: expectedBytes ?? null, actualByteSize: null,
    expectedWidth: expectedWidth ?? null, expectedHeight: expectedHeight ?? null,
    actualWidth: null, actualHeight: null, verified: false,
  };
  try {
    const safeName = safeRelative(filename, label + " filename");
    if (safeName.includes("/")) throw new TypeError(label + " filename must be a basename beside its report.");
    const relative = path.posix.join(path.posix.dirname(reportPath), safeName);
    const image = await readSafe(root, relative, label + " PNG", false);
    const dimensions = pngDimensions(image.bytes, label);
    Object.assign(verification, {
      path: image.path, actualSha256: image.sha256, actualByteSize: image.byteSize,
      actualWidth: dimensions.width, actualHeight: dimensions.height,
    });
    verification.verified =
      typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/i.test(expectedSha256) &&
      expectedSha256.toLowerCase() === image.sha256.toLowerCase() &&
      Number.isSafeInteger(expectedBytes) && expectedBytes === image.byteSize &&
      Number.isSafeInteger(expectedWidth) && expectedWidth === dimensions.width &&
      Number.isSafeInteger(expectedHeight) && expectedHeight === dimensions.height;
    if (!verification.verified) verification.error = "Rendered PNG bytes, SHA-256, byte size, or dimensions do not match the pinned report.";
  } catch (error) {
    verification.error = error instanceof Error ? error.message : String(error);
  }
  return verification;
}
async function verifyVisualImageBindings(root, artifacts) {
  const cameraItem = artifacts.sourceCameraReport;
  if (!cameraItem?.error && !cameraItem?.parseError && cameraItem?.value && typeof cameraItem.value === "object") {
    const report = cameraItem.value;
    const render = report.render;
    report._brf26RenderImageVerification = render && typeof render === "object"
      ? await verifySiblingPng(root, cameraItem.path, render.filename, render.sha256, render.bytes,
          render.width, render.height, "Source-camera render")
      : { verified: false, error: "Source-camera report has no rendered PNG record." };
  }
  const renderItem = artifacts.renderManifest;
  if (!renderItem?.error && !renderItem?.parseError && renderItem?.value && typeof renderItem.value === "object") {
    const report = renderItem.value;
    const views = Array.isArray(report.views) ? report.views :
      Array.isArray(report.manifest?.views) ? report.manifest.views : null;
    if (views) {
      for (const view of views) {
        if (!view || typeof view !== "object" || Array.isArray(view)) continue;
        view._brf26ImageVerification = await verifySiblingPng(root, renderItem.path, view.filename,
          view.sha256, view.bytes, view.width, view.height, "Fixed-camera view " + (view.id ?? view.viewId ?? "unknown"));
      }
    }
  }
}
async function safeOutput(root, relative) {
  const safe = safeRelative(relative, "Output report");
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!within(root, resolved)) throw new TypeError("Output report must be inside project root.");
  let current = root;
  for (const part of safe.split("/").slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Output parent must be a non-symlink directory.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  try {
    await lstat(resolved);
    throw new TypeError("Refusing to overwrite an existing BRF-26 output report.");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return resolved;
}
function usage() {
  console.log("Usage: node scripts/build-brf26-evidence-bundle.mjs <bundle-manifest.json> <output-report.json> [--root=project-root] [--workspace=workspace-root]\nChecks hash-bound source review, BRF-24 authorization, exact candidate GLB, BRF-25 extraction/evaluation, independent reference and source-camera visual review. Output is review-readiness only and never enables publication.");
}
async function main() {
  const argv = process.argv.slice(2);
  if (process.argv.includes("--help")) { usage(); return; }
  const rootFlag = argv.find((arg) => arg.startsWith("--root="));
  const workspaceFlag = argv.find((arg) => arg.startsWith("--workspace="));
  const positional = argv.filter((arg) => !arg.startsWith("--root=") && !arg.startsWith("--workspace="));
  if (positional.length !== 2) { usage(); process.exitCode = 2; return; }
  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const manifestFile = await readSafe(root, positional[0], "Bundle manifest");
  if (manifestFile.parseError || !manifestFile.value || typeof manifestFile.value !== "object" || Array.isArray(manifestFile.value)) {
    throw new TypeError("Bundle manifest must be valid JSON containing an object.");
  }
  const manifest = manifestFile.value;
  const artifacts = {};
  await Promise.all(BRF26_REQUIRED_ARTIFACT_KEYS.map(async (key) => {
    artifacts[key] = await readArtifact(root, manifest.artifacts?.[key], key);
  }));
  await verifyVisualImageBindings(root, artifacts);

  let candidatePathBindingValid = false;
  const auth = artifacts.authorizationRecord;
  const candidate = artifacts.candidateGlb;
  const rawWorkspace = workspaceFlag ? workspaceFlag.slice("--workspace=".length) : manifest.workspaceRoot;
  try {
    const workspaceRelative = safeRelative(rawWorkspace, "Workspace root");
    const workspaceRoot = path.resolve(root, ...workspaceRelative.split("/"));
    if (!within(root, workspaceRoot)) throw new TypeError("Workspace root must remain inside project root.");
    const workspaceReal = await realpath(workspaceRoot);
    if (!within(root, workspaceReal)) throw new TypeError("Workspace resolves outside project root.");
    if (auth.value?.candidateGlb?.relativePath && candidate.path) {
      const authorizedRelative = safeRelative(auth.value.candidateGlb.relativePath, "Authorized candidate path");
      const authorizedAbsolute = path.resolve(workspaceReal, ...authorizedRelative.split("/"));
      const declaredCandidateAbsolute = path.resolve(root, ...candidate.path.split("/"));
      candidatePathBindingValid = within(workspaceReal, authorizedAbsolute) && authorizedAbsolute === declaredCandidateAbsolute;
    }
  } catch {
    candidatePathBindingValid = false;
  }

  const report = assessBrf26EvidenceBundle({
    manifest, artifacts, candidatePathBindingValid,
    manifestPath: manifestFile.path, manifestSha256: manifestFile.actualSha256,
  });
  report.manifest = { path: manifestFile.path, sha256: manifestFile.actualSha256 };
  const outputPath = await safeOutput(root, positional[1]);
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    reportPath: path.relative(root, outputPath).split(path.sep).join("/"),
    status: report.status,
    passedChecks: report.checks.filter((item) => item.status === "passed").length,
    blockers: report.blockers.length,
    failures: report.failures.length,
    acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false,
  }, null, 2));
  process.exitCode = report.status === "VALIDATION_FAILED" ? 1 :
    report.status === "READY_FOR_HUMAN_SIGNOFF" ? 0 : 2;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
