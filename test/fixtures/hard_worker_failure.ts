import {
  deepStrictEqual as assertEquals,
  ok as assert,
} from 'node:assert/strict';
import type {
  BatchOptions,
  BatchResult,
  DbiContract,
} from '../_support/contract.ts';
import { withDeadline } from '../_support/lifecycle.ts';
import { loadSubject } from '../_support/subject.ts';

const path = Deno.args[0];
if (!path) {
  throw new Error('hard_worker_failure.ts requires an environment path');
}

const { Env } = await loadSubject();
const env = new Env();
let dbi: DbiContract | undefined;

try {
  env.open({ path, mapSize: 16 * 1024 * 1024, maxDbs: 2 });
  dbi = env.openDbi({ name: 'hard-failure', create: true });

  // This package-internal symbol is deliberately absent from public types. It
  // allows one isolated test process to terminate the Worker after mdb_txn_begin.
  const { TEST_TERMINATE_AFTER_BEGIN } = await import(
    '../../src/batch/protocol.ts'
  );
  const internalOptions = {
    [TEST_TERMINATE_AFTER_BEGIN]: true,
  } as BatchOptions;

  let activeCalls = 0;
  let queuedCalls = 0;
  let closed = false;
  let poisonedError: unknown;
  const events = ['before'];
  const activeFailure = new Promise<{
    error: Error | null;
    results?: BatchResult[];
  }>((resolve) => {
    env.batchWrite(
      [[dbi!, 'key', new Uint8Array([1])]],
      internalOptions,
      (error, results) => {
        activeCalls++;
        events.push('active');
        resolve({ error, results });
      },
    );
  });
  const queuedFailure = new Promise<{
    error: Error | null;
    results?: BatchResult[];
  }>((resolve, reject) => {
    env.batchWrite(
      [[dbi!, 'queued', new Uint8Array([2])]],
      (error, results) => {
        queuedCalls++;
        events.push('queued');
        try {
          try {
            env.stat();
          } catch (caught) {
            poisonedError = caught;
          }
          env.close();
          closed = true;
          resolve({ error, results });
        } catch (caught) {
          reject(caught);
        }
      },
    );
  });
  events.push('after');
  assertEquals(events, ['before', 'after']);
  const [failure, queued] = await withDeadline(
    Promise.all([activeFailure, queuedFailure]),
    10_000,
    'hard Worker active and queued failure callbacks',
  );
  assert(failure.error instanceof Error);
  assertEquals(failure.results, undefined);
  assert(queued.error instanceof Error);
  assertEquals(queued.results, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(activeCalls, 1);
  assertEquals(queuedCalls, 1);
  assertEquals(events, ['before', 'after', 'active', 'queued']);
  assertEquals(closed, true);

  assert(poisonedError instanceof Error);
  assert(poisonedError.message.toLowerCase().includes('poison'));

  // Poisoned close invalidates wrappers but intentionally skips unsafe native
  // cleanup; process isolation contains the leaked native write transaction.
  console.log('hard-worker-failure-ok');
} finally {
  try {
    dbi?.close();
  } catch {
    // The poisoned Env must already have invalidated the DBI wrapper.
  }
  try {
    env.close();
  } catch {
    // Expected when the primary assertion failed before normal poisoned close.
  }
}
