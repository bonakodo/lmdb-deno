import { assertEquals, assertThrows } from './_support/assertions.ts';
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
const DUPLICATE_TOTAL = 50;
const STRING_TOTAL = 1_000;

async function withDuplicateCursor(
  Env: LmdbModule['Env'],
  Cursor: LmdbModule['Cursor'],
  path: string,
  body: (cursor: CursorContract<string>) => void | Promise<void>,
): Promise<void> {
  const env = new Env();
  let dbi: DbiContract | undefined;
  let setupTxn: TxnContract | undefined;
  let readTxn: TxnContract | undefined;
  let cursor: CursorContract<string> | undefined;

  await withCleanup(
    async () => {
      env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
      dbi = env.openDbi({
        name: 'cursor_dupsort',
        create: true,
        dupSort: true,
      });
      setupTxn = env.beginTxn();
      for (let count = 0; count < DUPLICATE_TOTAL; count++) {
        const key = `hello_${count.toString(16)}`;
        const data = `${key}_data`;
        const dataCount = (count % 4) + 1;
        for (let index = 0; index < dataCount; index++) {
          setupTxn.putString(dbi, key, `${data}${index}`);
        }
      }
      setupTxn.commit();
      setupTxn = undefined;

      readTxn = env.beginTxn({ readOnly: true });
      cursor = new Cursor(readTxn, dbi);
      await body(cursor);
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

async function withNumericStringCursor(
  Env: LmdbModule['Env'],
  Cursor: LmdbModule['Cursor'],
  path: string,
  body: (cursor: CursorContract<number>) => void | Promise<void>,
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
        name: 'cursorstrings',
        create: true,
        dupSort: true,
        keyIsUint32: true,
      });
      setupTxn = env.beginTxn();
      for (let count = 0; count < STRING_TOTAL; count++) {
        setupTxn.putString(dbi, count, count.toString());
      }
      setupTxn.commit();
      setupTxn = undefined;

      txn = env.beginTxn();
      cursor = new Cursor<number>(txn, dbi);
      await body(cursor);
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

Deno.test('dupsort cursor navigates exact keys and duplicate data', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withDuplicateCursor(Env, Cursor, path, (cursor) => {
      let count: number;
      for (count = 0; count < DUPLICATE_TOTAL; count++) {
        const expectedKey = `hello_${count.toString(16)}`;
        const expectedData = `${expectedKey}_data`;
        const dataCount = (count % 4) + 1;
        const key = cursor.goToRange(expectedKey);
        assertEquals(key, expectedKey);
        assertEquals(cursor.getCurrentString(), `${expectedData}0`);

        let duplicateCount = 0;
        let duplicateKey = cursor.goToFirstDup();
        for (let index = 0; index < dataCount; index++) {
          assertEquals(duplicateKey, expectedKey);
          assertEquals(
            cursor.getCurrentString(),
            `${expectedData}${index}`,
          );
          duplicateCount++;

          const next = cursor.goToNextDup();
          assertEquals(next, index + 1 < dataCount ? expectedKey : null);
          duplicateKey = next;
        }
        assertEquals(duplicateCount, dataCount);

        duplicateCount = 0;
        duplicateKey = cursor.goToDup(expectedKey, `${expectedData}0`);
        for (let index = 0; index < dataCount; index++) {
          assertEquals(duplicateKey, expectedKey);
          assertEquals(
            cursor.getCurrentString(),
            `${expectedData}${index}`,
          );
          duplicateCount++;

          const next = cursor.goToNextDup();
          assertEquals(next, index + 1 < dataCount ? expectedKey : null);
          duplicateKey = next;
        }
        assertEquals(duplicateCount, dataCount);
      }
      assertEquals(count, DUPLICATE_TOTAL);
    })
  );
});

Deno.test('cursor exposes unsafe string values for numeric keys', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withNumericStringCursor(Env, Cursor, path, (cursor) => {
      cursor.goToKey(40);
      let callbackCount = 0;
      const currentAtForty = cursor.getCurrentStringUnsafe((key, value) => {
        callbackCount++;
        assertEquals(key, 40);
        assertEquals(value, '40');
      });
      assertEquals(callbackCount, 1);
      assertEquals(currentAtForty, '40');

      const first = cursor.goToKey(0);
      assertEquals(first, 0);
      for (let index = 0; index < STRING_TOTAL; index++) {
        callbackCount = 0;
        const current = cursor.getCurrentStringUnsafe((key, value) => {
          callbackCount++;
          assertEquals(key, index);
          assertEquals(value, index.toString());
        });
        assertEquals(callbackCount, 1);
        assertEquals(current, index.toString());

        const next = cursor.goToNext();
        assertEquals(next, index + 1 < STRING_TOTAL ? index + 1 : null);
      }
    })
  );
});

Deno.test('cursor exposes safe string values for numeric keys', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withNumericStringCursor(Env, Cursor, path, (cursor) => {
      cursor.goToKey(40);
      let callbackCount = 0;
      const currentAtForty = cursor.getCurrentString((key, value) => {
        callbackCount++;
        assertEquals(key, 40);
        assertEquals(value, '40');
      });
      assertEquals(callbackCount, 1);
      assertEquals(currentAtForty, '40');

      const first = cursor.goToKey(0);
      assertEquals(first, 0);
      for (let index = 0; index < STRING_TOTAL; index++) {
        callbackCount = 0;
        const current = cursor.getCurrentString((key, value) => {
          callbackCount++;
          assertEquals(key, index);
          assertEquals(value, index.toString());
        });
        assertEquals(callbackCount, 1);
        assertEquals(current, index.toString());

        const next = cursor.goToNext();
        assertEquals(next, index + 1 < STRING_TOTAL ? index + 1 : null);
      }
    })
  );
});

Deno.test('string cursor reads the first and last numeric entries', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) =>
    withNumericStringCursor(Env, Cursor, path, (cursor) => {
      const first = cursor.goToFirst();
      assertEquals(first, 0);
      let firstCallbackCount = 0;
      const firstValue = cursor.getCurrentString((key, value) => {
        firstCallbackCount++;
        assertEquals(key, 0);
        assertEquals(value, '0');
      });
      assertEquals(firstCallbackCount, 1);
      assertEquals(firstValue, '0');

      assertEquals(cursor.goToLast(), STRING_TOTAL - 1);
      let lastCallbackCount = 0;
      const lastValue = cursor.getCurrentString((key, value) => {
        lastCallbackCount++;
        assertEquals(key, STRING_TOTAL - 1);
        assertEquals(value, (STRING_TOTAL - 1).toString());
      });
      assertEquals(lastCallbackCount, 1);
      assertEquals(lastValue, (STRING_TOTAL - 1).toString());
    })
  );
});

Deno.test('dupsort cursor supports reverse, ranged, and delete navigation', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    let cursor: CursorContract<string> | undefined;

    return withCleanup(
      () => {
        env.open({ path, maxDbs: 4, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({
          name: 'cursor-duplicate-complete',
          create: true,
          dupSort: true,
        });
        txn = env.beginTxn();
        for (const value of ['a', 'b', 'c']) {
          txn.putString(dbi, 'dup', value);
        }

        cursor = new Cursor(txn, dbi);
        assertEquals(cursor.goToKey('dup'), 'dup');
        assertEquals(cursor.goToFirstDup(), 'dup');
        assertEquals(cursor.getCurrentString(), 'a');
        assertEquals(cursor.goToNextDup(), 'dup');
        assertEquals(cursor.getCurrentString(), 'b');
        assertEquals(cursor.goToLastDup(), 'dup');
        assertEquals(cursor.getCurrentString(), 'c');
        assertEquals(cursor.goToPrevDup(), 'dup');
        assertEquals(cursor.getCurrentString(), 'b');
        assertEquals(cursor.goToDupRange('dup', 'bb'), 'dup');
        assertEquals(cursor.getCurrentString(), 'c');
        assertEquals(cursor.goToDup('dup', 'b'), 'dup');
        assertEquals(cursor.getCurrentString(), 'b');

        const goToDup = cursor.goToDup as unknown as (
          ...args: unknown[]
        ) => unknown;
        assertEquals(cursor.goToDup('dup', 'b'), 'dup');
        assertThrows(
          () => goToDup.call(cursor, 'dup'),
          /goToDup.*incorrect number/i,
        );
        assertThrows(
          () => goToDup.call(cursor, 'dup', 'c', {}, 'extra'),
          /goToDup.*incorrect number/i,
        );
        assertEquals(cursor.getCurrentString(), 'b');

        const goToDupRange = cursor.goToDupRange as unknown as (
          ...args: unknown[]
        ) => unknown;
        assertThrows(
          () => goToDupRange.call(cursor, 'dup'),
          /goToDupRange.*incorrect number/i,
        );
        assertThrows(
          () => goToDupRange.call(cursor, 'dup', 'c', {}, 'extra'),
          /goToDupRange.*incorrect number/i,
        );
        assertEquals(cursor.getCurrentString(), 'b');

        cursor.del();
        assertEquals(cursor.goToDup('dup', 'b'), null);
        assertEquals(cursor.goToDup('dup', 'a'), 'dup');
        cursor.del({ noDupData: true });
        assertEquals(cursor.goToKey('dup'), null);
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
