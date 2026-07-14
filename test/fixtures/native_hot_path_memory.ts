import { deepStrictEqual, ok as assert, strictEqual } from 'node:assert/strict';
import { Cursor, Env } from '../../mod.ts';
import {
  getNativeBindingCounts,
} from '../../src/internal/native_test_access.ts';

const [path] = Deno.args;
if (!path) throw new Error('Expected an environment path');

const exposedGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (typeof exposedGc !== 'function') throw new Error('gc is not exposed');
const forceGc: () => void = exposedGc;

const ENTRY_COUNT = 64;
const KEY_BYTES = 320;
const VALUE_BYTES = 128 * 1024;
const MAX_COLLECTION_ATTEMPTS = 240;

interface MemoryDiagnostic {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

interface TrackedReference {
  readonly label: string;
  readonly token: number;
  readonly reference: WeakRef<object>;
}

class CollectionTracker {
  readonly #finalized = new Set<number>();
  readonly #references: TrackedReference[] = [];
  readonly #registry = new FinalizationRegistry<number>((token) => {
    this.#finalized.add(token);
  });
  #nextToken = 0;

  get size(): number {
    return this.#references.length;
  }

  get finalized(): number {
    return this.#finalized.size;
  }

  watchBuffer(value: Uint8Array, label: string): void {
    this.#watch(value, `${label} view`);
    this.#watch(value.buffer, `${label} backing buffer`);
  }

  watchObject(value: object, label: string): void {
    this.#watch(value, label);
  }

  async collect(): Promise<{ attempts: number; live: number }> {
    for (let attempt = 1; attempt <= MAX_COLLECTION_ATTEMPTS; attempt++) {
      await eventLoopTurn();
      forceGc();
      forceGc();
      await eventLoopTurn();

      const live = this.#references.filter(({ reference }) =>
        reference.deref() !== undefined
      );
      if (live.length === 0 && this.#finalized.size === this.size) {
        return { attempts: attempt, live: 0 };
      }

      // Encourage old-generation collection without treating allocator
      // high-water behavior as correctness evidence.
      const pressure = new Uint8Array(2 * 1024 * 1024);
      pressure[attempt % pressure.byteLength] = attempt;
      await eventLoopTurn();
    }

    const live = this.#references.filter(({ reference }) =>
      reference.deref() !== undefined
    );
    const labels = live.slice(0, 12).map(({ label }) => label).join(', ');
    throw new Error(
      `Timed out collecting hot-path buffers: live=${live.length}/${this.size}, finalized=${this.#finalized.size}/${this.size}, examples=${labels}`,
    );
  }

  #watch(target: object, label: string): void {
    const token = this.#nextToken++;
    this.#references.push({
      label,
      token,
      reference: new WeakRef(target),
    });
    this.#registry.register(target, token);
  }
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function memoryDiagnostic(): MemoryDiagnostic {
  const usage = Deno.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
  };
}

function makeKey(index: number): Uint8Array {
  const key = new Uint8Array(KEY_BYTES);
  new DataView(key.buffer).setUint32(0, index, false);
  for (let offset = 4; offset < key.byteLength; offset++) {
    key[offset] = (index * 17 + offset * 29 + 0x5d) & 0xff;
  }
  return key;
}

function makeValue(index: number): Uint8Array {
  const value = new Uint8Array(VALUE_BYTES);
  for (let offset = 0; offset < value.byteLength; offset++) {
    value[offset] = (index * 31 + offset * 7 + 0xa3) & 0xff;
  }
  return value;
}

function assertValue(value: Uint8Array | null, index: number): Uint8Array {
  assert(value instanceof Uint8Array, `Expected value ${index}`);
  strictEqual(value.byteLength, VALUE_BYTES);
  strictEqual(value[0], (index * 31 + 0xa3) & 0xff);
  const middle = Math.floor(value.byteLength / 2);
  strictEqual(value[middle], (index * 31 + middle * 7 + 0xa3) & 0xff);
  const last = value.byteLength - 1;
  strictEqual(value[last], (index * 31 + last * 7 + 0xa3) & 0xff);
  return value;
}

function putTracked(
  tracker: CollectionTracker,
  txn: ReturnType<Env['beginTxn']>,
  dbi: ReturnType<Env['openDbi']>,
  index: number,
): void {
  const key = makeKey(index);
  const value = makeValue(index);
  tracker.watchBuffer(key, `write key ${index}`);
  tracker.watchBuffer(value, `write value ${index}`);
  txn.putBinary(dbi, key, value);
}

function readTracked(
  tracker: CollectionTracker,
  txn: ReturnType<Env['beginTxn']>,
  dbi: ReturnType<Env['openDbi']>,
  index: number,
): void {
  const key = makeKey(index);
  tracker.watchBuffer(key, `read key ${index}`);
  const value = assertValue(txn.getBinary(dbi, key), index);
  tracker.watchBuffer(value, `read value ${index}`);
}

function seekTracked(
  tracker: CollectionTracker,
  cursor: Cursor<Uint8Array>,
  index: number,
): void {
  const key = makeKey(index);
  tracker.watchBuffer(key, `cursor seek key ${index}`);
  const found = cursor.goToRange(key);
  assert(found instanceof Uint8Array, `Expected cursor key ${index}`);
  tracker.watchBuffer(found, `cursor seek result ${index}`);
  strictEqual(new DataView(found.buffer).getUint32(0, false), index);
  const value = assertValue(cursor.getCurrentBinary(), index);
  tracker.watchBuffer(value, `cursor seek value ${index}`);
}

function iterateTracked(
  tracker: CollectionTracker,
  cursor: Cursor<Uint8Array>,
): void {
  let index = 0;
  for (
    let key = cursor.goToFirst();
    key !== null;
    key = cursor.goToNext()
  ) {
    tracker.watchBuffer(key, `cursor movement key ${index}`);
    strictEqual(new DataView(key.buffer).getUint32(0, false), index);
    const value = assertValue(cursor.getCurrentBinary(), index);
    tracker.watchBuffer(value, `cursor movement value ${index}`);
    index++;
  }
  strictEqual(index, ENTRY_COUNT);
}

function cacheTracked(
  tracker: CollectionTracker,
  cursor: Cursor<Uint8Array>,
  label: string,
): void {
  const key = cursor.goToFirst();
  assert(key instanceof Uint8Array, 'Expected cached cursor key');
  tracker.watchBuffer(key, `${label} key`);
  const value = cursor.getCurrentBinaryUnsafe();
  assert(value instanceof Uint8Array, 'Expected cached cursor value');
  tracker.watchBuffer(value, `${label} value`);
}

function leakCursorWithLiveTransaction(
  tracker: CollectionTracker,
  txn: ReturnType<Env['beginTxn']>,
  dbi: ReturnType<Env['openDbi']>,
): void {
  const cursor = new Cursor<Uint8Array>(txn, dbi);
  cacheTracked(tracker, cursor, 'unreachable cursor cache');
  tracker.watchObject(cursor, 'unreachable cursor wrapper');
}

async function settleWarmup(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await eventLoopTurn();
    forceGc();
  }
}

function warmHotPaths(
  env: Env,
  dbi: ReturnType<Env['openDbi']>,
): void {
  const key = makeKey(0);
  const value = makeValue(0);
  const write = env.beginTxn();
  write.putBinary(dbi, key, value);
  write.commit();

  const read = env.beginTxn({ readOnly: true });
  assertValue(read.getBinary(dbi, key), 0);
  const cursor = new Cursor<Uint8Array>(read, dbi);
  assert(cursor.goToFirst() instanceof Uint8Array);
  assertValue(cursor.getCurrentBinary(), 0);
  cursor.close();
  read.abort();
}

const tracker = new CollectionTracker();
const beforeWarmup = memoryDiagnostic();
const env = new Env();
env.open({
  path,
  maxDbs: 2,
  mapSize: 256 * 1024 * 1024,
});
const baselineCounts = getNativeBindingCounts(env);
strictEqual(baselineCounts.environments, 1);
strictEqual(baselineCounts.transactions, 0);
strictEqual(baselineCounts.dbis, 0);
strictEqual(baselineCounts.cursors, 0);

const dbi = env.openDbi({
  name: 'hot-path-memory',
  create: true,
  keyIsBuffer: true,
});

// Warm the exact write, read, and cursor FFI paths before the stress phase.
warmHotPaths(env, dbi);
await settleWarmup();
const afterWarmup = memoryDiagnostic();

const write = env.beginTxn();
for (let index = 0; index < ENTRY_COUNT; index++) {
  putTracked(tracker, write, dbi, index);
}
write.commit();

const read = env.beginTxn({ readOnly: true });
for (let index = 0; index < ENTRY_COUNT; index++) {
  readTracked(tracker, read, dbi, index);
}
const cursor = new Cursor<Uint8Array>(read, dbi);
for (let index = 0; index < ENTRY_COUNT; index += 7) {
  seekTracked(tracker, cursor, index);
}
iterateTracked(tracker, cursor);
cursor.close();
read.abort();

// Keep this cursor wrapper strongly reachable while ending its transaction.
// Its cached key and unsafe native view must still become collectible.
const detachedRead = env.beginTxn({ readOnly: true });
const detachedCursor = new Cursor<Uint8Array>(detachedRead, dbi);
cacheTracked(tracker, detachedCursor, 'transaction-ended cursor cache');
detachedRead.abort();

// Closing the exact DBI wrapper invalidates this cursor. Its cache must clear
// even though both the cursor and its transaction remain strongly reachable.
const closedDbi = env.openDbi({
  name: 'hot-path-memory',
  keyIsBuffer: true,
});
const closedDbiRead = env.beginTxn({ readOnly: true });
const closedDbiCursor = new Cursor<Uint8Array>(closedDbiRead, closedDbi);
cacheTracked(tracker, closedDbiCursor, 'closed DBI cursor cache');
closedDbi.close();

// A live transaction retains only the cursor binding, never its JavaScript
// owner. This guards against an invalidation callback accidentally capturing
// the Cursor instance and preventing its finalizer from running.
const liveCursorTxn = env.beginTxn({ readOnly: true });
leakCursorWithLiveTransaction(tracker, liveCursorTxn, dbi);

const afterStress = memoryDiagnostic();
const collection = await tracker.collect();
strictEqual(collection.live, 0);
strictEqual(tracker.finalized, tracker.size);
const afterCollection = memoryDiagnostic();
const liveCounts = getNativeBindingCounts(env);
strictEqual(liveCounts.transactions, 2);
strictEqual(liveCounts.cursors, 2);

closedDbiCursor.close();
closedDbiRead.abort();
liveCursorTxn.abort();
detachedCursor.close();
dbi.close();
const closedCounts = getNativeBindingCounts(env);
deepStrictEqual(closedCounts, baselineCounts);
env.close();

console.log(JSON.stringify({
  status: 'native-hot-path-memory-ok',
  tracked: tracker.size,
  finalized: tracker.finalized,
  collectionAttempts: collection.attempts,
  liveAfterCollection: collection.live,
  baselineCounts,
  liveCounts,
  closedCounts,
  memory: {
    beforeWarmup,
    afterWarmup,
    afterStress,
    afterCollection,
  },
}));
