import { match as assertMatch } from 'node:assert/strict';
import { Env } from '../../mod.ts';
import { getNativeHandles } from '../../src/internal/native_test_access.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected an environment path');

function expectClosed(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertMatch(error.message, /closed|drop|invalid/i);
    return;
  }
  throw new Error('Expected invalidated DBI rejection');
}

const env = new Env();
env.open({ path, maxDbs: 4 });
const first = env.openDbi({ name: 'shared', create: true });
const second = env.openDbi({ name: 'shared' });

first.close();
const writeTxn = env.beginTxn();
writeTxn.putString(second, 'key', 'value');
writeTxn.commit();

const third = env.openDbi({ name: 'shared' });
const beforeDropTxn = env.beginTxn({ readOnly: true });
const droppedHandle = getNativeHandles(beforeDropTxn, third).dbiHandle;
beforeDropTxn.abort();
second.drop();
expectClosed(() => third.close());

const replacement = env.openDbi({ name: 'replacement', create: true });
const replacementTxn = env.beginTxn();
if (getNativeHandles(replacementTxn, replacement).dbiHandle !== droppedHandle) {
  throw new Error('LMDB did not reuse the dropped DBI slot under test');
}
expectClosed(() => replacementTxn.putString(third, 'stale', 'bad'));
replacementTxn.putString(replacement, 'safe', 'good');
replacementTxn.commit();

replacement.close();
env.close();
console.log('alias-lifecycle-ok');
