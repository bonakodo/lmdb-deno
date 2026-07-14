import { assertEquals } from './_support/assertions.ts';
import { bytes } from './_support/bytes.ts';
import type {
  DbiContract,
  EnvContract,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

async function withDataTypeTxn(
  Env: new () => EnvContract,
  path: string,
  body: (
    env: EnvContract,
    dbi: DbiContract,
    txn: TxnContract,
  ) => void | Promise<void>,
): Promise<void> {
  const env = new Env();
  let dbi: DbiContract | undefined;
  let txn: TxnContract | undefined;

  await withCleanup(
    async () => {
      env.open({ path, maxDbs: 10 });
      dbi = env.openDbi({ name: 'mydb3', create: true });
      txn = env.beginTxn();
      await body(env, dbi, txn);
      txn.commit();
      txn = undefined;
    },
    [() => txn?.abort(), () => dbi?.close(), () => env.close()],
  );
}

Deno.test('string values round-trip', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (_env, dbi, txn) => {
      txn.putString(dbi, 'key1', 'Hello world!');
      assertEquals(txn.getString(dbi, 'key1'), 'Hello world!');
      txn.del(dbi, 'key1');
      assertEquals(txn.getString(dbi, 'key1'), null);
    })
  );
});

Deno.test('unsafe string values round-trip', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (_env, dbi, txn) => {
      txn.putString(dbi, 'key1', 'Hello world!');
      assertEquals(txn.getStringUnsafe(dbi, 'key1'), 'Hello world!');
      txn.del(dbi, 'key1');
      assertEquals(txn.getStringUnsafe(dbi, 'key1'), null);
    })
  );
});

Deno.test('safe binary values use Uint8Array copy semantics', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (_env, dbi, txn) => {
      const expected = bytes('48656c6c6f2c20776f726c6421');
      txn.putBinary(dbi, 'key2', expected);
      const firstRead = txn.getBinary(dbi, 'key2');
      assertEquals(firstRead, expected);
      assertEquals(firstRead === expected, false);
      if (firstRead === null) throw new Error('Expected binary data');
      firstRead[0] = 0;
      assertEquals(txn.getBinary(dbi, 'key2'), expected);

      txn.del(dbi, 'key2');
      assertEquals(txn.getBinary(dbi, 'key2'), null);
    })
  );
});

Deno.test('unsafe binary values can be detached', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (env, dbi, txn) => {
      const expected = bytes('48656c6c6f2c20776f726c6421');
      txn.putBinary(dbi, 'key2', expected);
      let view = txn.getBinaryUnsafe(dbi, 'key2');
      if (view === null) throw new Error('Expected unsafe binary data');
      assertEquals(view[0], expected[0]);
      if (!(view.buffer instanceof ArrayBuffer)) {
        throw new TypeError('Expected an ArrayBuffer-backed view');
      }
      env.detachBuffer(view.buffer);

      view = txn.getBinaryUnsafe(dbi, 'key2');
      if (view === null) throw new Error('Expected unsafe binary data');
      assertEquals(view[0], expected[0]);
      assertEquals(view, expected);
      if (!(view.buffer instanceof ArrayBuffer)) {
        throw new TypeError('Expected an ArrayBuffer-backed view');
      }
      env.detachBuffer(view.buffer);

      txn.del(dbi, 'key2');
      assertEquals(txn.getBinaryUnsafe(dbi, 'key2'), null);
    })
  );
});

Deno.test('binary keys support a delete key override', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (_env, dbi, txn) => {
      const value = bytes('48656c6c6f2c20776f726c6421');
      const key = new TextEncoder().encode('key2');
      txn.putBinary(dbi, key, value);
      assertEquals(txn.getBinary(dbi, key), value);
      txn.del(dbi, key, { keyIsBuffer: true });
      assertEquals(txn.getBinary(dbi, key), null);
    })
  );
});

Deno.test('number values round-trip', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (_env, dbi, txn) => {
      txn.putNumber(dbi, 'key3', 9007199254740991);
      assertEquals(txn.getNumber(dbi, 'key3'), Math.pow(2, 53) - 1);
      txn.del(dbi, 'key3');
      assertEquals(txn.getNumber(dbi, 'key3'), null);
    })
  );
});

Deno.test('boolean values round-trip', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) =>
    withDataTypeTxn(Env, path, (_env, dbi, txn) => {
      txn.putBoolean(dbi, 'key4', true);
      assertEquals(txn.getBoolean(dbi, 'key4'), true);
      txn.putBoolean(dbi, 'key5', false);
      assertEquals(txn.getBoolean(dbi, 'key5'), false);
      txn.del(dbi, 'key4');
      txn.del(dbi, 'key5');
      assertEquals(txn.getBoolean(dbi, 'key4'), null);
      assertEquals(txn.getBoolean(dbi, 'key5'), null);
    })
  );
});
