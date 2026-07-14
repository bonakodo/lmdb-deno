import { match as assertMatch } from 'node:assert/strict';
import { Cursor, Env } from '../../mod.ts';

const firstPath = Deno.args[0];
const secondPath = Deno.args[1];
if (!firstPath || !secondPath) {
  throw new Error('Expected two environment paths');
}

function expectOwnershipError(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertMatch(error.message, /different environment/i);
    return;
  }
  throw new Error('Expected a cross-environment ownership error');
}

const first = new Env();
const second = new Env();
first.open({ path: firstPath, maxDbs: 4 });
second.open({ path: secondPath, maxDbs: 4 });
const firstDbi = first.openDbi({ name: 'first', create: true });
const secondDbi = second.openDbi({ name: 'second', create: true });
const firstTxn = first.beginTxn();

expectOwnershipError(() =>
  second.openDbi({ name: 'wrong', create: true, txn: firstTxn })
);
expectOwnershipError(() => firstTxn.getString(secondDbi, 'key'));
expectOwnershipError(() => firstTxn.getStringUnsafe(secondDbi, 'key'));
expectOwnershipError(() => firstTxn.getBinary(secondDbi, 'key'));
expectOwnershipError(() => firstTxn.getBinaryUnsafe(secondDbi, 'key'));
expectOwnershipError(() => firstTxn.getNumber(secondDbi, 'key'));
expectOwnershipError(() => firstTxn.getBoolean(secondDbi, 'key'));
expectOwnershipError(() => firstTxn.putString(secondDbi, 'key', 'value'));
expectOwnershipError(() =>
  firstTxn.putBinary(secondDbi, 'key', new Uint8Array([1]))
);
expectOwnershipError(() => firstTxn.putNumber(secondDbi, 'key', 1));
expectOwnershipError(() => firstTxn.putBoolean(secondDbi, 'key', true));
expectOwnershipError(() => firstTxn.del(secondDbi, 'key'));
expectOwnershipError(() => secondDbi.stat(firstTxn));
expectOwnershipError(() => secondDbi.drop({ txn: firstTxn }));
expectOwnershipError(() => new Cursor(firstTxn, secondDbi));

firstTxn.putString(firstDbi, 'safe', 'value');
firstTxn.commit();
firstDbi.close();
secondDbi.close();
second.close();
first.close();
console.log('ownership-ok');
