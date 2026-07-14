import { match as assertMatch } from 'node:assert/strict';
import { Cursor, Env } from '../../mod.ts';

const [path, mode] = Deno.args;
if (!path || !['abort', 'commit', 'reset', 'write'].includes(mode)) {
  throw new Error(
    'Usage: cursor_terminal_lifecycle.ts <path> <abort|commit|reset|write>',
  );
}

function expectClosed(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertMatch(error.message, /closed|transaction|reset|cursor/i);
    return;
  }
  throw new Error('Expected a terminal cursor operation to fail');
}

const env = new Env();
env.open({ path, maxDbs: 2, mapSize: 32 * 1024 * 1024 });
const dbi = env.openDbi({ name: 'cursor-terminal', create: true });
const seed = env.beginTxn();
seed.putString(dbi, 'key', 'value');
seed.commit();

for (let iteration = 0; iteration < 250; iteration++) {
  const readOnly = mode !== 'write';
  const txn = env.beginTxn({ readOnly });
  const cursor = new Cursor(txn, dbi);
  if (cursor.goToFirst() !== 'key') throw new Error('Cursor was not usable');

  if (mode === 'abort') txn.abort();
  else if (mode === 'commit' || mode === 'write') txn.commit();
  else txn.reset();

  expectClosed(() => cursor.goToFirst());
  if (readOnly) {
    cursor.close();
    expectClosed(() => cursor.close());
  } else {
    expectClosed(() => cursor.close());
  }

  if (mode === 'reset') {
    txn.renew();
    expectClosed(() => cursor.goToFirst());
    txn.abort();
  }
}

dbi.close();
env.close();
console.log(`cursor-${mode}-ok`);
