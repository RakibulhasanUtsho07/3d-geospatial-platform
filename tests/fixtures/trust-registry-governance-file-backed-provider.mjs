import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const syntheticOnly = true;

function identityKey(identity) {
  return createHash("sha256").update(JSON.stringify([
    identity.registrySetId,
    identity.governanceKeyFingerprintSha256,
  ])).digest("hex");
}

function anchorFor(state) {
  return {
    revision: state.revision,
    minimumAcceptedSequence: state.minimumAcceptedSequence,
    stateSha256: state.stateSha256,
  };
}

async function readDocument(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !value.records || typeof value.records !== "object" || Array.isArray(value.records)) {
      throw new Error("Test provider state document is malformed.");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { records: {} };
    throw error;
  }
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close();
        await unlink(lockPath);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Test provider lock timed out.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function writeDocument(filePath, document) {
  const temporaryPath = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(document), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

function snapshot(record) {
  return {
    version: "generation-" + record.generation,
    state: structuredClone(record.state),
    anchor: structuredClone(record.anchor),
  };
}

export async function createProvider() {
  const filePath = process.env.D3M26_TEST_PROVIDER_STATE_FILE;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("The test provider state file must be an absolute path.");
  }
  const lockPath = filePath + ".lock";

  return Object.freeze({
    providerId: "d3m26-file-backed-test-provider",

    async readState(identity) {
      const document = await readDocument(filePath);
      const record = document.records[identityKey(identity)];
      return record ? snapshot(record) : null;
    },

    async initializeStateIfAbsent({ identity, state }) {
      const release = await acquireLock(lockPath);
      try {
        const document = await readDocument(filePath);
        const key = identityKey(identity);
        if (document.records[key]) {
          return { created: false, ...snapshot(document.records[key]) };
        }
        const record = {
          generation: 1,
          state: structuredClone(state),
          anchor: anchorFor(state),
        };
        document.records[key] = record;
        await writeDocument(filePath, document);
        return { created: true, ...snapshot(record) };
      } finally {
        await release();
      }
    },

    async compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState }) {
      const release = await acquireLock(lockPath);
      try {
        const document = await readDocument(filePath);
        const key = identityKey(identity);
        const record = document.records[key];
        if (!record) throw new Error("Test provider identity is not initialized.");
        const current = snapshot(record);
        if (current.version !== expectedVersion ||
            current.state.stateSha256 !== expectedStateSha256) {
          return { updated: false, ...current };
        }
        const nextRecord = {
          generation: record.generation + 1,
          state: structuredClone(nextState),
          anchor: anchorFor(nextState),
        };
        document.records[key] = nextRecord;
        await writeDocument(filePath, document);
        return { updated: true, ...snapshot(nextRecord) };
      } finally {
        await release();
      }
    },
  });
}
