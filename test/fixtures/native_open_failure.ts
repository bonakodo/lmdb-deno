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

const failed = new Env();
assertMatch(
  captureError(() => failed.open({ path, readOnly: true })).message,
  /lmdb|no such file/i,
);
assertMatch(captureError(() => failed.open({ path })).message, /closed/i);
assertMatch(captureError(() => failed.close()).message, /closed/i);

const fresh = new Env();
fresh.open({ path });
fresh.close();
console.log('open-failure-ok');
