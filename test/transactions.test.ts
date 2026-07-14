import { assertEquals, assertThrows } from './_support/assertions.ts';
import type { DbiContract, TxnContract } from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const EACCES = 13;
const MDB_KEYEXIST = -30799;

function captureError(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected callback to throw an Error');
}

Deno.test(
  'a read snapshot sees committed changes only after reset and renew',
  async () => {
    const { Env } = await loadSubject();

    await withTempDir((path) => {
      const env = new Env();
      let dbi: DbiContract | undefined;
      let setupTxn: TxnContract | undefined;
      let readTxn: TxnContract | undefined;
      let writeTxn: TxnContract | undefined;
      return withCleanup(
        () => {
          env.open({ path, maxDbs: 10 });
          dbi = env.openDbi({
            name: 'mydb4',
            create: true,
            keyIsUint32: true,
          });
          setupTxn = env.beginTxn();
          setupTxn.putString(dbi, 1, 'Hello1');
          setupTxn.putString(dbi, 2, 'Hello2');
          setupTxn.commit();
          setupTxn = undefined;

          readTxn = env.beginTxn({ readOnly: true });
          assertEquals(readTxn.getString(dbi, 1), 'Hello1');

          writeTxn = env.beginTxn();
          writeTxn.putString(dbi, 1, 'Ha ha ha');
          assertEquals(writeTxn.getString(dbi, 1), 'Ha ha ha');
          assertEquals(readTxn.getString(dbi, 1), 'Hello1');

          writeTxn.commit();
          writeTxn = undefined;
          assertEquals(readTxn.getString(dbi, 1), 'Hello1');

          readTxn.reset();
          readTxn.renew();
          assertEquals(readTxn.getString(dbi, 1), 'Ha ha ha');
          readTxn.abort();
          readTxn = undefined;
        },
        [
          () => writeTxn?.abort(),
          () => readTxn?.abort(),
          () => setupTxn?.abort(),
          () => dbi?.close(),
          () => env.close(),
        ],
      );
    });
  },
);

Deno.test('a read-only transaction rejects writes with LmdbError', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let setupTxn: TxnContract | undefined;
    let readTxn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({
          name: 'mydb4',
          create: true,
          keyIsUint32: true,
        });
        setupTxn = env.beginTxn();
        setupTxn.putString(dbi, 1, 'Hello1');
        setupTxn.putString(dbi, 2, 'Hello2');
        setupTxn.commit();
        setupTxn = undefined;

        readTxn = env.beginTxn({ readOnly: true });
        const error = captureError(
          () => readTxn?.putString(dbi!, 2, 'hööhh'),
        );
        const code = (error as { code?: unknown }).code;
        assertEquals(error.name, 'Error');
        assertEquals(error.message.includes('Permission denied'), true);
        assertEquals(typeof code, 'number');
        assertEquals(code, EACCES);

        const deleteError = captureError(() => readTxn?.del(dbi!, 1));
        assertEquals(deleteError.name, 'Error');
        assertEquals(deleteError.message.includes('Permission denied'), true);
        assertEquals(
          (deleteError as Error & { code?: unknown }).code,
          EACCES,
        );

        const dropError = captureError(() => dbi?.drop({ txn: readTxn }));
        assertEquals(dropError.name, 'Error');
        assertEquals(dropError.message.includes('Permission denied'), true);
        assertEquals(
          (dropError as Error & { code?: unknown }).code,
          EACCES,
        );
        readTxn.abort();
        readTxn = undefined;
      },
      [
        () => readTxn?.abort(),
        () => setupTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('transaction key overrides and uint32 databases validate keys', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let stringDbi: DbiContract | undefined;
    let integerDbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        stringDbi = env.openDbi({ name: 'strings', create: true });
        integerDbi = env.openDbi({
          name: 'integers',
          create: true,
          keyIsUint32: true,
        });
        txn = env.beginTxn();

        assertThrows(
          () =>
            txn?.putString(stringDbi!, 'wrong', 'value', {
              keyIsUint32: true,
            }),
          /Specified key type doesn't match the key you gave/,
        );
        assertThrows(
          () => txn?.putString(integerDbi!, 'wrong', 'value'),
          /keyIsUint32.*Dbi/,
        );
        assertThrows(
          () => txn?.putString(integerDbi!, -1, 'value'),
          /unsigned 32-bit|0xFFFFFFFF/i,
        );
        assertThrows(
          () => txn?.putString(integerDbi!, 0x1_0000_0000, 'value'),
          /unsigned 32-bit|0xFFFFFFFF/i,
        );

        txn.putString(integerDbi, 0, 'zero');
        txn.putString(integerDbi, 0xffff_ffff, 'max');
        assertEquals(txn.getString(integerDbi, 0), 'zero');
        assertEquals(txn.getString(integerDbi, 0xffff_ffff), 'max');
        txn.commit();
        txn = undefined;
      },
      [
        () => txn?.abort(),
        () => integerDbi?.close(),
        () => stringDbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('put flags require true and preserve native errors', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'put-flags', create: true });
        txn = env.beginTxn();
        txn.putString(dbi, 'key', 'first');

        txn.putString(dbi, 'key', 'second', {
          noOverwrite: 'yes' as never,
        });
        assertEquals(txn.getString(dbi, 'key'), 'second');

        const error = captureError(() =>
          txn?.putString(dbi!, 'key', 'third', { noOverwrite: true })
        );
        assertEquals(error.name, 'Error');
        assertEquals((error as { code?: unknown }).code, MDB_KEYEXIST);
        assertEquals(txn.getString(dbi, 'key'), 'second');
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('read-only reset and renew enforce transaction state', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'reset-state', create: true });

        txn = env.beginTxn();
        assertThrows(() => txn?.reset(), /read-only/i);
        txn.abort();

        txn = env.beginTxn({ readOnly: true });
        assertThrows(() => txn?.renew(), /reset/i);
        txn.reset();
        assertThrows(() => txn?.getString(dbi!, 'key'), /reset/i);
        assertThrows(() => txn?.reset(), /reset/i);
        txn.renew();
        assertThrows(() => txn?.renew(), /reset/i);
        assertEquals(txn.getString(dbi, 'key'), null);
        txn.abort();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('transaction options require literal true for read-only mode', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'strict-readonly', create: true });
        txn = env.beginTxn({ readOnly: 'yes' as never });
        txn.putString(dbi, 'key', 'value');
        assertEquals(txn.getString(dbi, 'key'), 'value');
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});
