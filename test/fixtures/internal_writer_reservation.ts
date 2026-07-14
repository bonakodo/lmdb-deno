import { match as assertMatch } from 'node:assert/strict';
import { Env } from '../../mod.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected an environment path');

const SECOND_WRITE_TXN_ERROR = /already opened a write transaction|second one/i;

function expectWriterRejection(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertMatch(error.message, SECOND_WRITE_TXN_ERROR);
    return;
  }
  throw new Error('Expected internal writer reservation rejection');
}

const env = new Env();
env.open({ path, maxDbs: 4 });
const existing = env.openDbi({ name: 'existing', create: true });
const writer = env.beginTxn();

expectWriterRejection(() =>
  env.openDbi({ name: 'blocked-create', create: true })
);
expectWriterRejection(() => existing.drop());

const callerOwned = env.openDbi({
  name: 'caller-owned',
  create: true,
  txn: writer,
});
writer.putString(callerOwned, 'key', 'value');
writer.commit();

callerOwned.close();
existing.close();
env.close();
console.log('writer-reservation-ok');
