import {
  deepStrictEqual as assertEquals,
  ok as assert,
} from 'node:assert/strict';
import type { DbiContract, TxnContract } from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const RAW_GET_SYMBOLS = {
  mdb_get: {
    parameters: ['pointer', 'u32', 'buffer', 'buffer'],
    result: 'i32',
  },
} as const satisfies Deno.ForeignLibraryInterface;

type RawGetLibrary = Deno.DynamicLibrary<typeof RAW_GET_SYMBOLS>;

interface NativeTestAccessModule {
  readonly getNativeHandles: (
    txn: TxnContract,
    dbi: DbiContract,
  ) => {
    readonly txnPointer: Deno.PointerValue;
    readonly dbiHandle: number;
  };
}

const endianProbe = new Uint16Array([0x00ff]);
const isLittleEndian = new Uint8Array(endianProbe.buffer)[0] === 0xff;

function mdbVal(bytes?: Uint8Array): Uint8Array {
  if (Deno.build.arch !== 'aarch64' && Deno.build.arch !== 'x86_64') {
    throw new Error(
      `The raw MDB_val oracle requires a 64-bit Deno target, got ${Deno.build.arch}`,
    );
  }

  const storage = new Uint8Array(16);
  const view = new DataView(storage.buffer);
  view.setBigUint64(0, BigInt(bytes?.byteLength ?? 0), isLittleEndian);
  if (bytes !== undefined) {
    const pointer = Deno.UnsafePointer.of(bytes);
    if (pointer === null) throw new Error('Expected a non-null byte pointer');
    view.setBigUint64(8, Deno.UnsafePointer.value(pointer), isLittleEndian);
  }
  return storage;
}

Deno.test('safe binary values survive transaction close and later writes', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        txn = env.beginTxn();
        txn.putBinary(dbi, 'key', new Uint8Array([1, 2, 3]));
        txn.commit();
        txn = undefined;

        txn = env.beginTxn({ readOnly: true });
        const safe = txn.getBinary(dbi, 'key');
        assert(safe instanceof Uint8Array);
        txn.commit();
        txn = undefined;

        txn = env.beginTxn();
        txn.putBinary(dbi, 'key', new Uint8Array([9, 8, 7]));
        txn.commit();
        txn = undefined;
        assertEquals(safe, new Uint8Array([1, 2, 3]));
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('unsafe binary getter returns a readable exact native view', async () => {
  const { Env } = await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    let rawLibrary: RawGetLibrary | undefined;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true, keyIsBuffer: true });
        const key = new Uint8Array([0x4b, 0x45, 0x59]);
        const expected = new Uint8Array([4, 5, 6, 7]);
        txn = env.beginTxn();
        txn.putBinary(dbi, key, expected);
        txn.commit();
        txn = undefined;

        txn = env.beginTxn({ readOnly: true });
        const unsafe = txn.getBinaryUnsafe(dbi, key);
        assert(unsafe instanceof Uint8Array);
        assertEquals(unsafe, expected);
        assertEquals('pointer' in txn, false);
        assertEquals('handler' in dbi, false);

        const internalAccessorUrl = new URL(
          ['..', 'src', 'internal', 'native_test_access.ts'].join('/'),
          import.meta.url,
        ).href;
        const nativeTestAccess = await import(
          internalAccessorUrl
        ) as NativeTestAccessModule;
        const { txnPointer, dbiHandle } = nativeTestAccess.getNativeHandles(
          txn,
          dbi,
        );
        assert(txnPointer !== null);

        rawLibrary = Deno.dlopen(libraryPath, RAW_GET_SYMBOLS);
        const rawKey = mdbVal(key);
        const rawValue = mdbVal();
        assertEquals(
          rawLibrary.symbols.mdb_get(
            txnPointer,
            dbiHandle,
            rawKey,
            rawValue,
          ),
          0,
        );
        const rawValueView = new DataView(rawValue.buffer);
        const rawSize = rawValueView.getBigUint64(0, isLittleEndian);
        const rawPointer = rawValueView.getBigUint64(8, isLittleEndian);
        const unsafePointer = Deno.UnsafePointer.of(unsafe);
        assert(unsafePointer !== null);
        assertEquals(rawSize, BigInt(expected.byteLength));
        assertEquals(unsafe.byteLength, Number(rawSize));
        assertEquals(Deno.UnsafePointer.value(unsafePointer), rawPointer);

        if (!(unsafe.buffer instanceof ArrayBuffer)) {
          throw new TypeError('Expected an ArrayBuffer-backed unsafe view');
        }
        env.detachBuffer(unsafe.buffer);
        txn.commit();
        txn = undefined;
      },
      [
        () => txn?.abort(),
        () => dbi?.close(),
        () => env.close(),
        () => rawLibrary?.close(),
      ],
    );
  });
});

Deno.test('detachBuffer detaches an unsafe external ArrayBuffer', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        txn = env.beginTxn();
        txn.putBinary(dbi, 'key', new Uint8Array([10, 20]));
        txn.commit();
        txn = undefined;

        txn = env.beginTxn({ readOnly: true });
        const first = txn.getBinaryUnsafe(dbi, 'key');
        assert(first instanceof Uint8Array);
        assertEquals(first[0], 10);
        if (!(first.buffer instanceof ArrayBuffer)) {
          throw new TypeError('Expected an ArrayBuffer-backed unsafe view');
        }
        env.detachBuffer(first.buffer);
        assertEquals(first.byteLength, 0);
        assertEquals(first.buffer.byteLength, 0);

        const second = txn.getBinaryUnsafe(dbi, 'key');
        assertEquals(second, new Uint8Array([10, 20]));
        if (!(second?.buffer instanceof ArrayBuffer)) {
          throw new TypeError('Expected an ArrayBuffer-backed unsafe view');
        }
        env.detachBuffer(second.buffer);
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('unsafe string getter returns a durable correct string copy', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        txn = env.beginTxn();
        txn.putString(dbi, 'key', 'zero-copy? こんにちは');
        txn.commit();
        txn = undefined;

        txn = env.beginTxn({ readOnly: true });
        const stringCopy = txn.getStringUnsafe(dbi, 'key');
        txn.commit();
        txn = undefined;

        txn = env.beginTxn();
        txn.putString(dbi, 'key', 'replacement');
        txn.commit();
        txn = undefined;
        assertEquals(stringCopy, 'zero-copy? こんにちは');
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});
