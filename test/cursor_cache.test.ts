import { assertEquals, assertThrows } from './_support/assertions.ts';
import {
  notStrictEqual as assertNotStrictEquals,
  strictEqual as assertStrictEquals,
} from 'node:assert/strict';
import type {
  CursorContract,
  DbiContract,
  EnvContract,
  LmdbModule,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const encoder = new TextEncoder();

interface CursorFixture {
  readonly cursor: CursorContract<string>;
  readonly dbi: DbiContract;
  readonly env: EnvContract;
  readonly txn: TxnContract;
  closeCursor(): CursorContract<string>;
  endTxn(mode: 'abort' | 'commit'): TxnContract;
}

async function withCursor(
  module: LmdbModule,
  path: string,
  readOnly: boolean,
  body: (fixture: CursorFixture) => void | Promise<void>,
): Promise<void> {
  const env = new module.Env();
  let dbi: DbiContract | undefined;
  let setupTxn: TxnContract | undefined;
  let txn: TxnContract | undefined;
  let cursor: CursorContract<string> | undefined;

  await withCleanup(
    async () => {
      env.open({ path, maxDbs: 2 });
      dbi = env.openDbi({ name: 'cursor-cache', create: true });
      setupTxn = env.beginTxn();
      setupTxn.putBinary(dbi, 'a', encoder.encode('alpha'));
      setupTxn.putBinary(dbi, 'b', encoder.encode('bravo'));
      setupTxn.putBoolean(dbi, 'boolean', true);
      setupTxn.putNumber(dbi, 'number', 42.5);
      setupTxn.putString(dbi, 'string', 'cached');
      setupTxn.commit();
      setupTxn = undefined;

      txn = env.beginTxn({ readOnly });
      cursor = new module.Cursor(txn, dbi);
      await body({
        cursor,
        dbi,
        env,
        txn,
        closeCursor() {
          const current = cursor!;
          current.close();
          cursor = undefined;
          return current;
        },
        endTxn(mode) {
          const current = txn!;
          current[mode]();
          txn = undefined;
          return current;
        },
      });
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

Deno.test('cursor reuses the navigation result for unsafe current reads', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor }) => {
      assertEquals(cursor.goToFirst(), 'a');

      const first = cursor.getCurrentBinaryUnsafe();
      const second = cursor.getCurrentBinaryUnsafe((key, value) => {
        assertEquals(key, 'a');
        assertStrictEquals(value, first);
      });

      assertStrictEquals(second, first);
    })
  );
});

Deno.test('cursor clears its cached record after navigation reaches the end', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor }) => {
      assertEquals(cursor.goToLast(), 'string');
      assertEquals(cursor.getCurrentString(), 'cached');

      assertEquals(cursor.goToNext(), null);
      assertEquals(cursor.getCurrentBinaryUnsafe(), null);
    })
  );
});

Deno.test('cursor clears its cached record after deleting the current value', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, false, ({ cursor }) => {
      assertEquals(cursor.goToFirst(), 'a');
      assertEquals(cursor.getCurrentBinaryUnsafe(), encoder.encode('alpha'));

      cursor.del();

      assertEquals(cursor.getCurrentBinaryUnsafe(), null);
      assertEquals(cursor.goToNext(), 'b');
      assertEquals(cursor.getCurrentBinary(), encoder.encode('bravo'));
    })
  );
});

Deno.test('cursor safe reads return durable copies of cached native data', async () => {
  const module = await loadSubject();
  let firstCopy: Uint8Array | null = null;

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor }) => {
      assertEquals(cursor.goToKey('a'), 'a');
      const unsafe = cursor.getCurrentBinaryUnsafe();
      firstCopy = cursor.getCurrentBinary((key, value) => {
        assertEquals(key, 'a');
        assertEquals(value, encoder.encode('alpha'));
      });
      const secondCopy = cursor.getCurrentBinary();

      assertNotStrictEquals(firstCopy, unsafe);
      assertNotStrictEquals(secondCopy, unsafe);
      assertNotStrictEquals(secondCopy, firstCopy);

      assertEquals(cursor.goToKey('b'), 'b');
      assertEquals(firstCopy, encoder.encode('alpha'));
    })
  );

  assertEquals(firstCopy, encoder.encode('alpha'));
});

Deno.test('cursor refreshes cached data after its unsafe view is detached', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor, env }) => {
      assertEquals(cursor.goToKey('a'), 'a');
      const detached = cursor.getCurrentBinaryUnsafe();
      if (detached === null) throw new Error('Expected an unsafe value');
      if (!(detached.buffer instanceof ArrayBuffer)) {
        throw new Error('Expected an ArrayBuffer-backed unsafe value');
      }

      env.detachBuffer(detached.buffer);

      assertEquals(detached.byteLength, 0);
      assertEquals(cursor.getCurrentBinary(), encoder.encode('alpha'));
      const refreshed = cursor.getCurrentBinaryUnsafe();
      assertEquals(refreshed, encoder.encode('alpha'));
      assertNotStrictEquals(refreshed, detached);
    })
  );
});

Deno.test('cursor typed getters decode the cached navigation result', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor }) => {
      assertEquals(cursor.goToKey('boolean'), 'boolean');
      assertEquals(cursor.getCurrentBoolean(), true);

      assertEquals(cursor.goToKey('number'), 'number');
      assertEquals(cursor.getCurrentNumber(), 42.5);

      assertEquals(cursor.goToKey('string'), 'string');
      assertEquals(cursor.getCurrentString(), 'cached');
      assertEquals(cursor.getCurrentStringUnsafe(), 'cached');
    })
  );
});

Deno.test('cursor does not expose cached data after explicit close', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor, closeCursor }) => {
      assertEquals(cursor.goToFirst(), 'a');
      assertEquals(cursor.getCurrentBinaryUnsafe(), encoder.encode('alpha'));

      const closed = closeCursor();

      assertThrows(() => closed.getCurrentBinaryUnsafe(), /closed/i);
      assertThrows(() => closed.goToFirst(), /closed/i);
    })
  );
});

for (const mode of ['abort', 'commit'] as const) {
  Deno.test(`cursor does not expose cached data after transaction ${mode}`, async () => {
    const module = await loadSubject();

    await withTempDir((path) =>
      withCursor(module, path, true, ({ cursor, closeCursor, endTxn }) => {
        assertEquals(cursor.goToFirst(), 'a');
        assertEquals(
          cursor.getCurrentBinaryUnsafe(),
          encoder.encode('alpha'),
        );

        endTxn(mode);

        assertThrows(
          () => cursor.getCurrentBinaryUnsafe(),
          /closed|ended/i,
        );
        closeCursor();
      })
    );
  });
}

Deno.test('cursor does not expose cached data after transaction reset', async () => {
  const module = await loadSubject();

  await withTempDir((path) =>
    withCursor(module, path, true, ({ cursor, txn, closeCursor }) => {
      assertEquals(cursor.goToFirst(), 'a');
      assertEquals(cursor.getCurrentBinaryUnsafe(), encoder.encode('alpha'));

      txn.reset();

      assertThrows(
        () => cursor.getCurrentBinaryUnsafe(),
        /closed|ended/i,
      );
      closeCursor();
    })
  );
});
