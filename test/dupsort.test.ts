import {
  assertEquals,
  assertExists,
  assertThrows,
} from './_support/assertions.ts';
import type {
  CursorContract,
  DbiContract,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const MAX_DB_SIZE = 256 * 1024 * 1024;
const ID = new TextEncoder().encode('id');

function readUint32Le(value: Uint8Array): number {
  return new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getUint32(0, true);
}

Deno.test('dupsort accepts duplicate values with different lengths', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let setupTxn: TxnContract | undefined;
    let readTxn: TxnContract | undefined;
    let cursor: CursorContract<Uint8Array> | undefined;
    let callbackCount = 0;

    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({
          name: 'testdb_dupsort',
          create: true,
          dupSort: true,
          dupFixed: false,
          keyIsBuffer: true,
        });
        setupTxn = env.beginTxn();
        setupTxn.putBinary(dbi, ID, new Uint8Array(8));
        setupTxn.putBinary(dbi, ID, new Uint8Array(4));
        setupTxn.commit();
        setupTxn = undefined;

        readTxn = env.beginTxn({ readOnly: true });
        cursor = new Cursor<Uint8Array>(readTxn, dbi);
        assertEquals(cursor.goToKey(ID), ID);
        cursor.getCurrentBinary((key, value) => {
          callbackCount++;
          assertEquals(key, ID);
          assertEquals(value.byteLength, 4);
        });
        assertEquals(cursor.goToNext(), ID);
        cursor.getCurrentBinary((key, value) => {
          callbackCount++;
          assertEquals(key, ID);
          assertEquals(value.byteLength, 8);
        });
        assertEquals(callbackCount, 2);
      },
      [
        () => cursor?.close(),
        () => readTxn?.abort(),
        () => setupTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('dupsort deletes only exact duplicate values', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    let cursor: CursorContract<Uint8Array> | undefined;

    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({
          name: 'testdb_dupsort',
          create: true,
          dupSort: true,
          dupFixed: false,
          keyIsBuffer: true,
        });
        txn = env.beginTxn();
        for (const key of [100, 101, 102]) {
          for (let value = 1; value <= 4; value++) {
            txn.putNumber(dbi, key, value);
          }
        }
        txn.commit();
        txn = undefined;

        txn = env.beginTxn();
        txn.del(dbi, 101, 2);
        txn.del(dbi, 101, 4);
        txn.del(dbi, 102, 1);
        txn.del(dbi, 102, 3);
        txn.commit();
        txn = undefined;

        txn = env.beginTxn({ readOnly: true });
        cursor = new Cursor<Uint8Array>(txn, dbi);
        const expectedKeys = [100, 100, 100, 100, 101, 101, 102, 102];
        let key = cursor.goToFirst();
        for (const expectedKey of expectedKeys) {
          assertExists(key);
          assertEquals(readUint32Le(key), expectedKey);
          key = cursor.goToNext();
        }
        assertEquals(key, null);
      },
      [
        () => cursor?.close(),
        () => txn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('dupsort put flags and delete overloads preserve exact values', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({
          name: 'dupsort-overloads',
          create: true,
          dupSort: true,
          keyIsBuffer: true,
        });
        txn = env.beginTxn();
        const key = new Uint8Array([1]);
        const first = new Uint8Array([10]);
        const second = new Uint8Array([20]);
        txn.putBinary(dbi, key, first);
        txn.putBinary(dbi, key, second);

        txn.putBinary(dbi, key, second, { noDupData: 'yes' as never });
        assertThrows(
          () => txn?.putBinary(dbi!, key, second, { noDupData: true }),
          /Key\/data pair already exists|MDB_KEYEXIST/i,
        );

        txn.del(dbi, key, second, { keyIsBuffer: true });
        txn.del(dbi, key, {});
        assertEquals(txn.getBinary(dbi, key), null);
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});
