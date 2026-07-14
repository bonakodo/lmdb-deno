import { assertEquals } from '../_support/assertions.ts';
import { bytes } from '../_support/bytes.ts';
import type {
  CursorContract,
  DbiContract,
  TxnContract,
} from '../_support/contract.ts';
import { withCleanup } from '../_support/lifecycle.ts';
import { loadSubject } from '../_support/subject.ts';

const [path] = Deno.args;
if (!path) throw new Error('Usage: gc_reader.ts <path>');

const expectedKey = new TextEncoder().encode('822285ee315d2b04');
const expectedValue = bytes(
  'ec65d632d9168c33350ed31a30848d01e95172931e90984c218ef6b08c1fa90a',
);
const { Cursor, Env } = await loadSubject();
const env = new Env();
let dbi: DbiContract | undefined;
let setupTxn: TxnContract | undefined;
let readTxn: TxnContract | undefined;
let cursor: CursorContract<Uint8Array> | undefined;
let actualKey: Uint8Array | undefined;
let actualValue: Uint8Array | undefined;
let callbackCount = 0;
let envClosed = false;

await withCleanup(
  () => {
    env.open({ path, maxDbs: 12, mapSize: 256 * 1024 * 1024 });
    dbi = env.openDbi({
      name: 'testfree',
      create: true,
      keyIsBuffer: true,
    });
    setupTxn = env.beginTxn();
    setupTxn.putBinary(dbi, expectedKey, expectedValue);
    setupTxn.commit();
    setupTxn = undefined;

    readTxn = env.beginTxn();
    cursor = new Cursor<Uint8Array>(readTxn, dbi);
    assertEquals(cursor.goToFirst(), expectedKey);
    cursor.getCurrentBinary((key, value) => {
      callbackCount++;
      if (!(key instanceof Uint8Array)) {
        throw new TypeError('Expected a Uint8Array key');
      }
      actualKey = new Uint8Array(key);
      actualValue = new Uint8Array(value);
    });
    assertEquals(callbackCount, 1);

    cursor.close();
    cursor = undefined;
    readTxn.abort();
    readTxn = undefined;
    dbi.close();
    dbi = undefined;
    env.close();
    envClosed = true;

    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (typeof gc !== 'function') throw new Error('gc is not exposed');
    for (let index = 0; index < 4; index++) gc();

    assertEquals(actualKey, expectedKey);
    assertEquals(actualValue, expectedValue);
    console.log('gc-ok');
  },
  [
    () => cursor?.close(),
    () => readTxn?.abort(),
    () => setupTxn?.abort(),
    () => dbi?.close(),
    () => {
      if (!envClosed) env.close();
    },
  ],
);
