import { match as assertMatch, strictEqual } from 'node:assert/strict';
import { Cursor, Env } from '../../mod.ts';
import {
  getNativeBindingCounts,
  getNativeEnvironmentDetails,
  hasSharedActiveWriter,
} from '../../src/internal/native_test_access.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected an environment path');

const exposedGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (typeof exposedGc !== 'function') throw new Error('gc is not exposed');
const forceGc: () => void = exposedGc;

async function collect(
  references: readonly WeakRef<object>[],
  condition: () => boolean,
  operation: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    forceGc();
    // Give FinalizationRegistry cleanup jobs an event-loop turn as well.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (
      references.every((reference) => reference.deref() === undefined) &&
      condition()
    ) return;
  }
  throw new Error(`Timed out waiting for ${operation}`);
}

function expectClosed(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertMatch(error.message, /closed|ended|transaction|cursor/i);
    return;
  }
  throw new Error('Expected an already-closed handle error');
}

const env = new Env();
env.open({ path, maxDbs: 12, maxReaders: 1 });
const dbi = env.openDbi({ name: 'ownership', create: true });
const baseline = getNativeBindingCounts(env);
strictEqual(baseline.transactions, 0);
strictEqual(baseline.cursors, 0);
strictEqual(baseline.dbis, 1);
strictEqual(baseline.pendingDbis, 0);

function leakWriteTransaction(): WeakRef<object> {
  const txn = env.beginTxn();
  txn.putString(dbi, 'leaked-write', 'aborted');
  return new WeakRef(txn);
}

const writeReference = leakWriteTransaction();
await collect(
  [writeReference],
  () => {
    const counts = getNativeBindingCounts(env);
    return !hasSharedActiveWriter(env) && counts.transactions === 0;
  },
  'leaked write transaction cleanup',
);
const replacementWrite = env.beginTxn();
strictEqual(replacementWrite.getString(dbi, 'leaked-write'), null);
replacementWrite.putString(dbi, 'committed', 'value');
replacementWrite.commit();

function leakReadTransactionAndCursor(): readonly WeakRef<object>[] {
  const txn = env.beginTxn({ readOnly: true });
  const cursor = new Cursor(txn, dbi);
  strictEqual(cursor.goToFirst(), 'committed');
  return [new WeakRef(txn), new WeakRef(cursor)];
}

const readerReferences = leakReadTransactionAndCursor();
let readerLimitError: unknown;
try {
  env.beginTxn({ readOnly: true });
} catch (error) {
  readerLimitError = error;
}
if (!(readerLimitError instanceof Error)) {
  throw new Error('Expected the leaked reader to exhaust maxReaders=1');
}
assertMatch(readerLimitError.message, /readers|full|-30790/i);
strictEqual(
  (readerLimitError as Error & { code?: number }).code,
  -30790,
);
await collect(
  readerReferences,
  () => {
    const counts = getNativeBindingCounts(env);
    return counts.transactions === 0 && counts.cursors === 0;
  },
  'leaked read transaction and cursor cleanup',
);
const replacementRead = env.beginTxn({ readOnly: true });
strictEqual(replacementRead.getString(dbi, 'committed'), 'value');
replacementRead.abort();

function leakDbiAlias(): WeakRef<object> {
  const alias = env.openDbi({ name: 'ownership' });
  return new WeakRef(alias);
}

const dbiReference = leakDbiAlias();
strictEqual(getNativeBindingCounts(env).dbis, baseline.dbis + 1);
await collect(
  [dbiReference],
  () => getNativeBindingCounts(env).dbis === baseline.dbis,
  'leaked DBI alias cleanup',
);
const aliasRead = env.beginTxn({ readOnly: true });
strictEqual(aliasRead.getString(dbi, 'committed'), 'value');
aliasRead.abort();

let pendingDbi: ReturnType<Env['openDbi']> | undefined;
function leakPendingDbiTransaction(): WeakRef<object> {
  const txn = env.beginTxn();
  pendingDbi = env.openDbi({
    name: 'pending-finalizer',
    create: true,
    txn,
  });
  return new WeakRef(txn);
}

const pendingTxnReference = leakPendingDbiTransaction();
strictEqual(getNativeBindingCounts(env).pendingDbis, 1);
await collect(
  [pendingTxnReference],
  () => {
    const counts = getNativeBindingCounts(env);
    return counts.transactions === 0 && counts.pendingDbis === 0 &&
      counts.dbis === baseline.dbis;
  },
  'leaked caller transaction pending DBI cleanup',
);
expectClosed(() => pendingDbi?.close());
const replacementDbi = env.openDbi({
  name: 'pending-finalizer',
  create: true,
});
const replacementDbiTxn = env.beginTxn();
replacementDbiTxn.putString(replacementDbi, 'replacement', 'valid');
replacementDbiTxn.commit();
replacementDbi.close();

function leakSamePathWrapper(): readonly WeakRef<object>[] {
  const wrapper = new Env();
  wrapper.open({ path });
  const transaction = wrapper.beginTxn({ readOnly: true });
  return [new WeakRef(wrapper), new WeakRef(transaction)];
}

const environmentReferences = leakSamePathWrapper();
strictEqual(getNativeEnvironmentDetails(env).refCount, 2);
await collect(
  environmentReferences,
  () => {
    const counts = getNativeBindingCounts(env);
    return getNativeEnvironmentDetails(env).refCount === 1 &&
      counts.environments === 1 && counts.transactions === 0;
  },
  'leaked environment wrapper cleanup',
);

const explicitCursorTxn = env.beginTxn({ readOnly: true });
const explicitCursor = new Cursor(explicitCursorTxn, dbi);
explicitCursor.close();
expectClosed(() => explicitCursor.close());
explicitCursorTxn.abort();
expectClosed(() => explicitCursorTxn.abort());

const explicitDbi = env.openDbi({ name: 'ownership' });
explicitDbi.close();
expectClosed(() => explicitDbi.close());

dbi.close();
env.close();
expectClosed(() => env.close());
console.log('gc-ownership-ok');
