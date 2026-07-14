import {
  decodeString,
  encodeKey,
  encodeString,
  type Key,
} from '../encoding.ts';
import { checkLmdbResult, checkNodeWriteResult } from './errors.ts';
import type { Version } from '../types.ts';
import type { LoadedLibrary } from './library.ts';
import { loadLibrary } from './library.ts';
import {
  assertSupportedAbi,
  copyBytes,
  cString,
  envInfoStorage,
  type MutableMdbVal,
  mutableMdbVal,
  type OwnedMdbVal,
  pointerFromSlot,
  pointerSlot,
  readEnvInfo,
  readMdbVal,
  readStat,
  statStorage,
  viewBytes,
} from './memory.ts';

const MDB_NOTFOUND = -30798;

/** Cursor operations from LMDB 1.0.0. */
export enum CursorOperation {
  MDB_FIRST,
  MDB_FIRST_DUP,
  MDB_GET_BOTH,
  MDB_GET_BOTH_RANGE,
  MDB_GET_CURRENT,
  MDB_GET_MULTIPLE,
  MDB_LAST,
  MDB_LAST_DUP,
  MDB_NEXT,
  MDB_NEXT_DUP,
  MDB_NEXT_MULTIPLE,
  MDB_NEXT_NODUP,
  MDB_PREV,
  MDB_PREV_DUP,
  MDB_PREV_NODUP,
  MDB_SET,
  MDB_SET_KEY,
  MDB_SET_RANGE,
  MDB_PREV_MULTIPLE,
}

/** Native operations used by the public wrappers and internal Workers. */
export interface NativeApi {
  envCreate(): Deno.PointerObject;
  envOpen(env: Deno.PointerObject, path: string, flags: number): void;
  envSetMaxDbs(env: Deno.PointerObject, maxDbs: number): void;
  envSetMaxReaders(env: Deno.PointerObject, maxReaders: number): void;
  envSetMapSize(env: Deno.PointerObject, size: number | bigint): void;
  envGetFlags(env: Deno.PointerObject): number;
  envStat(env: Deno.PointerObject): NativeStat;
  envInfo(env: Deno.PointerObject): NativeEnvInfo;
  envCopy(
    env: Deno.PointerObject,
    path: string,
    compact: boolean,
  ): Promise<void>;
  envSync(env: Deno.PointerObject, force: boolean): Promise<void>;
  envClose(env: Deno.PointerObject): void;
  txnBegin(
    env: Deno.PointerObject,
    readOnly: boolean,
    parent?: Deno.PointerObject | null,
  ): Deno.PointerObject;
  txnCommit(txn: Deno.PointerObject): void;
  txnAbort(txn: Deno.PointerObject): void;
  txnReset(txn: Deno.PointerObject): void;
  txnRenew(txn: Deno.PointerObject): void;
  dbiOpen(
    txn: Deno.PointerObject,
    name: string | null | undefined,
    flags: number,
  ): number;
  dbiClose(env: Deno.PointerObject, dbi: number): void;
  get(
    txn: Deno.PointerObject,
    dbi: number,
    key: Uint8Array,
  ): Uint8Array | null;
  getUnsafe(
    txn: Deno.PointerObject,
    dbi: number,
    key: Uint8Array,
  ): Uint8Array | null;
  put(
    txn: Deno.PointerObject,
    dbi: number,
    key: Uint8Array,
    value: Uint8Array,
    flags: number,
  ): void;
  del(
    txn: Deno.PointerObject,
    dbi: number,
    key: Uint8Array,
    value?: Uint8Array,
  ): void;
  drop(txn: Deno.PointerObject, dbi: number, del: boolean): void;
  stat(txn: Deno.PointerObject, dbi: number): NativeStat;
  cursorOpen(txn: Deno.PointerObject, dbi: number): Deno.PointerObject;
  cursorClose(cursor: Deno.PointerObject): void;
  cursorGet(
    cursor: Deno.PointerObject,
    key: Uint8Array | undefined,
    value: Uint8Array | undefined,
    operation: CursorOperation,
    unsafeData: boolean,
  ): { key: Uint8Array; data: Uint8Array } | null;
  cursorDel(cursor: Deno.PointerObject, noDupData: boolean): void;
}

export interface NativeStat {
  readonly psize: number;
  readonly depth: number;
  readonly branch_pages: bigint;
  readonly leaf_pages: bigint;
  readonly overflow_pages: bigint;
  readonly entries: bigint;
}

export interface NativeEnvInfo {
  readonly mapaddr: bigint;
  readonly mapsize: bigint;
  readonly last_pgno: bigint;
  readonly last_tnxid: bigint;
  readonly maxreaders: number;
  readonly numreaders: number;
}

/** Builds ABI-checked native operations around a retained LMDB library. */
export function createNativeApi(library: LoadedLibrary): NativeApi {
  assertSupportedAbi();
  const symbols = library.handle.symbols;
  const check = (code: number): void =>
    checkLmdbResult(code, symbols.mdb_strerror);
  const checkNodeWrite = (code: number): void =>
    checkNodeWriteResult(code, symbols.mdb_strerror);
  const keyScratch = mutableMdbVal();
  const dataScratch = mutableMdbVal();

  function prepareScratch(
    scratch: MutableMdbVal,
    value: Uint8Array | undefined,
  ): void {
    if (value === undefined) scratch.clear();
    else scratch.setInput(value);
  }

  function clearScratch(): void {
    keyScratch.clear();
    dataScratch.clear();
  }

  function readValue(
    owned: OwnedMdbVal,
    copy: boolean,
  ): Uint8Array {
    const { length, pointer } = readMdbVal(owned);
    if (length === 0) return new Uint8Array();
    if (pointer === null) {
      throw new Error('LMDB returned a null pointer for a non-empty value');
    }
    return copy ? copyBytes(pointer, length) : viewBytes(pointer, length);
  }

  function getValue(
    txn: Deno.PointerObject,
    dbi: number,
    key: Uint8Array,
    copy: boolean,
  ): Uint8Array | null {
    try {
      keyScratch.setInput(key);
      dataScratch.clear();
      const code = symbols.mdb_get(
        txn,
        dbi,
        keyScratch.storage,
        dataScratch.storage,
      );
      if (code === MDB_NOTFOUND) return null;
      check(code);
      return readValue(dataScratch, copy);
    } finally {
      clearScratch();
    }
  }

  return {
    envCreate() {
      const slot = pointerSlot();
      check(symbols.mdb_env_create(slot));
      return pointerFromSlot(slot);
    },
    envOpen(env, path, flags) {
      const pathString = cString(path);
      check(symbols.mdb_env_open(env, pathString, flags, 0o664));
    },
    envSetMaxDbs(env, maxDbs) {
      check(symbols.mdb_env_set_maxdbs(env, maxDbs));
    },
    envSetMaxReaders(env, maxReaders) {
      check(symbols.mdb_env_set_maxreaders(env, maxReaders));
    },
    envSetMapSize(env, size) {
      check(symbols.mdb_env_set_mapsize(env, BigInt(size)));
    },
    envGetFlags(env) {
      const flags = new Uint32Array(1);
      check(symbols.mdb_env_get_flags(env, flags));
      return flags[0];
    },
    envStat(env) {
      const output = statStorage();
      check(symbols.mdb_env_stat(env, output));
      const value = readStat(output);
      return {
        psize: value.psize,
        depth: value.depth,
        branch_pages: value.branchPages,
        leaf_pages: value.leafPages,
        overflow_pages: value.overflowPages,
        entries: value.entries,
      };
    },
    envInfo(env) {
      const output = envInfoStorage();
      check(symbols.mdb_env_info(env, output));
      const value = readEnvInfo(output);
      return {
        mapaddr: value.mapAddress,
        mapsize: value.mapSize,
        last_pgno: value.lastPageNumber,
        last_tnxid: value.lastTxnId,
        maxreaders: value.maxReaders,
        numreaders: value.numReaders,
      };
    },
    async envCopy(env, path, compact) {
      const pathString = cString(path);
      try {
        check(
          await symbols.mdb_env_copy2(
            env,
            pathString,
            compact ? 1 : 0,
          ),
        );
      } finally {
        // Nonblocking FFI borrows both values until the native call settles.
        void env;
        void pathString;
      }
    },
    async envSync(env, force) {
      try {
        checkNodeWrite(await symbols.mdb_env_sync(env, force ? 1 : 0));
      } finally {
        // Keep the pointer object live for the complete nonblocking FFI call.
        void env;
      }
    },
    envClose(env) {
      symbols.mdb_env_close(env);
    },
    txnBegin(env, readOnly, parent = null) {
      const slot = pointerSlot();
      checkNodeWrite(
        symbols.mdb_txn_begin(
          env,
          parent,
          readOnly ? 0x20000 : 0,
          slot,
        ),
      );
      return pointerFromSlot(slot);
    },
    txnCommit(txn) {
      check(symbols.mdb_txn_commit(txn));
    },
    txnAbort(txn) {
      symbols.mdb_txn_abort(txn);
    },
    txnReset(txn) {
      symbols.mdb_txn_reset(txn);
    },
    txnRenew(txn) {
      check(symbols.mdb_txn_renew(txn));
    },
    dbiOpen(txn, name, flags) {
      const output = new Uint32Array(1);
      const nameString = name === null || name === undefined
        ? undefined
        : cString(name);
      checkNodeWrite(
        symbols.mdb_dbi_open(
          txn,
          nameString ?? null,
          flags,
          output,
        ),
      );
      return output[0];
    },
    dbiClose(env, dbi) {
      symbols.mdb_dbi_close(env, dbi);
    },
    get(txn, dbi, key) {
      return getValue(txn, dbi, key, true);
    },
    getUnsafe(txn, dbi, key) {
      return getValue(txn, dbi, key, false);
    },
    put(txn, dbi, key, value, flags) {
      try {
        keyScratch.setInput(key);
        dataScratch.setInput(value);
        checkNodeWrite(
          symbols.mdb_put(
            txn,
            dbi,
            keyScratch.storage,
            dataScratch.storage,
            flags,
          ),
        );
      } finally {
        clearScratch();
      }
    },
    del(txn, dbi, key, value) {
      try {
        keyScratch.setInput(key);
        prepareScratch(dataScratch, value);
        checkNodeWrite(
          symbols.mdb_del(
            txn,
            dbi,
            keyScratch.storage,
            value === undefined ? null : dataScratch.storage,
          ),
        );
      } finally {
        clearScratch();
      }
    },
    drop(txn, dbi, del) {
      checkNodeWrite(symbols.mdb_drop(txn, dbi, del ? 1 : 0));
    },
    stat(txn, dbi) {
      const output = statStorage();
      check(symbols.mdb_stat(txn, dbi, output));
      const value = readStat(output);
      return {
        psize: value.psize,
        depth: value.depth,
        branch_pages: value.branchPages,
        leaf_pages: value.leafPages,
        overflow_pages: value.overflowPages,
        entries: value.entries,
      };
    },
    cursorOpen(txn, dbi) {
      const slot = pointerSlot();
      check(symbols.mdb_cursor_open(txn, dbi, slot));
      return pointerFromSlot(slot);
    },
    cursorClose(cursor) {
      symbols.mdb_cursor_close(cursor);
    },
    cursorGet(cursor, key, value, operation, unsafeData) {
      try {
        prepareScratch(keyScratch, key);
        prepareScratch(dataScratch, value);
        const code = symbols.mdb_cursor_get(
          cursor,
          keyScratch.storage,
          dataScratch.storage,
          operation,
        );
        if (code === MDB_NOTFOUND) return null;
        check(code);
        return {
          key: readValue(keyScratch, true),
          data: readValue(dataScratch, !unsafeData),
        };
      } finally {
        clearScratch();
      }
    },
    cursorDel(cursor, noDupData) {
      checkNodeWrite(symbols.mdb_cursor_del(cursor, noDupData ? 0x20 : 0));
    },
  };
}

const WORKER_LIBRARY_SLOT = '__denoLmdbWorkerLibrary';
const workerGlobal = globalThis as typeof globalThis & {
  [WORKER_LIBRARY_SLOT]?: LoadedLibrary;
};
const loadedLibrary = workerGlobal[WORKER_LIBRARY_SLOT] ?? loadLibrary();
delete workerGlobal[WORKER_LIBRARY_SLOT];
const defaultApi = createNativeApi(loadedLibrary);

/** @internal Returns the process-default native API for shared executors. */
export function getDefaultNativeApi(): NativeApi {
  return defaultApi;
}

/** @internal Returns the retained library used by public environment wrappers. */
export function getDefaultLibrary(): LoadedLibrary {
  return loadedLibrary;
}

/**
 * Version metadata for the loaded LMDB shared library.
 *
 * `major`, `minor`, and `patch` are probed from `mdb_version` and accepted only
 * when they equal 1.0.0. `versionString` is the canonical string pinned from
 * the checksum-verified LMDB 1.0.0 header: path-scoped FFI permission can
 * invoke the probe but cannot decode its returned native pointer.
 */
export const version: Readonly<Version> = Object.freeze({
  ...loadedLibrary.version,
});

/** Legacy-compatible internal key type used until the public type pass. */
export type KeyType = Key | undefined;

export const env_create = defaultApi.envCreate;
export const env_open = defaultApi.envOpen;
export const env_set_maxdbs = defaultApi.envSetMaxDbs;
export const env_set_maxreaders = defaultApi.envSetMaxReaders;
export const env_set_mapsize = defaultApi.envSetMapSize;
export const env_get_flags = defaultApi.envGetFlags;
export const env_close = defaultApi.envClose;
export const env_stat = defaultApi.envStat;
export const env_copy = defaultApi.envCopy;
export const env_sync = defaultApi.envSync;
export const env_info = defaultApi.envInfo;
export const dbi_open = defaultApi.dbiOpen;
export const dbi_close = defaultApi.dbiClose;
export const txn_abort = defaultApi.txnAbort;
export const txn_renew = defaultApi.txnRenew;
export const txn_reset = defaultApi.txnReset;
export const txn_commit = defaultApi.txnCommit;
export const cursor_open = defaultApi.cursorOpen;
export const cursor_close = defaultApi.cursorClose;
export const drop = defaultApi.drop;
export const stat = defaultApi.stat;

export function txn_begin(
  env: Deno.PointerObject,
  parent: Deno.PointerObject | null,
  readOnly?: boolean,
): Deno.PointerObject {
  return defaultApi.txnBegin(env, Boolean(readOnly), parent);
}

export function cursor_get(
  cursor: Deno.PointerObject,
  key: Uint8Array | undefined,
  data: Uint8Array | undefined,
  operation: CursorOperation,
  unsafeData = false,
): { key: Uint8Array; data: Uint8Array } | null {
  return defaultApi.cursorGet(
    cursor,
    key,
    data,
    operation,
    unsafeData,
  );
}

export function cursor_del(
  cursor: Deno.PointerObject,
  noDupData?: boolean,
): void {
  defaultApi.cursorDel(cursor, Boolean(noDupData));
}

export function get(
  txn: Deno.PointerObject,
  dbi: number,
  key: KeyType,
): Uint8Array | null {
  if (key === undefined) throw new TypeError('LMDB key is required');
  return defaultApi.get(txn, dbi, encodeKey(key));
}

export function getUnsafe(
  txn: Deno.PointerObject,
  dbi: number,
  key: KeyType,
): Uint8Array | null {
  if (key === undefined) throw new TypeError('LMDB key is required');
  return defaultApi.getUnsafe(txn, dbi, encodeKey(key));
}

export function put(
  txn: Deno.PointerObject,
  dbi: number,
  key: KeyType,
  value: Uint8Array,
  flags: number,
): void {
  if (key === undefined) throw new TypeError('LMDB key is required');
  defaultApi.put(txn, dbi, encodeKey(key), value, flags);
}

export function del(
  txn: Deno.PointerObject,
  dbi: number,
  key: KeyType,
  value?: Uint8Array,
): void {
  if (key === undefined) throw new TypeError('LMDB key is required');
  defaultApi.del(txn, dbi, encodeKey(key), value);
}

export const encodeUtf16Le = encodeString;
export const decodeUtf16Le = decodeString;
