import type { Dbi } from './dbi.ts';
import type { Txn } from './txn.ts';

/**
 * A key accepted by LMDB operations.
 *
 * Strings use node-lmdb's zero-terminated UTF-16LE representation, numbers
 * are native unsigned 32-bit integers, and binary keys use `Uint8Array`.
 */
export type Key = string | number | Uint8Array;

/**
 * A value accepted by typed transactions and cursor conditions.
 *
 * `Uint8Array` is the deliberate Deno replacement for every Node.js `Buffer`
 * position in node-lmdb. Batch values are currently binary-only at runtime;
 * see {@link BatchOperation}.
 */
export type Value = string | number | boolean | Uint8Array;

/**
 * Selects exactly one key encoding for an operation.
 *
 * The key's JavaScript type must agree with the selected encoding. When no
 * flag is set, the database's key encoding is used.
 */
export type KeyType =
  | {
    /** Encode the key as a native unsigned 32-bit integer. */
    keyIsUint32?: boolean;
    /** Mutually exclusive with `keyIsUint32`; do not set in this variant. */
    keyIsBuffer?: never;
    /** Mutually exclusive with `keyIsUint32`; do not set in this variant. */
    keyIsString?: never;
  }
  | {
    /** Mutually exclusive with `keyIsBuffer`; do not set in this variant. */
    keyIsUint32?: never;
    /** Treat the key as binary data represented by `Uint8Array`. */
    keyIsBuffer?: boolean;
    /** Mutually exclusive with `keyIsBuffer`; do not set in this variant. */
    keyIsString?: never;
  }
  | {
    /** Mutually exclusive with `keyIsString`; do not set in this variant. */
    keyIsUint32?: never;
    /** Mutually exclusive with `keyIsString`; do not set in this variant. */
    keyIsBuffer?: never;
    /** Encode the key as a zero-terminated UTF-16 string. */
    keyIsString?: boolean;
  };

/**
 * Controls a typed put or batch put and optionally overrides key encoding.
 *
 * The append flags are LMDB performance assertions: passing data out of the
 * required sort order is an error, not a request to sort it.
 */
export type PutOptions = {
  /** Reject an existing duplicate key/value pair with `MDB_KEYEXIST`. */
  noDupData?: boolean;
  /** Reject an existing key with `MDB_KEYEXIST`. */
  noOverwrite?: boolean;
  /** Assert that keys are supplied in ascending order. */
  append?: boolean;
  /** Assert that duplicate values are supplied in ascending order. */
  appendDup?: boolean;
} & KeyType;

/**
 * Configures {@link Env.open}.
 *
 * Within one isolate, the first `Env` wrapper for a canonical path selects the
 * native environment and its options. Later same-path wrappers reuse it and
 * ignore their native option differences. `useWorker` remains wrapper-local;
 * arbitrary user-created Workers cannot attach to the shared environment.
 */
export interface EnvOptions {
  /** Filesystem path of the environment directory or, with `noSubdir`, file. */
  path: string;
  /** Positive safe-integer maximum memory-map size in bytes. */
  mapSize?: number;
  /** Positive maximum number of named databases; defaults to `1`. */
  maxDbs?: number;
  /** Positive maximum number of reader slots; defaults to `126`. */
  maxReaders?: number;
  /** Treat `path` as the data file rather than a directory. */
  noSubdir?: boolean;
  /** Open the environment without write access. */
  readOnly?: boolean;
  /** Write directly through the memory map. */
  useWritemap?: boolean;
  /**
   * Select the commit immediately preceding the latest LMDB snapshot.
   *
   * The first wrapper for a canonical path selects this native flag. A
   * successful write commit automatically clears it so the environment resumes
   * from the new latest snapshot. Native failure is reported; the wrapper never
   * falls back to the newest snapshot.
   */
  usePreviousSnapshot?: boolean;
  /** Leave newly allocated pages uninitialized before writing. */
  noMemInit?: boolean;
  /** Disable operating-system readahead. */
  noReadAhead?: boolean;
  /** Do not flush the metadata page on each commit. */
  noMetaSync?: boolean;
  /** Do not flush data pages on each commit. */
  noSync?: boolean;
  /** Flush write-map changes asynchronously. */
  mapAsync?: boolean;
  /**
   * Disable LMDB's lock file and reader table.
   *
   * This is unsafe unless the caller provides all required process-level
   * synchronization and guarantees there are no stale readers.
   */
  unsafeNoLock?: boolean;
  /**
   * Deno extension selecting persistent-Worker {@link Env.batchWrite}
   * execution. Defaults to `true`. Other operations stay on the calling
   * isolate; arbitrary user-created Workers cannot attach to the environment.
   */
  useWorker?: boolean;
}

/** Configures a transaction created by {@link Env.beginTxn}. */
export interface TxnOptions {
  /** Begin a read-only transaction when `true`; otherwise begin a writer. */
  readOnly?: boolean;
}

/**
 * Configures a named or unnamed database opened by {@link Env.openDbi}.
 *
 * Comparator flags are persistent database properties and must match the
 * flags used when the database was created.
 */
export type DbiOptions = {
  /** Database name, or `null` for the unnamed database. */
  name: string | null;
  /** Create the database when it does not exist. */
  create?: boolean;
  /** Compare keys in reverse byte order. */
  reverseKey?: boolean;
  /** Permit multiple values for one key. */
  dupSort?: boolean;
  /** Require duplicate values to have equal size. */
  dupFixed?: boolean;
  /** Compare duplicate values as native integers. */
  integerDup?: boolean;
  /** Compare duplicate values in reverse byte order. */
  reverseDup?: boolean;
  /**
   * Use this active, same-environment transaction instead of an internal one.
   * A newly created handle remains pending until that transaction commits.
   */
  txn?: Txn;
} & KeyType;

/** Configures {@link Dbi.drop}. */
export interface DropOptions {
  /** Use this active, same-environment transaction for the drop operation. */
  txn?: Txn;
  /** Empty all records but keep the database and its handle when `true`. */
  justFreePages?: boolean;
}

/** Configures deletion of the current record through {@link Cursor.del}. */
export interface DelOptions {
  /** Delete every duplicate value for the current key when `true`. */
  noDupData: boolean;
}

/**
 * Statistics returned by {@link Env.stat} and {@link Dbi.stat}.
 *
 * All values are JavaScript numbers for node-lmdb compatibility, including
 * native `size_t` values which can lose precision above `MAX_SAFE_INTEGER`.
 */
export interface Stat {
  /** Native database page size in bytes. */
  pageSize: number;
  /** Depth of the B-tree. */
  treeDepth: number;
  /** Number of branch pages. */
  treeBranchPageCount: number;
  /** Number of leaf pages. */
  treeLeafPageCount: number;
  /** Number of data entries. */
  entryCount: number;
  /** Number of overflow pages. */
  overflowPages: number;
}

/**
 * Memory-map and reader information returned by {@link Env.info}.
 *
 * All native integer fields are exposed as JavaScript numbers for node-lmdb
 * compatibility and may lose precision above `Number.MAX_SAFE_INTEGER`.
 */
export interface Info {
  /** Numeric address at which the memory map is currently mapped. */
  mapAddress: number;
  /** Current memory-map size in bytes. */
  mapSize: number;
  /** Number of the last used page. */
  lastPageNumber: number;
  /** Identifier of the most recently committed transaction. */
  lastTxnId: number;
  /** Configured maximum reader count. */
  maxReaders: number;
  /** Number of reader slots currently in use. */
  numReaders: number;
}

/** Result code for one operation in an atomic {@link Env.batchWrite}. */
export enum BatchResult {
  /** The operation was applied. */
  SUCCESS = 0,
  /** A conditional operation did not match its condition. */
  CONDITION_NOT_MET = 1,
  /** A delete operation did not find its key or value. */
  NOT_FOUND = 2,
  /** LMDB rejected the key or value size. */
  BAD_VALSIZE = 3,
}

/**
 * Object form of one batch operation.
 *
 * Although `Value` is broad for node-lmdb declaration compatibility,
 * `value` and `ifValue` accept only `Uint8Array`, `null`, or `undefined` at
 * runtime. `undefined`/`null` deletes; a `Uint8Array` puts binary bytes.
 */
export interface BatchOperation {
  /** Database targeted by the operation. */
  db: Dbi;
  /** Key targeted by the operation. */
  key: Key;
  /** Binary value to put; `null` or `undefined` deletes the key. */
  value?: Value | null;
  /** Binary prefix to match, or `null` to require a missing condition key. */
  ifValue?: Value | null;
  /** Require a complete rather than prefix match for `ifValue`. */
  ifExactMatch?: boolean;
  /** Alternate condition key; defaults to {@link BatchOperation.key}. */
  ifKey?: Key;
  /** Alternate condition database; defaults to {@link BatchOperation.db}. */
  ifDB?: Dbi;
}

/**
 * Tuple form of one batch operation: `[db, key, value?, ifValue?]`.
 *
 * Values are declared as {@link Value} for node-lmdb compatibility but are
 * binary-only (`Uint8Array`, `null`, or `undefined`) at runtime.
 */
export type BatchOperationArray =
  | [db: Dbi, key: Key]
  | [db: Dbi, key: Key, value: Value | null]
  | [
    db: Dbi,
    key: Key,
    value: Value | null,
    ifValue: Value | null,
  ];

/** Object or tuple representation accepted by {@link Env.batchWrite}. */
export type BatchOperationInput = BatchOperation | BatchOperationArray;

/**
 * Receives best-effort progress for {@link Env.batchWrite}.
 *
 * This callback may run zero or more times. The same parent-isolate array is
 * passed to progress and successful completion. It is populated in operation
 * order and may still be sparse when progress observes it.
 *
 * @param results Progressively populated, parent-owned result array.
 */
export type BatchProgress = (results: BatchResult[]) => void;

/** Controls an atomic {@link Env.batchWrite}. */
export type BatchOptions = PutOptions & {
  /** Receives zero or more best-effort progress notifications before completion. */
  progress?: BatchProgress;
};

/**
 * Completion callback for {@link Env.batchWrite}, invoked asynchronously once.
 *
 * `results` is present on success. A cooperative failure reports `error` and
 * omits `results`; a hard Worker death also permanently poisons the native
 * environment shared by same-path wrappers.
 *
 * @param error The batch failure, or `null` after a committed batch.
 * @param results One result per operation after successful completion.
 *
 * `Env.batchWrite` also accepts node-lmdb's narrower declaration
 * `(error: Error, results: BatchResult[]) => void`; the exported alias keeps
 * the actual runtime nullability and failure shape.
 */
export type BatchCallback = (
  error: Error | null,
  results?: BatchResult[],
) => void;

/**
 * Receives the asynchronous result of {@link Env.sync} exactly once.
 *
 * @param error The native sync failure, or `null` on success.
 *
 * `Env.sync` also accepts node-lmdb's narrower `(error: Error) => void`
 * declaration; this alias describes the actual success value.
 */
export type SyncCallback = (error: Error | null) => void;

/**
 * Receives the asynchronous result of {@link Env.copy} exactly once.
 *
 * @param error The native copy failure, or `null` on success.
 *
 * `Env.copy` also accepts node-lmdb's narrower `(error: Error) => void`
 * declaration; this alias describes the actual success value.
 */
export type CopyCallback = (error: Error | null) => void;

/**
 * Receives the current cursor key and decoded value after a successful read.
 *
 * The callback is not invoked when no current record exists.
 *
 * @typeParam T The decoded value type selected by the cursor getter.
 * @param key Current key in the cursor's configured representation.
 * @param value Current decoded value.
 */
export type CursorCallback<T extends Value> = (key: Key, value: T) => void;

/**
 * Read-only metadata for the exact validated LMDB 1.0.0 ABI and file format.
 *
 * The audited native layouts are limited to 64-bit little-endian macOS and
 * Linux targets.
 */
export interface Version {
  /**
   * Canonical string pinned from the checksum-verified LMDB 1.0.0 public
   * header.
   *
   * Deno path-scoped FFI permission can call `mdb_version` but cannot decode
   * its returned pointer, so this field is not read from native memory.
   */
  readonly versionString: string;
  /** Major component probed from the loaded library and validated as `1`. */
  readonly major: number;
  /** Minor component probed from the loaded library and validated as `0`. */
  readonly minor: number;
  /** Patch component probed from the loaded library and validated as `0`. */
  readonly patch: number;
}
