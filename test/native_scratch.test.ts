import {
  assertEquals,
  assertExists,
  assertThrows,
} from './_support/assertions.ts';
import {
  MDB_VAL_DATA_OFFSET,
  MDB_VAL_SIZE,
  MDB_VAL_SIZE_OFFSET,
  mutableMdbVal,
  readMdbVal,
} from '../src/native/memory.ts';

const MDB_NOTFOUND = -30798;
const MDB_BAD_VALSIZE = -30781;

interface NativeCall {
  readonly name: string;
  readonly key: Deno.PointerObject;
  readonly data: Deno.PointerObject | null;
}

Deno.test('mutable MDB_val scratch reuses storage and releases every input', () => {
  const slot = mutableMdbVal();
  const storage = slot.storage;
  const pointer = slot.pointer;
  const view = slot.view;

  for (
    const input of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array(),
      new Uint8Array([4, 5, 6, 7]).subarray(1, 3),
    ]
  ) {
    slot.setInput(input);

    assertEquals(slot.storage === storage, true);
    assertEquals(slot.pointer === pointer, true);
    assertEquals(slot.view === view, true);
    assertEquals(slot.value === input, true);
    assertEquals(
      view.getBigUint64(MDB_VAL_SIZE_OFFSET, true),
      BigInt(input.byteLength),
    );
    assertEquals(
      view.getBigUint64(MDB_VAL_DATA_OFFSET, true),
      pointerValue(input),
    );

    slot.clear();

    assertEquals(slot.value, undefined);
    assertZeroed(slot);
  }
});

Deno.test('mutable MDB_val scratch reads native output without replacing its view', () => {
  const slot = mutableMdbVal();
  const view = slot.view;
  const output = new Uint8Array([8, 9, 10, 11]);

  slot.clear();
  writeMdbVal(slot.pointer, output);

  assertEquals(slot.view === view, true);
  assertEquals(readMdbVal(slot), {
    length: output.byteLength,
    pointer: Deno.UnsafePointer.of(output),
  });

  slot.clear();
  assertZeroed(slot);
});

Deno.test('native hot paths reuse and clear scratch after successful calls', async () => {
  const output = new Uint8Array([91, 92, 93]);
  const calls: NativeCall[] = [];
  const symbols = fakeSymbols(calls, output);
  const { createNativeApi, CursorOperation } = await importNativeApi(symbols);
  const api = createNativeApi(fakeLibrary(symbols));
  const nativeHandle = pointerFor(new Uint8Array(1));

  for (const key of [new Uint8Array([1]), new Uint8Array([2, 3, 4])]) {
    assertEquals(api.get(nativeHandle, 1, key), output);
    assertEquals(api.getUnsafe(nativeHandle, 1, key), output);
  }
  api.put(
    nativeHandle,
    1,
    new Uint8Array([5, 6]),
    new Uint8Array([7, 8, 9, 10]),
    0,
  );
  api.put(nativeHandle, 1, new Uint8Array([11]), new Uint8Array(), 0);
  api.del(nativeHandle, 1, new Uint8Array([11]), new Uint8Array([12]));
  api.del(nativeHandle, 1, new Uint8Array([12]), undefined);
  assertEquals(
    api.cursorGet(
      nativeHandle,
      new Uint8Array([13, 14]),
      undefined,
      CursorOperation.MDB_SET,
      false,
    ),
    { key: output, data: output },
  );

  assertEquals(calls.length, 9);
  const keyAddress = Deno.UnsafePointer.value(calls[0].key);
  const data = calls[0].data;
  assertExists(data);
  const dataAddress = Deno.UnsafePointer.value(data);
  for (const call of calls) {
    assertEquals(Deno.UnsafePointer.value(call.key), keyAddress);
    assertZeroedPointer(call.key);
    if (call.data !== null) {
      assertEquals(Deno.UnsafePointer.value(call.data), dataAddress);
      assertZeroedPointer(call.data);
    }
  }
});

Deno.test('native hot paths clear scratch after not-found and native errors', async () => {
  const calls: NativeCall[] = [];
  const symbols = fakeSymbols(calls, new Uint8Array([1]));
  symbols.mdb_get = (
    _txn: Deno.PointerObject,
    _dbi: number,
    key: Deno.PointerObject,
    data: Deno.PointerObject,
  ) => {
    calls.push({ name: 'get', key, data });
    return MDB_NOTFOUND;
  };
  symbols.mdb_put = (
    _txn: Deno.PointerObject,
    _dbi: number,
    key: Deno.PointerObject,
    data: Deno.PointerObject,
    _flags: number,
  ) => {
    calls.push({ name: 'put', key, data });
    return MDB_BAD_VALSIZE;
  };
  symbols.mdb_cursor_get = (
    _cursor: Deno.PointerObject,
    key: Deno.PointerObject,
    data: Deno.PointerObject,
    _operation: number,
  ) => {
    calls.push({ name: 'cursorGet', key, data });
    return MDB_BAD_VALSIZE;
  };
  const { createNativeApi, CursorOperation } = await importNativeApi(symbols);
  const api = createNativeApi(fakeLibrary(symbols));
  const nativeHandle = pointerFor(new Uint8Array(1));

  assertEquals(api.get(nativeHandle, 1, new Uint8Array([21])), null);
  assertThrows(
    () =>
      api.put(
        nativeHandle,
        1,
        new Uint8Array([22]),
        new Uint8Array([23]),
        0,
      ),
    Error,
    'MDB_BAD_VALSIZE',
  );
  assertThrows(
    () =>
      api.cursorGet(
        nativeHandle,
        new Uint8Array([24]),
        new Uint8Array([25]),
        CursorOperation.MDB_SET,
        false,
      ),
    Error,
    'MDB_BAD_VALSIZE',
  );

  assertEquals(calls.length, 3);
  for (const call of calls) {
    assertZeroedPointer(call.key);
    assertExists(call.data);
    assertZeroedPointer(call.data);
  }
});

function fakeSymbols(calls: NativeCall[], output: Uint8Array) {
  return {
    mdb_strerror: (_code: number) => null,
    mdb_get: (
      _txn: Deno.PointerObject,
      _dbi: number,
      key: Deno.PointerObject,
      data: Deno.PointerObject,
    ) => {
      calls.push({ name: 'get', key, data });
      writeMdbVal(data, output);
      return 0;
    },
    mdb_put: (
      _txn: Deno.PointerObject,
      _dbi: number,
      key: Deno.PointerObject,
      data: Deno.PointerObject,
      _flags: number,
    ) => {
      calls.push({ name: 'put', key, data });
      return 0;
    },
    mdb_del: (
      _txn: Deno.PointerObject,
      _dbi: number,
      key: Deno.PointerObject,
      data: Deno.PointerObject | null,
    ) => {
      calls.push({ name: 'del', key, data });
      return 0;
    },
    mdb_cursor_get: (
      _cursor: Deno.PointerObject,
      key: Deno.PointerObject,
      data: Deno.PointerObject,
      _operation: number,
    ) => {
      calls.push({ name: 'cursorGet', key, data });
      writeMdbVal(key, output);
      writeMdbVal(data, output);
      return 0;
    },
  };
}

async function importNativeApi(symbols: ReturnType<typeof fakeSymbols>) {
  const global = globalThis as typeof globalThis & {
    __denoLmdbWorkerLibrary?: unknown;
  };
  global.__denoLmdbWorkerLibrary = fakeLibrary(symbols);
  return await import('../src/native/api.ts?scratch-tests');
}

function fakeLibrary(symbols: ReturnType<typeof fakeSymbols>) {
  return {
    path: 'test',
    handle: { symbols },
    version: {
      versionString: 'LMDB 1.0.0: (June 30, 2026)',
      major: 1,
      minor: 0,
      patch: 0,
    },
  } as never;
}

function pointerValue(bytes: Uint8Array): bigint {
  if (bytes.byteLength === 0) return 0n;
  return Deno.UnsafePointer.value(pointerFor(bytes));
}

function pointerFor(bytes: Uint8Array): Deno.PointerObject {
  const pointer = Deno.UnsafePointer.of(bytes);
  if (pointer === null) throw new Error('Expected a non-null test pointer');
  return pointer;
}

function writeMdbVal(pointer: Deno.PointerObject, bytes: Uint8Array): void {
  const view = mdbValView(pointer);
  view.setBigUint64(MDB_VAL_SIZE_OFFSET, BigInt(bytes.byteLength), true);
  view.setBigUint64(MDB_VAL_DATA_OFFSET, pointerValue(bytes), true);
}

function assertZeroed(
  slot: { readonly storage: Uint8Array; readonly value?: Uint8Array },
): void {
  assertEquals(slot.value, undefined);
  assertEquals(slot.storage, new Uint8Array(MDB_VAL_SIZE));
}

function assertZeroedPointer(pointer: Deno.PointerObject): void {
  assertEquals(
    new Uint8Array(
      new Deno.UnsafePointerView(pointer).getArrayBuffer(MDB_VAL_SIZE),
    ),
    new Uint8Array(MDB_VAL_SIZE),
  );
}

function mdbValView(pointer: Deno.PointerObject): DataView {
  return new DataView(
    new Deno.UnsafePointerView(pointer).getArrayBuffer(MDB_VAL_SIZE),
  );
}
