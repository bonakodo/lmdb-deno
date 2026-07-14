import { assertEquals } from './_support/assertions.ts';
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

Deno.test('dupfixed returns equal-size values from different source sizes', async () => {
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
          name: 'mydb7',
          create: true,
          dupSort: true,
          dupFixed: true,
          keyIsBuffer: true,
        });
        const value1 = new Uint8Array(4);
        new DataView(value1.buffer).setUint32(0, 100);
        const value2 = new Uint8Array(8);
        new DataView(value2.buffer).setUint32(0, 200);
        setupTxn = env.beginTxn();
        setupTxn.putBinary(dbi, ID, value1);
        setupTxn.putBinary(dbi, ID, value2);
        setupTxn.commit();
        setupTxn = undefined;

        readTxn = env.beginTxn({ readOnly: true });
        cursor = new Cursor<Uint8Array>(readTxn, dbi);
        assertEquals(cursor.goToKey(ID), ID);
        cursor.getCurrentBinary((key, value) => {
          callbackCount++;
          assertEquals(key, ID);
          assertEquals(value.byteLength, 8);
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
