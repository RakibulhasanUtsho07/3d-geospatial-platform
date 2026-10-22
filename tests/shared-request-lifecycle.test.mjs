import assert from "node:assert/strict";
import test from "node:test";

import {
  attachSharedRequestConsumer,
} from "../src/core/geospatial/shared-request-lifecycle.mjs";

function createEntry() {
  return {
    controller: new AbortController(),
    consumers: 0,
    settled: false,
  };
}

test("aborting the only consumer cancels its upstream request", () => {
  const entry = createEntry();
  const client = new AbortController();
  const release = attachSharedRequestConsumer(entry, client.signal);

  assert.equal(entry.consumers, 1);
  assert.equal(entry.controller.signal.aborted, false);

  client.abort();

  assert.equal(entry.consumers, 0);
  assert.equal(entry.controller.signal.aborted, true);
  release();
  assert.equal(entry.consumers, 0);
});

test("one cancelled consumer does not abort a request still used by another client", () => {
  const entry = createEntry();
  const firstClient = new AbortController();
  const secondClient = new AbortController();

  attachSharedRequestConsumer(entry, firstClient.signal);
  const releaseSecond = attachSharedRequestConsumer(entry, secondClient.signal);

  firstClient.abort();
  assert.equal(entry.consumers, 1);
  assert.equal(entry.controller.signal.aborted, false);

  releaseSecond();
  assert.equal(entry.consumers, 0);
  assert.equal(entry.controller.signal.aborted, true);
});

test("successful completion releases a consumer without aborting settled work", () => {
  const entry = createEntry();
  const client = new AbortController();
  const release = attachSharedRequestConsumer(entry, client.signal);

  entry.settled = true;
  release();

  assert.equal(entry.consumers, 0);
  assert.equal(entry.controller.signal.aborted, false);
});

test("release is idempotent and does not underflow the consumer count", () => {
  const entry = createEntry();
  const client = new AbortController();
  const release = attachSharedRequestConsumer(entry, client.signal);

  release();
  release();

  assert.equal(entry.consumers, 0);
  assert.equal(entry.controller.signal.aborted, true);
});

test("already-aborted clients are not attached to the shared request", () => {
  const entry = createEntry();
  const client = new AbortController();
  client.abort();

  attachSharedRequestConsumer(entry, client.signal);

  assert.equal(entry.consumers, 0);
  assert.equal(entry.controller.signal.aborted, false);
});

test("rejects incomplete shared-request entries", () => {
  assert.throws(
    () => attachSharedRequestConsumer({}, new AbortController().signal),
    /shared request entry and AbortSignal/,
  );
});
