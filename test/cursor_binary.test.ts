import { assertEquals } from './_support/assertions.ts';
import type {
  CursorContract,
  DbiContract,
  LmdbModule,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const MAX_DB_SIZE = 256 * 1024 * 1024;
const BINARY_TOTAL = 1_000;
const PADDING = '000000000';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function paddedKey(count: number): string {
  return `${PADDING}${count}`.slice(-PADDING.length);
}

function expand(value: string): string {
  let expanded = `(${value})`;
  for (let count = 0; count < 5; count++) expanded += expanded;
  return expanded;
}

function decodeBytes(value: string | number | Uint8Array): string {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('Expected a Uint8Array key');
  }
  return decoder.decode(value);
}

function populateBinaryDatabase(
  txn: TxnContract,
  dbi: DbiContract,
): void {
  for (let count = 0; count < BINARY_TOTAL; count++) {
    const key = paddedKey(count);
    txn.putBinary(dbi, encoder.encode(key), encoder.encode(expand(key)));
  }
}

async function seedBinaryDatabase(
  Env: LmdbModule['Env'],
  path: string,
): Promise<void> {
  const env = new Env();
  let dbi: DbiContract | undefined;
  let txn: TxnContract | undefined;

  await withCleanup(
    () => {
      env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
      dbi = env.openDbi({
        name: 'cursorbinkeydata',
        create: true,
        keyIsBuffer: true,
      });
      txn = env.beginTxn();
      populateBinaryDatabase(txn, dbi);
      txn.commit();
      txn = undefined;
    },
    [() => txn?.abort(), () => dbi?.close(), () => env.close()],
  );
}

async function withBinaryCursor(
  Env: LmdbModule['Env'],
  Cursor: LmdbModule['Cursor'],
  path: string,
  create: boolean,
  body: (cursor: CursorContract<Uint8Array>) => void | Promise<void>,
): Promise<void> {
  const env = new Env();
  let dbi: DbiContract | undefined;
  let setupTxn: TxnContract | undefined;
  let txn: TxnContract | undefined;
  let cursor: CursorContract<Uint8Array> | undefined;

  await withCleanup(
    async () => {
      env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
      dbi = env.openDbi({
        name: 'cursorbinkeydata',
        create,
        keyIsBuffer: true,
      });
      if (create) {
        setupTxn = env.beginTxn();
        populateBinaryDatabase(setupTxn, dbi);
        setupTxn.commit();
        setupTxn = undefined;
      }
      txn = env.beginTxn();
      cursor = new Cursor<Uint8Array>(txn, dbi);
      await body(cursor);
      cursor.close();
      cursor = undefined;
      txn.commit();
      txn = undefined;
    },
    [
      () => cursor?.close(),
      () => txn?.abort(),
      () => setupTxn?.abort(),
      () => dbi?.close(),
      () => env.close(),
    ],
  );
}

Deno.test('cursor iterates binary keys and values', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir(async (path) => {
    await withBinaryCursor(Env, Cursor, path, true, (cursor) => {
      const expectedAtForty = paddedKey(40);
      const keyAtForty = cursor.goToKey(encoder.encode(expectedAtForty));
      if (keyAtForty === null) throw new Error('Expected binary key');
      assertEquals(decodeBytes(keyAtForty), expectedAtForty);

      let callbackCount = 0;
      const currentAtForty = cursor.getCurrentBinary((key, value) => {
        callbackCount++;
        assertEquals(decodeBytes(key), expectedAtForty);
        assertEquals(decoder.decode(value), expand(expectedAtForty));
      });
      assertEquals(callbackCount, 1);
      if (currentAtForty === null) throw new Error('Expected binary value');
      assertEquals(decoder.decode(currentAtForty), expand(expectedAtForty));

      const first = cursor.goToFirst();
      if (first === null) throw new Error('Expected first binary key');
      assertEquals(decodeBytes(first), paddedKey(0));
      for (let index = 0; index < BINARY_TOTAL; index++) {
        const expectedKey = paddedKey(index);
        callbackCount = 0;
        const current = cursor.getCurrentBinary((currentKey, value) => {
          callbackCount++;
          assertEquals(typeof currentKey === 'string', false);
          assertEquals(decodeBytes(currentKey), expectedKey);
          assertEquals(decoder.decode(value), expand(expectedKey));
        });
        assertEquals(callbackCount, 1);
        if (current === null) throw new Error('Expected binary value');
        assertEquals(decoder.decode(current), expand(expectedKey));

        const next = cursor.goToNext();
        assertEquals(typeof next === 'string', false);
        if (index + 1 < BINARY_TOTAL) {
          if (next === null) throw new Error('Expected next binary key');
          assertEquals(decodeBytes(next), paddedKey(index + 1));
        } else {
          assertEquals(next, null);
        }
      }
    });
  });
});

Deno.test('cursor reads an existing binary-key database', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir(async (path) => {
    await seedBinaryDatabase(Env, path);
    await withBinaryCursor(Env, Cursor, path, false, (cursor) => {
      const expectedAtForty = paddedKey(40);
      const keyAtForty = cursor.goToKey(encoder.encode(expectedAtForty));
      if (keyAtForty === null) throw new Error('Expected binary key');
      assertEquals(decodeBytes(keyAtForty), expectedAtForty);

      let callbackCount = 0;
      const returnedValue = cursor.getCurrentBinary((key, value) => {
        callbackCount++;
        assertEquals(typeof key === 'string', false);
        assertEquals(decodeBytes(key), expectedAtForty);
        assertEquals(decoder.decode(value), expand(expectedAtForty));
      });
      assertEquals(callbackCount, 1);
      if (returnedValue === null) {
        throw new Error('Expected the current binary value');
      }
      assertEquals(decoder.decode(returnedValue), expand(expectedAtForty));

      const first = cursor.goToFirst();
      assertEquals(typeof first === 'string', false);
      if (first === null) throw new Error('Expected first binary key');
      assertEquals(decodeBytes(first), paddedKey(0));
      for (let index = 0; index < BINARY_TOTAL; index++) {
        const expectedKey = paddedKey(index);
        callbackCount = 0;
        const current = cursor.getCurrentBinary((currentKey, value) => {
          callbackCount++;
          assertEquals(decodeBytes(currentKey), expectedKey);
          assertEquals(decoder.decode(value), expand(expectedKey));
        });
        assertEquals(callbackCount, 1);
        if (current === null) throw new Error('Expected binary value');
        assertEquals(decoder.decode(current), expand(expectedKey));

        const next = cursor.goToNext();
        assertEquals(typeof next === 'string', false);
        if (index + 1 < BINARY_TOTAL) {
          if (next === null) throw new Error('Expected next binary key');
          assertEquals(decodeBytes(next), paddedKey(index + 1));
        } else {
          assertEquals(next, null);
        }
      }
    });
  });
});
