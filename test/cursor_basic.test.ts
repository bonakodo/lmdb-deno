import { assertEquals, assertThrows } from './_support/assertions.ts';
import { readDoubleNative } from './_support/bytes.ts';
import type {
  CursorContract,
  DbiContract,
  EnvContract,
  KeyType,
  LmdbModule,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const MAX_DB_SIZE = 256 * 1024 * 1024;
const BASIC_TOTAL = 50;
const NUMERIC_TOTAL = 1_000;
const BASIC_KEYS_IN_CURSOR_ORDER = Array.from(
  { length: BASIC_TOTAL },
  (_value, count) => `hello_${count.toString(16)}`,
).sort();
const utf16LeDecoder = new TextDecoder('utf-16le');

type StringCursorWithKeyOverride =
  & Omit<CursorContract<string>, 'goToKey'>
  & {
    goToKey(key: string | Uint8Array, options?: KeyType): string | null;
  };

function encodeUtf16LeWithTerminator(value: string): Uint8Array {
  const encoded = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(encoded.buffer);
  for (let index = 0; index < value.length; index++) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return encoded;
}

function captureError(operation: () => unknown): Error & { code?: number } {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected operation to throw');
}

async function withBasicStringCursor(
  Env: LmdbModule['Env'],
  Cursor: LmdbModule['Cursor'],
  path: string,
  body: (cursor: StringCursorWithKeyOverride) => void | Promise<void>,
): Promise<void> {
  const env = new Env();
  let dbi: DbiContract | undefined;
  let setupTxn: TxnContract | undefined;
  let readTxn: TxnContract | undefined;
  let cursor: CursorContract<string> | undefined;

  await withCleanup(
    async () => {
      env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
      dbi = env.openDbi({ name: 'cursor_verybasic', create: true });
      setupTxn = env.beginTxn();
      for (let count = 0; count < BASIC_TOTAL; count++) {
        const key = `hello_${count.toString(16)}`;
        setupTxn.putString(dbi, key, `${key}_data`);
      }
      setupTxn.commit();
      setupTxn = undefined;

      readTxn = env.beginTxn({ readOnly: true });
      cursor = new Cursor(readTxn, dbi);
      await body(cursor as StringCursorWithKeyOverride);
    },
    [
      () => cursor?.close(),
      () => readTxn?.abort(),
      () => setupTxn?.abort(),
      () => dbi?.close(),
      () => env.close(),
    ],
  );
}

async function withNumericCursor(
  Env: LmdbModule['Env'],
  Cursor: LmdbModule['Cursor'],
  path: string,
  body: (
    env: EnvContract,
    cursor: CursorContract<number>,
  ) => void | Promise<void>,
): Promise<void> {
  const env = new Env();
  let dbi: DbiContract | undefined;
  let setupTxn: TxnContract | undefined;
  let txn: TxnContract | undefined;
  let cursor: CursorContract<number> | undefined;

  await withCleanup(
    async () => {
      env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
      dbi = env.openDbi({
        name: 'mydb5',
        create: true,
        dupSort: false,
        keyIsUint32: true,
      });
      setupTxn = env.beginTxn();
      for (let count = 0; count < NUMERIC_TOTAL; count++) {
        const value = new Uint8Array(new Float64Array([count]).buffer);
        setupTxn.putBinary(dbi, count, value);
      }
      setupTxn.commit();
      setupTxn = undefined;

      txn = env.beginTxn();
      cursor = new Cursor<number>(txn, dbi);
      await body(env, cursor);
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

Deno.test('cursor navigates to every exact string key', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withBasicStringCursor(Env, Cursor, path, (cursor) => {
      let count: number;
      for (count = 0; count < BASIC_TOTAL; count++) {
        const expectedKey = `hello_${count.toString(16)}`;
        assertEquals(cursor.goToKey(expectedKey), expectedKey);
      }
      assertEquals(count, BASIC_TOTAL);

      let key = cursor.goToFirst();
      for (let index = 0; index < BASIC_TOTAL; index++) {
        const expectedKey = BASIC_KEYS_IN_CURSOR_ORDER[index];
        assertEquals(key, expectedKey);
        if (key === null) throw new Error('Expected string key');
        assertEquals(cursor.goToKey(key), expectedKey);

        const next = cursor.goToNext();
        assertEquals(next, BASIC_KEYS_IN_CURSOR_ORDER[index + 1] ?? null);
        key = next;
      }
    })
  );
});

Deno.test('cursor accepts a binary key-format override', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withBasicStringCursor(Env, Cursor, path, (cursor) => {
      let count: number;
      for (count = 0; count < BASIC_TOTAL; count++) {
        const expectedKey = `hello_${count.toString(16)}`;
        const binaryKey = encodeUtf16LeWithTerminator(expectedKey);
        const key = cursor.goToKey(binaryKey);
        assertEquals(key, expectedKey);
        assertEquals(utf16LeDecoder.decode(binaryKey), `${key}\0`);
      }
      assertEquals(count, BASIC_TOTAL);

      let key = cursor.goToFirst();
      for (let index = 0; index < BASIC_TOTAL; index++) {
        const expectedKey = BASIC_KEYS_IN_CURSOR_ORDER[index];
        assertEquals(key, expectedKey);
        if (key === null) throw new Error('Expected string key');
        const binaryKey = encodeUtf16LeWithTerminator(key);
        assertEquals(
          cursor.goToKey(binaryKey, { keyIsBuffer: true }),
          expectedKey,
        );

        const next = cursor.goToNext();
        assertEquals(next, BASIC_KEYS_IN_CURSOR_ORDER[index + 1] ?? null);
        key = next;
      }
    })
  );
});

Deno.test('cursor iterates numeric keys and binary number values', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withNumericCursor(Env, Cursor, path, (_env, cursor) => {
      cursor.goToKey(40);
      let callbackCount = 0;
      let callbackValue: Uint8Array | undefined;
      const currentAtForty = cursor.getCurrentBinary((key, value) => {
        callbackCount++;
        callbackValue = value;
        assertEquals(key, 40);
        assertEquals(readDoubleNative(value), 40);
      });
      assertEquals(callbackCount, 1);
      assertEquals(currentAtForty === callbackValue, true);
      if (currentAtForty === null) throw new Error('Expected binary data');
      assertEquals(readDoubleNative(currentAtForty), 40);

      const first = cursor.goToKey(0);
      assertEquals(first, 0);
      for (let index = 0; index < NUMERIC_TOTAL; index++) {
        callbackCount = 0;
        callbackValue = undefined;
        const current = cursor.getCurrentBinary((key, value) => {
          callbackCount++;
          callbackValue = value;
          assertEquals(key, index);
          assertEquals(readDoubleNative(value), index);
        });
        assertEquals(callbackCount, 1);
        assertEquals(current === callbackValue, true);
        if (current === null) throw new Error('Expected binary data');
        assertEquals(readDoubleNative(current), index);

        const next = cursor.goToNext();
        assertEquals(next, index + 1 < NUMERIC_TOTAL ? index + 1 : null);
      }
    })
  );
});

Deno.test('cursor exposes unsafe numeric binary values', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withNumericCursor(Env, Cursor, path, (env, cursor) => {
      cursor.goToKey(40);
      let callbackCount = 0;
      let callbackValue: Uint8Array | undefined;
      const currentAtForty = cursor.getCurrentBinaryUnsafe((key, value) => {
        callbackCount++;
        callbackValue = value;
        if (!(value.buffer instanceof ArrayBuffer)) {
          throw new TypeError('Expected an ArrayBuffer-backed view');
        }
        try {
          assertEquals(key, 40);
          assertEquals(readDoubleNative(value), 40);
        } finally {
          env.detachBuffer(value.buffer);
        }
      });
      assertEquals(callbackCount, 1);
      assertEquals(currentAtForty === callbackValue, true);

      const first = cursor.goToKey(0);
      assertEquals(first, 0);
      for (let index = 0; index < NUMERIC_TOTAL; index++) {
        callbackCount = 0;
        callbackValue = undefined;
        const current = cursor.getCurrentBinaryUnsafe((key, value) => {
          callbackCount++;
          callbackValue = value;
          if (!(value.buffer instanceof ArrayBuffer)) {
            throw new TypeError('Expected an ArrayBuffer-backed view');
          }
          try {
            assertEquals(key, index);
            assertEquals(readDoubleNative(value), index);
          } finally {
            env.detachBuffer(value.buffer);
          }
        });
        assertEquals(callbackCount, 1);
        assertEquals(current === callbackValue, true);

        const next = cursor.goToNext();
        assertEquals(next, index + 1 < NUMERIC_TOTAL ? index + 1 : null);
      }
    })
  );
});

Deno.test('cursor reads the first and last numeric entries', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withNumericCursor(Env, Cursor, path, (_env, cursor) => {
      const first = cursor.goToFirst();
      assertEquals(first, 0);
      let firstCallbackCount = 0;
      const firstValue = cursor.getCurrentBinary((key, value) => {
        firstCallbackCount++;
        assertEquals(key, 0);
        assertEquals(readDoubleNative(value), 0);
      });
      assertEquals(firstCallbackCount, 1);
      if (firstValue === null) throw new Error('Expected binary data');
      assertEquals(readDoubleNative(firstValue), 0);

      assertEquals(cursor.goToLast(), NUMERIC_TOTAL - 1);
      let lastCallbackCount = 0;
      const lastValue = cursor.getCurrentBinary((key, value) => {
        lastCallbackCount++;
        assertEquals(key, NUMERIC_TOTAL - 1);
        assertEquals(readDoubleNative(value), NUMERIC_TOTAL - 1);
      });
      assertEquals(lastCallbackCount, 1);
      if (lastValue === null) throw new Error('Expected binary data');
      assertEquals(readDoubleNative(lastValue), NUMERIC_TOTAL - 1);
    })
  );
});

Deno.test('cursor supports reverse, range, typed, delete, and terminal operations', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    let cursor: CursorContract<string> | undefined;

    return withCleanup(
      () => {
        env.open({ path, maxDbs: 4, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({ name: 'cursor-complete', create: true });
        txn = env.beginTxn();
        txn.putString(dbi, 'a', 'alpha');
        txn.putString(dbi, 'b', 'bravo');
        txn.putString(dbi, 'c', 'charlie');
        txn.putNumber(dbi, 'number', 42.5);
        txn.putBoolean(dbi, 'boolean', false);
        txn.putString(dbi, 'empty-string', '');
        txn.putBinary(dbi, 'empty-binary', new Uint8Array());

        cursor = new Cursor(txn, dbi);
        assertEquals(cursor.goToFirst(), 'a');
        assertEquals(cursor.goToNext(), 'b');
        assertEquals(cursor.goToPrev(), 'a');
        assertEquals(cursor.goToRange('bz'), 'c');
        assertEquals(cursor.goToLast(), 'number');

        assertEquals(cursor.goToKey('number'), 'number');
        let callbackCount = 0;
        assertEquals(
          cursor.getCurrentNumber((key, value) => {
            callbackCount++;
            assertEquals(key, 'number');
            assertEquals(value, 42.5);
          }),
          42.5,
        );
        assertEquals(callbackCount, 1);

        assertEquals(cursor.goToKey('boolean'), 'boolean');
        callbackCount = 0;
        assertEquals(
          cursor.getCurrentBoolean((key, value) => {
            callbackCount++;
            assertEquals(key, 'boolean');
            assertEquals(value, false);
          }),
          false,
        );
        assertEquals(callbackCount, 1);

        assertEquals(cursor.goToKey('empty-string'), 'empty-string');
        assertEquals(cursor.getCurrentString(), '');
        assertEquals(cursor.getCurrentStringUnsafe(), '');

        assertEquals(cursor.goToKey('empty-binary'), 'empty-binary');
        const empty = cursor.getCurrentBinary();
        assertEquals(empty, new Uint8Array());

        const binaryWithIgnoredCallback = (
          cursor.getCurrentBinary as unknown as (
            callback: unknown,
          ) => Uint8Array | null
        )({});
        assertEquals(binaryWithIgnoredCallback, new Uint8Array());
        const unsafeWithIgnoredCallback = (
          cursor.getCurrentBinaryUnsafe as unknown as (
            callback: unknown,
          ) => Uint8Array | null
        )('not a callback');
        assertEquals(unsafeWithIgnoredCallback, new Uint8Array());

        assertEquals(cursor.goToKey('number'), 'number');
        assertEquals(
          (cursor.getCurrentNumber as unknown as (value: unknown) => number)(
            null,
          ),
          42.5,
        );
        assertEquals(cursor.goToKey('boolean'), 'boolean');
        assertEquals(
          (cursor.getCurrentBoolean as unknown as (value: unknown) => boolean)(
            1,
          ),
          false,
        );
        assertEquals(cursor.goToKey('empty-string'), 'empty-string');
        assertEquals(
          (cursor.getCurrentString as unknown as (value: unknown) => string)(
            {},
          ),
          '',
        );
        assertEquals(
          (
            cursor.getCurrentStringUnsafe as unknown as (
              value: unknown,
            ) => string
          )([]),
          '',
        );

        assertEquals(cursor.goToKey('b'), 'b');
        const goToKey = cursor.goToKey as unknown as (
          ...args: unknown[]
        ) => unknown;
        assertThrows(
          () => goToKey.call(cursor),
          /goToKey.*incorrect number/i,
        );
        assertThrows(
          () => goToKey.call(cursor, 'c', {}, 'extra'),
          /goToKey.*incorrect number/i,
        );
        assertEquals(cursor.getCurrentString(), 'bravo');

        const goToRange = cursor.goToRange as unknown as (
          ...args: unknown[]
        ) => unknown;
        assertThrows(
          () => goToRange.call(cursor),
          /goToRange.*incorrect number/i,
        );
        assertThrows(
          () => goToRange.call(cursor, 'c', {}, 'extra'),
          /goToRange.*incorrect number/i,
        );
        assertEquals(cursor.getCurrentString(), 'bravo');

        const del = cursor.del as unknown as (...args: unknown[]) => unknown;
        assertThrows(
          () => del.call(cursor, {}, {}),
          /cursor\.del.*incorrect number/i,
        );
        assertThrows(
          () => del.call(cursor, undefined),
          /cursor\.del.*invalid options/i,
        );
        assertEquals(cursor.getCurrentString(), 'bravo');

        assertEquals(cursor.goToKey('c'), 'c');
        cursor.del();
        assertEquals(cursor.goToKey('c'), null);

        cursor.close();
        cursor = undefined;
        txn.commit();
        txn = undefined;

        const readTxn = env.beginTxn({ readOnly: true });
        const readCursor = new Cursor(readTxn, dbi);
        assertEquals(readCursor.goToKey('a'), 'a');
        const readonlyError = captureError(() => readCursor.del());
        assertEquals(readonlyError.code, 13);
        readTxn.abort();
        assertThrows(() => readCursor.goToFirst(), /closed|ended/i);
        readCursor.close();
        assertThrows(() => readCursor.close(), /closed/i);
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

Deno.test('cursor rejects operations after its database wrapper closes', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let alias: DbiContract | undefined;
    let txn: TxnContract | undefined;
    let cursor: CursorContract<string> | undefined;

    return withCleanup(
      () => {
        env.open({ path, maxDbs: 4, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({ name: 'cursor-dbi-lifetime', create: true });
        alias = env.openDbi({ name: 'cursor-dbi-lifetime' });
        txn = env.beginTxn();
        txn.putString(dbi, 'key', 'value');
        txn.commit();

        txn = env.beginTxn({ readOnly: true });
        cursor = new Cursor(txn, dbi);
        assertEquals(cursor.goToFirst(), 'key');
        dbi.close();
        dbi = undefined;

        assertThrows(() => cursor?.goToFirst(), /database.*closed/i);
        cursor.close();
        cursor = undefined;
        txn.abort();
        txn = undefined;
      },
      [
        () => cursor?.close(),
        () => txn?.abort(),
        () => dbi?.close(),
        () => alias?.close(),
        () => env.close(),
      ],
    );
  });
});
