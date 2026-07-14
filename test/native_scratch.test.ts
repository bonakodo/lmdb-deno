import {
  assertEquals,
  assertExists,
  assertThrows,
} from './_support/assertions.ts';
import {
  copyBytes,
  MDB_VAL_DATA_OFFSET,
  MDB_VAL_SIZE,
  MDB_VAL_SIZE_OFFSET,
  mutableMdbVal,
  readMdbVal,
} from '../src/native/memory.ts';

const MDB_NOTFOUND = -30798;
const MDB_BAD_VALSIZE = -30781;

Deno.test('mutable MDB_val keeps outer storage as a buffer', () => {
  const slot = mutableMdbVal();

  assertEquals('pointer' in slot, false);
  assertEquals(slot.storage instanceof Uint8Array, true);
});

Deno.test('safe native copies avoid external ArrayBuffer views', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const pointer = pointerFor(source);
  const prototype = Deno.UnsafePointerView.prototype;
  const originalGetArrayBuffer = prototype.getArrayBuffer;
  const originalCopyInto = prototype.copyInto;
  let copyIntoCalls = 0;

  try {
    Object.defineProperty(prototype, 'getArrayBuffer', {
      configurable: true,
      value: () => {
        throw new Error('safe copies must not create external ArrayBuffers');
      },
      writable: true,
    });
    Object.defineProperty(prototype, 'copyInto', {
      configurable: true,
      value: function (
        this: Deno.UnsafePointerView,
        destination: BufferSource,
        offset?: number,
      ): void {
        copyIntoCalls++;
        originalCopyInto.call(this, destination, offset);
      },
      writable: true,
    });

    const copied = copyBytes(pointer, source.byteLength);
    assertEquals(copied, source);
    assertEquals(copyIntoCalls, 1);

    source[0] = 9;
    assertEquals(copied, new Uint8Array([1, 2, 3, 4]));
  } finally {
    Object.defineProperty(prototype, 'getArrayBuffer', {
      configurable: true,
      value: originalGetArrayBuffer,
      writable: true,
    });
    Object.defineProperty(prototype, 'copyInto', {
      configurable: true,
      value: originalCopyInto,
      writable: true,
    });
  }
});

interface NativeCall {
  readonly name: string;
  readonly key: Uint8Array;
  readonly data: Uint8Array | null;
}

Deno.test('mutable MDB_val scratch reuses storage and releases every input', () => {
  const slot = mutableMdbVal();
  const storage = slot.storage;
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
  writeMdbVal(slot.storage, output);

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
  const keyStorage = calls[0].key;
  const data = calls[0].data;
  assertExists(data);
  const dataStorage = data;
  for (const call of calls) {
    assertEquals(call.key === keyStorage, true);
    assertEquals(call.key, new Uint8Array(MDB_VAL_SIZE));
    if (call.data !== null) {
      assertEquals(call.data === dataStorage, true);
      assertEquals(call.data, new Uint8Array(MDB_VAL_SIZE));
    }
  }
});

Deno.test('native hot paths clear scratch after not-found and native errors', async () => {
  const calls: NativeCall[] = [];
  const symbols = fakeSymbols(calls, new Uint8Array([1]));
  symbols.mdb_get = (
    _txn: Deno.PointerObject,
    _dbi: number,
    key: Uint8Array,
    data: Uint8Array,
  ) => {
    calls.push({ name: 'get', key, data });
    return MDB_NOTFOUND;
  };
  symbols.mdb_put = (
    _txn: Deno.PointerObject,
    _dbi: number,
    key: Uint8Array,
    data: Uint8Array,
    _flags: number,
  ) => {
    calls.push({ name: 'put', key, data });
    return MDB_BAD_VALSIZE;
  };
  symbols.mdb_cursor_get = (
    _cursor: Deno.PointerObject,
    key: Uint8Array,
    data: Uint8Array,
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
    assertEquals(call.key, new Uint8Array(MDB_VAL_SIZE));
    assertExists(call.data);
    assertEquals(call.data, new Uint8Array(MDB_VAL_SIZE));
  }
});

function fakeSymbols(calls: NativeCall[], output: Uint8Array) {
  return {
    mdb_strerror: (_code: number) => null,
    mdb_get: (
      _txn: Deno.PointerObject,
      _dbi: number,
      key: Uint8Array,
      data: Uint8Array,
    ) => {
      calls.push({ name: 'get', key, data });
      writeMdbVal(data, output);
      return 0;
    },
    mdb_put: (
      _txn: Deno.PointerObject,
      _dbi: number,
      key: Uint8Array,
      data: Uint8Array,
      _flags: number,
    ) => {
      calls.push({ name: 'put', key, data });
      return 0;
    },
    mdb_del: (
      _txn: Deno.PointerObject,
      _dbi: number,
      key: Uint8Array,
      data: Uint8Array | null,
    ) => {
      calls.push({ name: 'del', key, data });
      return 0;
    },
    mdb_cursor_get: (
      _cursor: Deno.PointerObject,
      key: Uint8Array,
      data: Uint8Array,
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

function writeMdbVal(storage: Uint8Array, bytes: Uint8Array): void {
  const view = new DataView(
    storage.buffer,
    storage.byteOffset,
    storage.byteLength,
  );
  view.setBigUint64(MDB_VAL_SIZE_OFFSET, BigInt(bytes.byteLength), true);
  view.setBigUint64(MDB_VAL_DATA_OFFSET, pointerValue(bytes), true);
}

function assertZeroed(
  slot: { readonly storage: Uint8Array; readonly value?: Uint8Array },
): void {
  assertEquals(slot.value, undefined);
  assertEquals(slot.storage, new Uint8Array(MDB_VAL_SIZE));
}
