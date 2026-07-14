/** Size of `MDB_val` on the supported 64-bit ABI. */
export const MDB_VAL_SIZE = 16;
export const MDB_VAL_SIZE_OFFSET = 0;
export const MDB_VAL_DATA_OFFSET = 8;

/** Size and field offsets of `MDB_stat` on the supported 64-bit ABI. */
export const MDB_STAT_SIZE = 40;
export const MDB_STAT_PSIZE_OFFSET = 0;
export const MDB_STAT_DEPTH_OFFSET = 4;
export const MDB_STAT_BRANCH_OFFSET = 8;
export const MDB_STAT_LEAF_OFFSET = 16;
export const MDB_STAT_OVERFLOW_OFFSET = 24;
export const MDB_STAT_ENTRIES_OFFSET = 32;

/** Size and field offsets of `MDB_envinfo` on the supported 64-bit ABI. */
export const MDB_ENVINFO_SIZE = 40;
export const MDB_ENVINFO_MAPADDR_OFFSET = 0;
export const MDB_ENVINFO_MAPSIZE_OFFSET = 8;
export const MDB_ENVINFO_LAST_PGNO_OFFSET = 16;
export const MDB_ENVINFO_LAST_TXNID_OFFSET = 24;
export const MDB_ENVINFO_MAXREADERS_OFFSET = 32;
export const MDB_ENVINFO_NUMREADERS_OFFSET = 36;

const SUPPORTED_ARCHITECTURES = new Set(['aarch64', 'x86_64']);
const endianProbe = new Uint16Array([0x00ff]);

/** Whether typed arrays use the little-endian byte order required by the ABI. */
export const isLittleEndian = new Uint8Array(endianProbe.buffer)[0] === 0xff;

/** An owned `MDB_val`, retaining both the structure and pointed-to bytes. */
export interface OwnedMdbVal {
  readonly storage: Uint8Array;
  readonly view: DataView;
  readonly value?: Uint8Array;
}

/** A reusable `MDB_val` whose input reference can be released after FFI. */
export interface MutableMdbVal extends OwnedMdbVal {
  setInput(value: Uint8Array): void;
  clear(): void;
}

export interface MdbStat {
  readonly psize: number;
  readonly depth: number;
  readonly branchPages: bigint;
  readonly leafPages: bigint;
  readonly overflowPages: bigint;
  readonly entries: bigint;
}

export interface MdbEnvInfo {
  readonly mapAddress: bigint;
  readonly mapSize: bigint;
  readonly lastPageNumber: bigint;
  readonly lastTxnId: bigint;
  readonly maxReaders: number;
  readonly numReaders: number;
}

/** Rejects runtimes whose native layout has not been verified. */
export function assertSupportedAbi(): void {
  if (BigUint64Array.BYTES_PER_ELEMENT !== 8) {
    throw new Error('LMDB FFI requires 64-bit mdb_size_t and pointer slots.');
  }
  if (!SUPPORTED_ARCHITECTURES.has(Deno.build.arch)) {
    throw new Error(
      `LMDB FFI requires a verified 64-bit pointer ABI; unsupported Deno architecture: ${Deno.build.arch}`,
    );
  }
  if (!isLittleEndian) {
    throw new Error(
      'LMDB FFI currently supports only verified little-endian runtimes.',
    );
  }
}

/** Allocates an owned native pointer output slot. */
export function pointerSlot(): BigUint64Array {
  return new BigUint64Array(1);
}

/** Reads a pointer returned through an owned output slot. */
export function pointerFromSlot(
  slot: BigUint64Array,
): Deno.PointerObject {
  const pointer = Deno.UnsafePointer.create(slot[0]);
  if (pointer === null) throw new Error('Native LMDB returned a null pointer');
  return pointer;
}

/** Encodes an ordinary UTF-8, zero-terminated C string. */
export function cString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const storage = new Uint8Array(encoded.byteLength + 1);
  storage.set(encoded);
  return storage;
}

/** Allocates an owned `MDB_val` that points at `value`. */
export function mdbVal(value?: Uint8Array): OwnedMdbVal {
  const storage = new Uint8Array(MDB_VAL_SIZE);
  const view = new DataView(storage.buffer);
  view.setBigUint64(
    MDB_VAL_SIZE_OFFSET,
    BigInt(value?.byteLength ?? 0),
    true,
  );

  if (value !== undefined && value.byteLength > 0) {
    const valuePointer = Deno.UnsafePointer.of(value);
    if (valuePointer === null) {
      throw new Error('Unable to obtain a pointer for an LMDB value');
    }
    view.setBigUint64(
      MDB_VAL_DATA_OFFSET,
      Deno.UnsafePointer.value(valuePointer),
      true,
    );
  }

  return { storage, view, value };
}

/** Allocates a reusable, mutable `MDB_val` scratch slot. */
export function mutableMdbVal(): MutableMdbVal {
  const storage = new Uint8Array(MDB_VAL_SIZE);
  const view = new DataView(storage.buffer);
  let value: Uint8Array | undefined;

  function clear(): void {
    value = undefined;
    storage.fill(0);
  }

  return {
    storage,
    view,
    get value() {
      return value;
    },
    setInput(input) {
      clear();
      value = input;
      try {
        view.setBigUint64(
          MDB_VAL_SIZE_OFFSET,
          BigInt(input.byteLength),
          true,
        );
        if (input.byteLength > 0) {
          const inputPointer = Deno.UnsafePointer.of(input);
          if (inputPointer === null) {
            throw new Error('Unable to obtain a pointer for an LMDB value');
          }
          view.setBigUint64(
            MDB_VAL_DATA_OFFSET,
            Deno.UnsafePointer.value(inputPointer),
            true,
          );
        }
      } catch (error) {
        clear();
        throw error;
      }
    },
    clear,
  };
}

/** Reads the byte count and pointer stored in an `MDB_val`. */
export function readMdbVal(value: OwnedMdbVal): {
  readonly length: number;
  readonly pointer: Deno.PointerObject | null;
} {
  const view = value.view;
  const rawLength = view.getBigUint64(MDB_VAL_SIZE_OFFSET, true);
  if (rawLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `LMDB value is too large for JavaScript: ${rawLength}`,
    );
  }
  return {
    length: Number(rawLength),
    pointer: Deno.UnsafePointer.create(
      view.getBigUint64(MDB_VAL_DATA_OFFSET, true),
    ),
  };
}

/** Copies bytes from native memory into JavaScript-owned storage. */
export function copyBytes(
  pointer: Deno.PointerObject,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid native byte length: ${length}`);
  }
  const output = new Uint8Array(length);
  new Deno.UnsafePointerView(pointer).copyInto(output);
  return output;
}

/** Creates an external, zero-copy view over native memory. */
export function viewBytes(
  pointer: Deno.PointerObject,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid native byte length: ${length}`);
  }
  return new Uint8Array(
    new Deno.UnsafePointerView(pointer).getArrayBuffer(length),
  );
}

/** Allocates zeroed storage for an `MDB_stat`. */
export function statStorage(): Uint8Array {
  return new Uint8Array(MDB_STAT_SIZE);
}

/** Decodes an `MDB_stat` using the verified field offsets. */
export function readStat(storage: Uint8Array): MdbStat {
  requireSize(storage, MDB_STAT_SIZE, 'MDB_stat');
  const view = new DataView(
    storage.buffer,
    storage.byteOffset,
    storage.byteLength,
  );
  return {
    psize: view.getUint32(MDB_STAT_PSIZE_OFFSET, true),
    depth: view.getUint32(MDB_STAT_DEPTH_OFFSET, true),
    branchPages: view.getBigUint64(MDB_STAT_BRANCH_OFFSET, true),
    leafPages: view.getBigUint64(MDB_STAT_LEAF_OFFSET, true),
    overflowPages: view.getBigUint64(MDB_STAT_OVERFLOW_OFFSET, true),
    entries: view.getBigUint64(MDB_STAT_ENTRIES_OFFSET, true),
  };
}

/** Allocates zeroed storage for an `MDB_envinfo`. */
export function envInfoStorage(): Uint8Array {
  return new Uint8Array(MDB_ENVINFO_SIZE);
}

/** Decodes an `MDB_envinfo` using the verified field offsets. */
export function readEnvInfo(storage: Uint8Array): MdbEnvInfo {
  requireSize(storage, MDB_ENVINFO_SIZE, 'MDB_envinfo');
  const view = new DataView(
    storage.buffer,
    storage.byteOffset,
    storage.byteLength,
  );
  return {
    mapAddress: view.getBigUint64(MDB_ENVINFO_MAPADDR_OFFSET, true),
    mapSize: view.getBigUint64(MDB_ENVINFO_MAPSIZE_OFFSET, true),
    lastPageNumber: view.getBigUint64(MDB_ENVINFO_LAST_PGNO_OFFSET, true),
    lastTxnId: view.getBigUint64(MDB_ENVINFO_LAST_TXNID_OFFSET, true),
    maxReaders: view.getUint32(MDB_ENVINFO_MAXREADERS_OFFSET, true),
    numReaders: view.getUint32(MDB_ENVINFO_NUMREADERS_OFFSET, true),
  };
}

function requireSize(
  storage: Uint8Array,
  expected: number,
  structure: string,
): void {
  if (storage.byteLength !== expected) {
    throw new RangeError(
      `${structure} requires ${expected} bytes, received ${storage.byteLength}`,
    );
  }
}
