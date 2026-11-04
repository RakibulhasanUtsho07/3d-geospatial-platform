#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadFloorPlanModelCandidate } from "../src/core/building-generation/floor-plan-model-job.mjs";
import {
  canonicalFloorPlanPublicationReviewBytes,
  createFloorPlanPublicationReviewSubmission,
} from "../src/core/building-generation/floor-plan-publication-review.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  );
}

async function readWorkspaceFile(root, relative, label, maxBytes) {
  if (typeof relative !== "string" || !relative.trim() || relative.includes("\\") ||
      relative.includes("\0") || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe workspace-relative POSIX path.");
  }
  const target = path.resolve(root, ...relative.split("/"));
  if (!inside(root, target)) throw new TypeError(label + " escapes the workspace.");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > maxBytes) {
    throw new TypeError(label + " must be a regular non-symlink file within its byte limit.");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new TypeError(label + " resolves outside the workspace.");
  const bytes = await readFile(actual);
  if (bytes.length !== info.size || bytes.length > maxBytes) {
    throw new Error(label + " changed while it was being read.");
  }
  return bytes;
}

async function main() {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "private-key": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (parsed.values.help) {
    console.log("Sign a floor-plan candidate's exact approved publication review with a trusted Ed25519 reviewer key.");
    console.log("Usage: npm run sign:floor-plan-publication-review -- <workspaceRoot> <buildingId> <candidateId> --private-key <local-key.pem> --out <receipt.json>");
    console.log("The private key stays on the reviewer's machine; only the signed JSON receipt is uploaded for publication.");
    return;
  }
  if (parsed.positionals.length !== 3 ||
      typeof parsed.values["private-key"] !== "string" ||
      typeof parsed.values.out !== "string") {
    throw new TypeError("workspaceRoot, buildingId, candidateId, --private-key and --out are required.");
  }

  const workspaceRoot = await realpath(path.resolve(parsed.positionals[0]));
  const buildingId = safeId(parsed.positionals[1], "buildingId");
  const candidateId = safeId(parsed.positionals[2], "candidateId");
  const candidate = await loadFloorPlanModelCandidate({ workspaceRoot, buildingId, candidateId });
  const directory = path.join(
    workspaceRoot, ".building-engine", "floor-plan-candidates", buildingId, candidateId,
  );
  const reviewRelative = path.posix.join(".building-engine", "floor-plan-candidates", buildingId, candidateId, "review.json");
  const attestationRelative = path.posix.join(".building-engine", "floor-plan-candidates", buildingId, candidateId, "attestation.json");
  const reviewBytes = await readWorkspaceFile(workspaceRoot, reviewRelative, "Immutable floor-plan review record", 2 * 1024 * 1024);
  const attestationBytes = await readWorkspaceFile(workspaceRoot, attestationRelative, "Floor-plan publication attestation", 2 * 1024 * 1024);
  const review = JSON.parse(reviewBytes.toString("utf8"));
  const attestation = JSON.parse(attestationBytes.toString("utf8"));
  if (review.buildingId !== buildingId || review.candidateId !== candidateId ||
      review.decision !== "approved" ||
      review.candidate?.modelSha256 !== candidate.modelSha256 ||
      review.candidate?.reportSha256 !== candidate.reportSha256 ||
      review.candidate?.geometrySha256 !== candidate.geometrySha256 ||
      attestation.candidateSha256 !== candidate.modelSha256 ||
      attestation.model?.id !== review.publication?.modelId ||
      attestation.review?.reviewer !== review.reviewer ||
      attestation.review?.reviewedAt !== review.reviewedAt) {
    throw new Error("Floor-plan review, candidate, QA report or publication attestation changed; refusing to sign.");
  }

  const privateKeyPath = path.resolve(parsed.values["private-key"]);
  if (inside(workspaceRoot, privateKeyPath)) {
    throw new TypeError("--private-key must be stored outside the generation workspace.");
  }
  const keyInfo = await lstat(privateKeyPath);
  if (keyInfo.isSymbolicLink() || !keyInfo.isFile() || keyInfo.size < 64 || keyInfo.size > 16 * 1024) {
    throw new TypeError("--private-key must identify a regular private-key PEM between 64 bytes and 16 KiB.");
  }
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("--private-key must contain an Ed25519 private key.");
  }

  const submission = createFloorPlanPublicationReviewSubmission({
    reviewRecord: review,
    reviewRecordSha256: hash(reviewBytes),
    publicationAttestationSha256: hash(attestationBytes),
  });
  const signatureBase64 = sign(
    null,
    canonicalFloorPlanPublicationReviewBytes(submission),
    privateKey,
  ).toString("base64");
  const receipt = { submission, signatureBase64 };
  const outputPath = path.resolve(parsed.values.out);
  await writeFile(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });

  console.log(JSON.stringify({
    status: "signed-floor-plan-publication-review-receipt-created",
    buildingId,
    candidateId,
    floorPlanId: review.floorPlanId,
    reviewerId: submission.reviewerId,
    reviewRecordSha256: submission.reviewRecordSha256,
    publicationAttestationSha256: submission.publicationAttestationSha256,
    candidateGlbSha256: submission.candidateGlbSha256,
    qaReportSha256: submission.qaReportSha256,
    geometrySha256: submission.geometrySha256,
    sourceSha256: submission.sourceSha256,
    evidenceSha256: submission.evidenceSha256,
    placementSha256: submission.placementSha256,
    signatureSha256: hash(Buffer.from(signatureBase64, "base64")),
    receiptPath: outputPath,
    privateKeyExported: false,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Floor-plan publication signing refused:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
