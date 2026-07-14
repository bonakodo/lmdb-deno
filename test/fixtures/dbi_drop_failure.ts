import { match as assertMatch } from 'node:assert/strict';
import { Env } from '../../mod.ts';
import { swapNativeDbiHandle } from '../../src/internal/native_test_access.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected an environment path');

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected operation to throw');
}

const env = new Env();
env.open({ path, maxDbs: 2 });
const dbi = env.openDbi({ name: 'drop-failure', create: true });

const original = swapNativeDbiHandle(dbi, 0xffff_ffff);
const internalError = captureError(() => dbi.drop());
assertMatch(internalError.message, /bad.*dbi|invalid/i);
swapNativeDbiHandle(dbi, original);

const afterFailure = env.beginTxn();
afterFailure.abort();

const callerTxn = env.beginTxn();
swapNativeDbiHandle(dbi, 0xffff_ffff);
const callerError = captureError(() => dbi.drop({ txn: callerTxn }));
assertMatch(callerError.message, /bad.*dbi|invalid/i);
swapNativeDbiHandle(dbi, original);
callerTxn.putString(dbi, 'safe', 'value');
callerTxn.commit();

dbi.close();
env.close();
console.log('drop-failure-ok');
