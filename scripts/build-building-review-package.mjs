#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";
import { buildBuildingReviewPackageManifest } from "../src/core/building-generation/building-review-package.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const semanticDigest = (value) => sha256(Buffer.from(JSON.stringify(value)));
const safeImageName = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g)$/i.test(value) &&
  !value.includes("..") && !value.includes("/") && !value.includes("\\");
const safePngName = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
  !value.includes("..") && !value.includes("/") && !value.includes("\\");

async function readRegularFile(filePath, label) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(label + " must be a regular file, not a symlink");
  const bytes = await readFile(filePath);
  if (bytes.length < 1) throw new Error(label + " must not be empty");
  return bytes;
}

async function readImageArtifact(filePath, label) {
  const bytes = await readRegularFile(filePath, label);
  const dimensions = readImageDimensions(bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error(label + " is not a readable PNG/JPEG image");
  return { bytes, sha256: sha256(bytes), width: dimensions.width, height: dimensions.height };
}

function addArtifact(artifacts, copyOperations, { artifactType, sourcePath, relativePath, bytes, metadata = {}, objectDigest }) {
  const artifact = {
    artifactType,
    relativePath,
    sha256: sha256(bytes),
    bytes: bytes.length,
    ...metadata,
    ...(objectDigest ? { contentDigest: objectDigest } : {}),
  };
  artifacts.push(artifact);
  copyOperations.push({ sourcePath, relativePath, bytes });
}

async function main() {
  const [glbArg, renderDirArg, referenceDirArg, reviewArg, backlogArg, verificationArg, accuracyEvidenceArg, readinessArg, outputArg] =
    process.argv.slice(2);
  if (!glbArg || !renderDirArg || !referenceDirArg || !reviewArg || !backlogArg ||
    !verificationArg || !accuracyEvidenceArg || !readinessArg || !outputArg || process.argv.length !== 11) {
    throw new Error("Usage: node scripts/build-building-review-package.mjs <candidate.glb> <render-directory> <reference-image-directory> <render-reference-review-report.json> <correction-tasks.json> <correction-verification.json> <accuracy-evidence.json> <release-readiness-report.json> <new-output-directory>");
  }

  const glbPath = path.resolve(glbArg);
  const renderDir = path.resolve(renderDirArg);
  const referenceDir = path.resolve(referenceDirArg);
  const reviewPath = path.resolve(reviewArg);
  const backlogPath = path.resolve(backlogArg);
  const verificationPath = path.resolve(verificationArg);
  const accuracyEvidencePath = path.resolve(accuracyEvidenceArg);
  const readinessPath = path.resolve(readinessArg);
  const outputDir = path.resolve(outputArg);
  const manifestPath = path.join(renderDir, "render-review-manifest.json");
  const inputPaths = [glbPath, manifestPath, reviewPath, backlogPath, verificationPath, accuracyEvidencePath, readinessPath];

  const [glbBytes, manifestBytes, reviewBytes, backlogBytes, readinessBytes, accuracyEvidenceBytes] = await Promise.all([
    readRegularFile(glbPath, "candidate GLB"),
    readRegularFile(manifestPath, "render review manifest"),
    readRegularFile(reviewPath, "render/reference review report"),
    readRegularFile(backlogPath, "correction task backlog"),
    readRegularFile(readinessPath, "release readiness report"),
    readRegularFile(accuracyEvidencePath, "dimension/georeferencing accuracy evidence"),
  ]);
  const renderManifest = JSON.parse(manifestBytes.toString("utf8"));
  const renderReferenceReview = JSON.parse(reviewBytes.toString("utf8"));
  const correctionTaskBacklog = JSON.parse(backlogBytes.toString("utf8"));
  const readinessReport = JSON.parse(readinessBytes.toString("utf8"));
  const accuracyEvidence = JSON.parse(accuracyEvidenceBytes.toString("utf8"));
  const verificationDiskBytes = await readRegularFile(path.resolve(verificationArg), "correction verification report");

  const candidateGlbSha256 = sha256(glbBytes);
  const renderManifestSha256 = sha256(manifestBytes);
  const geometryQa = analyzeGlbQuality(glbBytes);
  const textureQa = reviewGlbTextureBindings(glbBytes);
  // These are the exact report-file bytes included in the immutable package.
  const geometryBytes = Buffer.from(JSON.stringify(geometryQa, null, 2) + "\n");
  const textureBytes = Buffer.from(JSON.stringify(textureQa, null, 2) + "\n");
  const correctionArtifactEvidence = {
    validated: true,
    candidateGlbSha256,
    renderManifestSha256,
    geometryQaReportSha256: sha256(geometryBytes),
    textureQaReportSha256: sha256(textureBytes),
    qaReportsRecomputedFromCandidateModel: true,
  };
  const correctionVerification = verifyRenderCorrectionTasks(
    correctionTaskBacklog, renderReferenceReview, correctionArtifactEvidence,
  );
  const verificationBytes = Buffer.from(JSON.stringify(correctionVerification, null, 2) + "\n");
  if (sha256(verificationDiskBytes) !== sha256(verificationBytes)) {
    throw new Error("Correction verification report does not match fresh recomputation from the actual candidate, manifest and candidate-bound QA artifacts.");
  }

  const actualRenderFiles = [];
  const renderFileBytes = new Map();
  for (const view of Array.isArray(renderManifest?.views) ? renderManifest.views : []) {
    if (!safePngName(view?.filename)) continue;
    const filePath = path.resolve(renderDir, view.filename);
    try {
      const { bytes, sha256: fileHash, width, height } = await readImageArtifact(filePath, "render image " + view.id);
      actualRenderFiles.push({ filename: view.filename, sha256: fileHash, width, height, bytes: bytes.length });
      renderFileBytes.set(view.filename, { sourcePath: filePath, bytes, sha256: fileHash, width, height });
    } catch {
      // Leave missing/corrupt images absent; the readiness gate will block the package.
    }
  }

  const recomputedReadiness = buildBuildingReleaseReadiness({
    buildingId: renderReferenceReview.buildingId,
    candidateGlbSha256,
    renderManifest,
    renderManifestSha256,
    actualRenderFiles,
    geometryQa,
    textureQa,
    renderReferenceReview,
    correctionTaskBacklog,
    correctionVerification,
    correctionArtifactEvidence,
    accuracyEvidence,
  });
  if (semanticDigest(readinessReport) !== semanticDigest(recomputedReadiness)) {
    throw new Error("Release readiness report does not match a fresh recomputation from the supplied candidate and evidence.");
  }
  if (recomputedReadiness.status === "blocked") {
    throw new Error("Cannot create a review package for a blocked candidate; inspect the release-readiness report first.");
  }

  const referenceFiles = new Map();
  for (const reference of renderReferenceReview.referenceImages ?? []) {
    if (reference?.rightsStatus !== "verified") {
      throw new Error("Reference rights are not verified for " + String(reference?.id) + "; no review package was created.");
    }
    if (!safeImageName(reference.filename)) {
      throw new Error("Reference filename is unsafe or absent for " + String(reference.id));
    }
    const filePath = path.resolve(referenceDir, reference.filename);
    const rootRelative = path.relative(referenceDir, filePath);
    if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) throw new Error("Reference path escapes reference-image directory.");
    const image = await readImageArtifact(filePath, "reference image " + reference.id);
    if (image.sha256.toLowerCase() !== reference.sha256?.toLowerCase() ||
      image.width !== reference.width || image.height !== reference.height) {
      throw new Error("Reference image bytes/hash/dimensions do not match the review report: " + reference.id);
    }
    referenceFiles.set(reference.id, { sourcePath: filePath, ...image, filename: reference.filename });
  }

  const artifacts = [];
  const copyOperations = [];
  addArtifact(artifacts, copyOperations, {
    artifactType: "candidate-glb", sourcePath: glbPath, relativePath: "model/candidate.glb", bytes: glbBytes,
  });

  const reportItems = [
    ["geometry-qa", "reports/geometry-qa.json", geometryBytes, geometryQa],
    ["texture-qa", "reports/texture-qa.json", textureBytes, textureQa],
    ["render-manifest", "renders/render-review-manifest.json", manifestBytes, renderManifest],
    ["render-reference-review", "reports/render-reference-review.json", reviewBytes, renderReferenceReview],
    ["correction-task-backlog", "reports/correction-tasks.json", backlogBytes, correctionTaskBacklog],
    ["correction-verification", "reports/correction-verification.json", verificationDiskBytes, correctionVerification],
    ["accuracy-evidence", "reports/accuracy-evidence.json", accuracyEvidenceBytes, accuracyEvidence],
    ["release-readiness-report", "reports/release-readiness.json", readinessBytes, readinessReport],
  ];
  for (const [artifactType, relativePath, bytes, object, digestOverride] of reportItems) {
    addArtifact(artifacts, copyOperations, {
      artifactType,
      sourcePath: null,
      relativePath,
      bytes,
      objectDigest: digestOverride ?? semanticDigest(object),
    });
  }

  for (const view of renderManifest.views ?? []) {
    const actual = renderFileBytes.get(view.filename);
    if (!actual) continue;
    addArtifact(artifacts, copyOperations, {
      artifactType: "render-image",
      sourcePath: actual.sourcePath,
      relativePath: "renders/" + view.filename,
      bytes: actual.bytes,
      metadata: { viewId: view.id, width: actual.width, height: actual.height },
    });
  }

  for (const reference of renderReferenceReview.referenceImages ?? []) {
    const actual = referenceFiles.get(reference.id);
    if (!actual) continue;
    addArtifact(artifacts, copyOperations, {
      artifactType: "reference-image",
      sourcePath: actual.sourcePath,
      relativePath: "references/" + sha256(Buffer.from(reference.id)).slice(0, 12) + "-" + actual.filename,
      bytes: actual.bytes,
      metadata: {
        referenceImageId: reference.id,
        rightsStatus: reference.rightsStatus,
        width: actual.width,
        height: actual.height,
      },
    });
  }

  const readinessDigestArtifact = artifacts.find((artifact) => artifact.artifactType === "release-readiness-report");
  readinessDigestArtifact.contentDigest = semanticDigest(readinessReport);
  const readmeBytes = Buffer.from([
    "# Building Review Package",
    "",
    "Purpose: final human release review only. This directory is not a published asset or publication approval.",
    "",
    "## Suggested review order",
    "1. Start with \`reports/release-readiness.json\`; inspect every warning before making a decision.",
    "2. Confirm \`model/candidate.glb\` SHA-256 against the review packet manifest.",
    "3. Open render images under \`renders/\` beside their corresponding evidence images under \`references/\`.",
    "4. Read \`reports/render-reference-review.json\`, \`reports/correction-tasks.json\` and \`reports/correction-verification.json\`.",
    "5. Review \`reports/geometry-qa.json\` and \`reports/texture-qa.json\`; structural QA cannot prove historical or architectural accuracy.",
    "6. Record a separate human release decision outside this automated package.",
    "",
    "The packet does not mark the candidate publication-eligible and does not contain an automated publication action.",
    "",
    "See \`package-manifest.json\` for SHA-256 hashes, sizes, view/reference identifiers and the exact evidence files included.",
    "",
  ].join("\n"));
  addArtifact(artifacts, copyOperations, {
    artifactType: "review-instructions",
    sourcePath: null,
    relativePath: "README.md",
    bytes: readmeBytes,
  });
  const packageManifest = buildBuildingReviewPackageManifest({
    buildingId: renderReferenceReview.buildingId,
    readinessReport: recomputedReadiness,
    renderManifestViews: renderManifest.views,
    artifacts,
  });
  const packageManifestBytes = Buffer.from(JSON.stringify(packageManifest, null, 2) + "\n");
  copyOperations.push({ sourcePath: null, relativePath: "package-manifest.json", bytes: packageManifestBytes });

  const outputParent = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  if (!outputName || outputName === "." || outputName === "..") throw new Error("Output directory name is invalid.");
  for (const inputPath of [...inputPaths, ...[...renderFileBytes.values()].map((item) => item.sourcePath),
    ...[...referenceFiles.values()].map((item) => item.sourcePath)]) {
    if (path.resolve(inputPath) === outputDir) throw new Error("Output directory must not replace an input file.");
  }

  await mkdir(outputParent, { recursive: true });
  // Refuse an existing directory so evidence packages are immutable snapshots.
  await mkdir(outputDir, { recursive: false });
  try {
    for (const operation of copyOperations) {
      const target = path.join(outputDir, operation.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      if (operation.sourcePath) {
        await copyFile(operation.sourcePath, target);
      } else {
        await writeFile(target, operation.bytes, { flag: "wx", mode: 0o600 });
      }
      const writtenBytes = await readFile(target);
      if (sha256(writtenBytes) !== sha256(operation.bytes)) {
        throw new Error("Copied artifact failed SHA-256 verification: " + operation.relativePath);
      }
    }
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }

  console.log(JSON.stringify({
    outputDirectory: outputDir,
    buildingId: packageManifest.buildingId,
    readinessStatus: packageManifest.readiness.status,
    artifacts: packageManifest.counts.artifacts,
    renderImages: packageManifest.counts.renderImages,
    referenceImages: packageManifest.counts.referenceImages,
    totalBytes: packageManifest.counts.totalBytes,
    finalHumanReviewRequired: packageManifest.policy.finalHumanReviewRequired,
    publicationEligible: packageManifest.policy.publicationEligible,
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not build building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
