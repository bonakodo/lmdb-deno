import { match as assertMatch } from 'node:assert/strict';
import { Env } from '../../mod.ts';
import { getNativeHandles } from '../../src/internal/native_test_access.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected an environment path');

function expectRejected(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertMatch(error.message, /closed|pending|abort|transaction/i);
    return;
  }
  throw new Error('Expected stale pending DBI rejection');
}

const env = new Env();
env.open({ path, maxDbs: 4 });

const shared = env.openDbi({ name: 'shared', create: true });
const seedTxn = env.beginTxn();
seedTxn.putString(shared, 'seed', 'value');
seedTxn.commit();
const openingRead = env.beginTxn({ readOnly: true });
const pendingRead = env.openDbi({ name: 'shared', txn: openingRead });
const unrelatedRead = env.beginTxn({ readOnly: true });
expectRejected(() => unrelatedRead.getString(pendingRead, 'seed'));
unrelatedRead.abort();
openingRead.commit();
const promotedRead = env.beginTxn({ readOnly: true });
if (promotedRead.getString(pendingRead, 'seed') !== 'value') {
  throw new Error('Committed read-transaction DBI was not promoted');
}
promotedRead.abort();
pendingRead.close();
shared.close();

const abortedTxn = env.beginTxn();
const stale = env.openDbi({ name: 'aborted-a', create: true, txn: abortedTxn });
const staleHandle = getNativeHandles(abortedTxn, stale).dbiHandle;
stale.stat(abortedTxn);
abortedTxn.abort();

const replacement = env.openDbi({ name: 'replacement-b', create: true });
const writeTxn = env.beginTxn();
if (getNativeHandles(writeTxn, replacement).dbiHandle !== staleHandle) {
  throw new Error('LMDB did not reuse the aborted DBI slot under test');
}
expectRejected(() => writeTxn.putString(stale, 'stale', 'must-not-write'));
writeTxn.putString(replacement, 'safe', 'replacement-value');
writeTxn.commit();

const committedTxn = env.beginTxn();
const promoted = env.openDbi({
  name: 'committed-c',
  create: true,
  txn: committedTxn,
});
committedTxn.putString(promoted, 'key', 'committed-value');
committedTxn.commit();

const readTxn = env.beginTxn({ readOnly: true });
if (readTxn.getString(replacement, 'safe') !== 'replacement-value') {
  throw new Error('Stale DBI corrupted its replacement slot');
}
if (readTxn.getString(promoted, 'key') !== 'committed-value') {
  throw new Error('Committed pending DBI was not promoted');
}
readTxn.abort();

promoted.close();
replacement.close();
env.close();
console.log('pending-slot-ok');
