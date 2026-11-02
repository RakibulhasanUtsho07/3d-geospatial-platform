import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireGenerationWorkerLock,
  claimNextGenerationJob,
  completeGenerationJob,
  enqueueGenerationJob,
  failGenerationJob,
  getGenerationJob,
  listGenerationJobs,
  recoverInterruptedGenerationJobs,
  updateGenerationJob,
} from "../src/core/building-generation/generation-job-queue.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));

async function makeWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function basicInput(overrides = {}) {
  return { buildingSpec: fixture, strategy: "procedural", sources: [], ...overrides };
}

test("persists generation requests and lists only bounded, validated queue state", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const job = await enqueueGenerationJob({ workspaceRoot, input: basicInput() });
  assert.equal(job.status, "queued");
  assert.equal(job.mapReady, false);
  assert.equal(job.publicationEligible, false);
  assert.equal((await getGenerationJob({ workspaceRoot, jobId: job.jobId })).buildingId, fixture.id);
  assert.equal((await listGenerationJobs({ workspaceRoot, limit: 5 })).length, 1);
  assert.deepEqual((await listGenerationJobs({ workspaceRoot, limit: 5 }))[0], job);
  const requestPath = path.join(workspaceRoot, ".building-engine", "generation-queue", "jobs", job.jobId, "request.json");
  assert.equal(JSON.parse(await readFile(requestPath, "utf8")).buildingId, fixture.id);
  await assert.rejects(listGenerationJobs({ workspaceRoot, limit: 101 }), /between 1 and 100/);
});

test("rejects source path traversal, unknown licence, and missing rights attestation", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const source = {
    sourceId: "front",
    relativePath: "../secret.png",
    licence: "CC BY 4.0",
    permittedOperations: ["private-media-ingestion", "procedural-model-derivation"],
  };
  await assert.rejects(enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true, confirmOperationScopes: true }) }), /parent path segments/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [{ ...source, relativePath: "uploads/front.png", licence: "unknown" }], confirmRights: true, confirmOperationScopes: true }),
  }), /known permission\/licence/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [{ ...source, relativePath: "uploads/front.png" }], confirmOperationScopes: true }),
  }), /confirmRights/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({
      sources: [{ ...source, relativePath: "uploads/front.png" }],
      confirmRights: true,
    }),
  }), /confirmOperationScopes/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [{ sourceId: "front", relativePath: "uploads/front.png", licence: "CC BY 4.0", permittedOperations: ["private-media-ingestion", "photogrammetry-reconstruction", "texture-baking"] }], confirmRights: true, confirmOperationScopes: true, strategy: "photogrammetry", viewSourceIds: ["front"], upAxis: "Z", confirmSameBuilding: true, confirmOverlapReviewed: true, confirmUpAxisReviewed: true }),
  }), /at least three selected/);
});

test("rejects missing source media before creating a queue job", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const source = {
    sourceId: "front",
    relativePath: "uploads/front.png",
    licence: "CC BY 4.0",
    kind: "image",
    permittedOperations: ["private-media-ingestion", "procedural-model-derivation"],
  };
  await assert.rejects(
    enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true, confirmOperationScopes: true }) }),
    /does not exist in workspaceRoot/,
  );
  assert.deepEqual(await listGenerationJobs({ workspaceRoot, limit: 5 }), []);
});

test("rejects WebP selected views for single-image AI and photogrammetry before queue creation", async (t) => {
  const webp = Buffer.from("RIFFxxxxWEBP", "ascii");

  const singleWorkspace = await makeWorkspace(t);
  await mkdir(path.join(singleWorkspace, "uploads"), { recursive: true });
  await writeFile(path.join(singleWorkspace, "uploads", "view.webp"), webp);
  const singleSource = {
    sourceId: "view-1",
    relativePath: "uploads/view.webp",
    licence: "CC BY 4.0",
    kind: "image",
    permittedOperations: ["private-media-ingestion", "single-image-ai-reconstruction"],
  };
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot: singleWorkspace,
    input: basicInput({
      strategy: "single-image-ai",
      sources: [singleSource],
      viewSourceIds: ["view-1"],
      confirmRights: true,
      confirmOperationScopes: true,
      confirmSingleViewInference: true,
    }),
  }), /image\\/webp.*supports JPEG or PNG/i);
  assert.deepEqual(await listGenerationJobs({ workspaceRoot: singleWorkspace, limit: 5 }), []);

  const photoWorkspace = await makeWorkspace(t);
  await mkdir(path.join(photoWorkspace, "uploads"), { recursive: true });
  const photoSources = ["front", "side", "rear"].map((sourceId) => ({
    sourceId,
    relativePath: "uploads/" + sourceId + ".webp",
    licence: "CC BY 4.0",
    kind: "image",
    permittedOperations: ["private-media-ingestion", "photogrammetry-reconstruction", "texture-baking"],
  }));
  for (const source of photoSources) {
    await writeFile(path.join(photoWorkspace, source.relativePath), webp);
  }
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot: photoWorkspace,
    input: basicInput({
      strategy: "photogrammetry",
      sources: photoSources,
      viewSourceIds: photoSources.map((source) => source.sourceId),
      confirmRights: true,
      confirmOperationScopes: true,
      confirmSameBuilding: true,
      confirmOverlapReviewed: true,
      confirmUpAxisReviewed: true,
      upAxis: "Y",
    }),
  }), /image\\/webp.*supports JPEG or PNG/i);
  assert.deepEqual(await listGenerationJobs({ workspaceRoot: photoWorkspace, limit: 5 }), []);
});

test("accepts a PNG-signature selected view for single-image AI at queue preflight", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  await mkdir(path.join(workspaceRoot, "uploads"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "uploads", "view.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const job = await enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({
      strategy: "single-image-ai",
      sources: [{
        sourceId: "view-1",
        relativePath: "uploads/view.png",
        licence: "CC BY 4.0",
        kind: "image",
        permittedOperations: ["private-media-ingestion", "single-image-ai-reconstruction"],
      }],
      viewSourceIds: ["view-1"],
      confirmRights: true,
      confirmOperationScopes: true,
      confirmSingleViewInference: true,
    }),
  });
  assert.equal(job.status, "queued");
});

test("rejects symlinked sources and sources that are not regular files", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  await mkdir(path.join(workspaceRoot, "uploads"), { recursive: true });
  const outside = path.join(workspaceRoot, "outside.png");
  await writeFile(outside, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  await symlink(outside, path.join(workspaceRoot, "uploads", "front.png"));
  const source = {
    sourceId: "front",
    relativePath: "uploads/front.png",
    licence: "CC BY 4.0",
    kind: "image",
    permittedOperations: ["private-media-ingestion", "procedural-model-derivation"],
  };
  await assert.rejects(
    enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true, confirmOperationScopes: true }) }),
    /symbolic links/,
  );
  await rm(path.join(workspaceRoot, "uploads", "front.png"));
  await assert.rejects(
    enqueueGenerationJob({
      workspaceRoot,
      input: basicInput({
        sources: [{ ...source, relativePath: "uploads" }],
        confirmRights: true,
        confirmOperationScopes: true,
      }),
    }),
    /regular file/,
  );
  assert.deepEqual(await listGenerationJobs({ workspaceRoot, limit: 5 }), []);
});

test("accepts existing media files and rejects empty or oversized sources", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  await mkdir(path.join(workspaceRoot, "uploads"), { recursive: true });
  const filePath = path.join(workspaceRoot, "uploads", "front.png");
  await writeFile(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const source = {
    sourceId: "front",
    relativePath: "uploads/front.png",
    licence: "CC BY 4.0",
    kind: "image",
    permittedOperations: ["private-media-ingestion", "procedural-model-derivation"],
  };
  const job = await enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [source], confirmRights: true, confirmOperationScopes: true }),
  });
  assert.equal(job.status, "queued");

  const emptyPath = path.join(workspaceRoot, "uploads", "empty.png");
  await writeFile(emptyPath, Buffer.alloc(0));
  await assert.rejects(
    enqueueGenerationJob({
      workspaceRoot,
      input: basicInput({
        sources: [{ ...source, sourceId: "empty", relativePath: "uploads/empty.png" }],
        confirmRights: true,
        confirmOperationScopes: true,
      }),
    }),
    /is empty/,
  );

  await truncate(filePath, 20 * 1024 * 1024 + 1);
  await assert.rejects(
    enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true, confirmOperationScopes: true }) }),
    /exceeds the 20971520-byte image intake limit/,
  );
  assert.equal((await listGenerationJobs({ workspaceRoot, limit: 5 })).length, 1);
});

test("claims, completes and records a fail-closed review candidate", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const queued = await enqueueGenerationJob({ workspaceRoot, input: basicInput() });
  const claimed = await claimNextGenerationJob({ workspaceRoot, workerId: "test-worker" });
  assert.equal(claimed.job.jobId, queued.jobId);
  assert.equal(claimed.job.status, "running");
  assert.equal(claimed.request.jobId, queued.jobId);
  const completed = await completeGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    result: { modelPath: ".building-engine/jobs/demo/model.glb", mapReady: false, publicationEligible: false },
  });
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.result.mapReady, false);
  assert.equal(completed.job.publicationEligible, false);
  await assert.rejects(completeGenerationJob({
    workspaceRoot, jobId: queued.jobId, result: {},
  }), /Only running jobs/);
});

test("recovers interrupted work into a retryable queued job and enforces the retry ceiling", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const queued = await enqueueGenerationJob({ workspaceRoot, input: basicInput() });
  await claimNextGenerationJob({ workspaceRoot, workerId: "crashed-worker" });
  assert.deepEqual(await recoverInterruptedGenerationJobs({ workspaceRoot }), [queued.jobId]);
  assert.equal((await getGenerationJob({ workspaceRoot, jobId: queued.jobId })).status, "queued");

  await updateGenerationJob({
    workspaceRoot, jobId: queued.jobId,
    update: (state) => { state.nextAttemptAt = new Date(0).toISOString(); },
  });
  const retry = await claimNextGenerationJob({ workspaceRoot, workerId: "retry-worker" });
  assert.equal(retry.job.attempt, 2);
  const failed = await failGenerationJob({
    workspaceRoot, jobId: queued.jobId, error: new Error("deterministic test failure"), retry: true,
  });
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.lastError.message, "deterministic test failure");
});

test("prevents two local workers from holding the queue lock at once", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const first = await acquireGenerationWorkerLock({ workspaceRoot });
  try {
    await assert.rejects(acquireGenerationWorkerLock({ workspaceRoot }), /already running/);
  } finally {
    await first.release();
  }
  const second = await acquireGenerationWorkerLock({ workspaceRoot });
  await second.release();
});
