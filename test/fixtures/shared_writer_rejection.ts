import { match as assertMatch } from 'node:assert/strict';
import { Env } from '../../mod.ts';

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

const first = new Env();
const second = new Env();
first.open({ path });
second.open({ path });

const firstTxn = first.beginTxn();
const error = captureError(() => second.beginTxn());
assertMatch(error.message, /already opened a write transaction/i);
firstTxn.abort();

const secondTxn = second.beginTxn();
secondTxn.commit();
const thirdTxn = first.beginTxn();
thirdTxn.abort();
second.close();
first.close();
console.log('writer-ok');
