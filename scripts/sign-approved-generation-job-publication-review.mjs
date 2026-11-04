#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { getGenerationJob } from "../src/core/building-generation/generation-job-queue.mjs";
import {
  canonicalGenerationJobPublicationReviewBytes,
  createGenerationJobPublicationReviewSubmission,
} from "../src/core/building-generation/generation-job-publication-review.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() ||
      value.includes("\\") || value.includes("\0") ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a workspace-relative POSIX path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " contains an unsafe path segment.");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  );
}

async function readWorkspaceFile(root, relativePath, label, maxBytes) {
  const safePath = safeRelative(relativePath, label);
  const target = path.resolve(root, ...safePath.split("/"));
  if (!inside(root, target)) throw new TypeError(label + " escapes workspaceRoot.");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > maxBytes) {
    throw new TypeError(label + " must be a regular non-symlink file within the byte limit.");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new TypeError(label + " resolves outside workspaceRoot.");
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
    console.log("Sign an approved generation-job catalog-handoff decision locally with an Ed25519 reviewer key.");
    console.log("Usage: npm run sign:approved-generation-job-publication-review -- <workspaceRoot> <jobId> --private-key <local-key.pem> --out <receipt.json>");
    console.log("The private key is read only on this operator machine and is never copied to the server or printed.");
    return;
  }

  if (parsed.positionals.length !== 2 ||
      typeof parsed.values["private-key"] !== "string" ||
      typeof parsed.values.out !== "string") {
    throw new TypeError("workspaceRoot, jobId, --private-key and --out are required.");
  }

  const workspaceRoot = await realpath(path.resolve(parsed.positionals[0]));
  const jobId = parsed.positionals[1];
  const job = await getGenerationJob({ workspaceRoot, jobId });
  if (job.status !== "completed" || job.review?.decision !== "approved") {
    throw new Error("Only a completed job with an immutable approved review can be signed.");
  }
  if (!job.review.recordPath || !SHA256.test(job.review.recordSha256 ?? "")) {
    throw new Error("Approved job is missing its immutable review record identity/checksum.");
  }

  const recordBytes = await readWorkspaceFile(workspaceRoot, job.review.recordPath, "Approved review record", 1024 * 1024);
  const recordSha256 = sha256(recordBytes);
  if (recordSha256 !== job.review.recordSha256) {
    throw new Error("Approved review record changed; refusing to sign.");
  }
  const record = JSON.parse(recordBytes.toString("utf8"));
  if (!record || record.jobId !== jobId || record.buildingId !== job.buildingId ||
      record.reviewId !== job.review.reviewId || record.decision !== "approved" ||
      record.candidate?.modelPath !== job.result?.modelPath ||
      record.candidate?.reportPath !== job.result?.reportPath) {
    throw new Error("Approved review record identity/candidate paths do not match the generation job.");
  }

  const candidateBytes = await readWorkspaceFile(workspaceRoot, record.candidate?.modelPath ?? job.result?.modelPath, "Reviewed candidate GLB", 512 * 1024 * 1024);
  const reportBytes = await readWorkspaceFile(workspaceRoot, record.candidate?.reportPath ?? job.result?.reportPath, "Reviewed QA report", 5 * 1024 * 1024);
  if (sha256(candidateBytes) !== record.candidate?.modelSha256 ||
      sha256(candidateBytes) !== job.result?.modelSha256 ||
      sha256(reportBytes) !== record.candidate?.reportSha256) {
    throw new Error("Candidate GLB or QA report changed after approval; refusing to sign.");
  }

  const keyPath = path.resolve(parsed.values["private-key"]);
  const keyRealPath = await realpath(keyPath);
  if (inside(workspaceRoot, keyPath) || inside(workspaceRoot, keyRealPath)) {
    throw new TypeError("--private-key must resolve outside the generation workspace.");
  }
  const keyInfo = await lstat(keyPath);
  if (keyInfo.isSymbolicLink() || !keyInfo.isFile() || keyInfo.size < 64 || keyInfo.size > 16 * 1024) {
    throw new TypeError("--private-key must identify a regular private-key PEM file between 64 bytes and 16 KiB.");
  }
  const privateKey = createPrivateKey(await readFile(keyRealPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("--private-key must contain an Ed25519 private key.");
  }

  const submission = createGenerationJobPublicationReviewSubmission({
    jobId,
    buildingId: job.buildingId,
    reviewRecord: record,
    reviewRecordSha256: recordSha256,
  });
  const payloadBytes = canonicalGenerationJobPublicationReviewBytes(submission);
  const signatureBase64 = sign(null, payloadBytes, privateKey).toString("base64");
  const receipt = { submission, signatureBase64 };
  const outputPath = path.resolve(parsed.values.out);
  await writeFile(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });

  console.log(JSON.stringify({
    status: "signed-publication-review-receipt-created",
    jobId,
    buildingId: job.buildingId,
    reviewerId: submission.reviewerId,
    reviewRecordSha256: submission.reviewRecordSha256,
    candidateGlbSha256: submission.candidateGlbSha256,
    qaReportSha256: submission.qaReportSha256,
    placementSha256: submission.placementSha256,
    signatureSha256: sha256(Buffer.from(signatureBase64, "base64")),
    receiptPath: outputPath,
    privateKeyExported: false,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Generation-job review signing refused:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
