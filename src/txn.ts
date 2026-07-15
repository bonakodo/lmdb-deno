import {
  decodeNumber,
  decodeString,
  encodeBoolean,
  encodeKey,
  encodeNumber,
  encodeString,
} from './encoding.ts';
import * as lmdb from './native/api.ts';
import type { Dbi } from './dbi.ts';
import type { Env } from './env.ts';
import {
  assertSameSharedEnvironment,
  assertTxnActive,
  assertTxnReset,
  clearTxnHandle,
  type DeferredDbiClose,
  getDbiFlags,
  getDbiHandleForTxn,
  getDbiKeyFormat,
  getEnvHandle,
  getTxnHandle,
  hasOwnedWriteTransaction,
  invalidatePendingDbis,
  invalidateTransactionCursorCachesForWrite,
  markTxnRenewed,
  markTxnReset,
  prepareTransactionCursorsForEnd,
  promotePendingDbis,
  registerOwnedTransaction,
  registerTxnHandle,
  unregisterOwnedTransaction,
} from './internal/native_state.ts';
import type { Key, KeyType, PutOptions, TxnOptions, Value } from './types.ts';

const MDB_DUPSORT = 0x04;
const MDB_NOOVERWRITE = 0x10;
const MDB_NODUPDATA = 0x20;
const MDB_APPEND = 0x20000;
const MDB_APPENDDUP = 0x40000;

type KeyKind = 'string' | 'uint32' | 'buffer';

/**
 * Provides an isolated read snapshot or one atomic write transaction.
 *
 * Finish each transaction exactly once with {@link Txn.commit} or
 * {@link Txn.abort}. Cursors and unsafe binary views borrow transaction state
 * and must not outlive it. Read-only cursors require explicit close; write
 * transaction termination auto-closes their native cursors and invalidates the
 * wrappers. Only read-only transactions support {@link Txn.reset} and
 * {@link Txn.renew}.
 *
 * @example Commit typed values atomically.
 * ```ts
 * const txn = env.beginTxn();
 * txn.putString(db, 'name', 'Ada');
 * txn.putNumber(db, 'score', 42);
 * txn.commit();
 * ```
 */
export class Txn {
  #env: Env;
  #registered = false;

  /** `true` when this transaction is a read-only snapshot. */
  readonly isReadonly: boolean;

  /**
   * Begins a transaction owned by `env`.
   *
   * Prefer {@link Env.beginTxn}, which delegates here.
   *
   * @param env Open environment that owns the transaction.
   * @param options Set `readOnly` for a reader; omitted means a writer.
   * @throws {Error} If the environment is unavailable or already has a writer.
   */
  constructor(env: Env, options?: TxnOptions) {
    this.#env = env;
    const readonly = options?.readOnly === true;
    this.isReadonly = readonly;
    if (!readonly && hasOwnedWriteTransaction(env)) {
      throw new Error(
        "You have already opened a write transaction in the current process, can't open a second one.",
      );
    }

    const handle = lmdb.txn_begin(getEnvHandle(env), null, readonly);
    registerTxnHandle(this, handle);
    try {
      registerOwnedTransaction(env, this, readonly);
      this.#registered = true;
    } catch (error) {
      lmdb.txn_abort(handle);
      clearTxnHandle(this);
      throw error;
    }
  }

  /**
   * Reads a zero-terminated UTF-16LE string into durable JavaScript memory.
   *
   * @param dbi Database from the same environment.
   * @param key Key to look up.
   * @param options Optional key-encoding override.
   * @returns The decoded string, or `null` when the key is absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * incompatible, the key encoding is invalid, or the native read fails.
   */
  getString(dbi: Dbi, key: Key, options?: KeyType): string | null {
    const result = this.#get(dbi, key, options, false);
    return result === null ? null : decodeString(result);
  }

  /**
   * Reads through node-lmdb's unsafe string API, returning a durable copy.
   *
   * Pure TypeScript cannot create V8 external two-byte strings, so this method
   * intentionally has the same value semantics as {@link Txn.getString} but
   * does not provide node-lmdb's external-string allocation optimization.
   *
   * @param dbi Database from the same environment.
   * @param key Key to look up.
   * @param options Optional key-encoding override.
   * @returns The decoded string copy, or `null` when absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * incompatible, the key encoding is invalid, or the native read fails.
   */
  getStringUnsafe(dbi: Dbi, key: Key, options?: KeyType): string | null {
    const result = this.#get(dbi, key, options, false);
    return result === null ? null : decodeString(result);
  }

  /**
   * Reads binary data into a durable `Uint8Array` copy.
   *
   * @param dbi Database from the same environment.
   * @param key Key to look up.
   * @param options Optional key-encoding override.
   * @returns Copied bytes, or `null` when the key is absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * incompatible, the key encoding is invalid, or the native read fails.
   */
  getBinary(
    dbi: Dbi,
    key: Key,
    options?: KeyType,
  ): Uint8Array | null {
    return this.#get(dbi, key, options, false);
  }

  /**
   * Reads an LMDB-backed zero-copy `Uint8Array` view.
   *
   * The view borrows the active transaction and may be invalidated by later
   * writes, reset/renew, commit, abort, or environment closure. Consume it
   * immediately or detach `view.buffer` through {@link Env.detachBuffer}
   * before ending the transaction. Use {@link Txn.getBinary} for durable data.
   *
   * @param dbi Database from the same environment.
   * @param key Key to look up.
   * @param options Optional key-encoding override.
   * @returns A borrowed zero-copy view, or `null` when absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * incompatible, the key encoding is invalid, or the native read fails.
   */
  getBinaryUnsafe(
    dbi: Dbi,
    key: Key,
    options?: KeyType,
  ): Uint8Array | null {
    return this.#get(dbi, key, options, true);
  }

  /**
   * Reads a node-lmdb native-endian IEEE-754 double.
   *
   * @param dbi Database from the same environment.
   * @param key Key to look up.
   * @param options Optional key-encoding override.
   * @returns The number, or `null` when the key is absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * incompatible, the key encoding is invalid, the stored bytes are too short
   * for a number, or the native read fails.
   */
  getNumber(dbi: Dbi, key: Key, options?: KeyType): number | null {
    const result = this.#get(dbi, key, options, false);
    return result === null ? null : decodeNumber(result);
  }

  /**
   * Reads a node-lmdb-compatible one-byte boolean.
   *
   * @param dbi Database from the same environment.
   * @param key Key to look up.
   * @param options Optional key-encoding override.
   * @returns The boolean, or `null` when the key is absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * incompatible, the key encoding is invalid, or the native read fails.
   */
  getBoolean(dbi: Dbi, key: Key, options?: KeyType): boolean | null {
    const result = this.#get(dbi, key, options, false);
    if (result === null) return null;
    return result.byteLength !== 0 && result[0] !== 0;
  }

  /**
   * Stores a zero-terminated UTF-16LE string in this write transaction.
   *
   * @param dbi Database from the same environment.
   * @param key Key to store.
   * @param value JavaScript string to encode.
   * @param options Put flags and optional key encoding.
   * @throws {TypeError} If the key/options are invalid or `value` is not a
   * string.
   * @throws {Error} Synchronously if this transaction/database is unusable,
   * key encoding is invalid, or LMDB rejects the write.
   */
  putString(
    dbi: Dbi,
    key: Key,
    value: string,
    options?: PutOptions,
  ): void {
    if (typeof value !== 'string') {
      throw new TypeError('Value must be a string.');
    }
    this.#put(dbi, key, encodeString(value), options);
  }

  /**
   * Stores binary bytes from a `Uint8Array`.
   *
   * @param dbi Database from the same environment.
   * @param key Key to store.
   * @param value Bytes borrowed for the duration of the native call.
   * @param options Put flags and optional key encoding.
   * @throws {TypeError} If the key/options are invalid or `value` is not a
   * `Uint8Array`.
   * @throws {Error} Synchronously if this transaction/database is unusable,
   * key encoding is invalid, or LMDB rejects the write.
   */
  putBinary(
    dbi: Dbi,
    key: Key,
    value: Uint8Array,
    options?: PutOptions,
  ): void {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError('Value must be a Uint8Array.');
    }
    this.#put(dbi, key, value, options);
  }

  /**
   * Stores a node-lmdb native-endian IEEE-754 double.
   *
   * @param dbi Database from the same environment.
   * @param key Key to store.
   * @param value Number to encode.
   * @param options Put flags and optional key encoding.
   * @throws {TypeError} If the key/options are invalid or `value` is not a
   * number.
   * @throws {Error} Synchronously if this transaction/database is unusable,
   * key encoding is invalid, or LMDB rejects the write.
   */
  putNumber(
    dbi: Dbi,
    key: Key,
    value: number,
    options?: PutOptions,
  ): void {
    if (typeof value !== 'number') {
      throw new TypeError('Value must be a number.');
    }
    this.#put(dbi, key, encodeNumber(value), options);
  }

  /**
   * Stores a node-lmdb-compatible one-byte boolean.
   *
   * @param dbi Database from the same environment.
   * @param key Key to store.
   * @param value Boolean to encode.
   * @param options Put flags and optional key encoding.
   * @throws {TypeError} If the key/options are invalid or `value` is not a
   * boolean.
   * @throws {Error} Synchronously if this transaction/database is unusable,
   * key encoding is invalid, or LMDB rejects the write.
   */
  putBoolean(
    dbi: Dbi,
    key: Key,
    value: boolean,
    options?: PutOptions,
  ): void {
    if (typeof value !== 'boolean') {
      throw new TypeError('Value must be a boolean.');
    }
    this.#put(dbi, key, encodeBoolean(value), options);
  }

  /**
   * Deletes a key, or one exact duplicate-sorted key/value pair.
   *
   * With no trailing argument (or one key-options object), every value for the
   * key is deleted. Supply a typed value and optional key options to delete
   * only that pair from a `dupSort` database. For a database without
   * `dupSort`, node-lmdb compatibility ignores the value and deletes the key.
   *
   * @param dbi Database from the same environment.
   * @param key Key to delete.
   * @param args Nothing, `[options?]`, `[data]`, or `[data, options?]`.
   * @throws {TypeError} If key, value, or option types are invalid.
   * @throws {Error} Synchronously if this transaction/database is unusable,
   * encoding is invalid, requested data is absent, or LMDB rejects deletion.
   *
   * @example Delete one duplicate value.
   * ```ts
   * const txn = env.beginTxn();
   * txn.del(tags, 'language', 'TypeScript');
   * txn.commit();
   * ```
   */
  del(
    dbi: Dbi,
    key: Key,
    ...args:
      | []
      | [options: KeyType | undefined]
      | [data: Value]
      | [data: Value, options: KeyType | undefined]
  ): void {
    const [dataOrOptions, explicitOptions] = args;
    assertSameSharedEnvironment(this, dbi);
    assertTxnActive(this);

    const thirdArgumentIsOptions = isKeyType(dataOrOptions) &&
      explicitOptions === undefined;
    const keyOptions = thirdArgumentIsOptions ? dataOrOptions : explicitOptions;
    const encodedKey = encodeTransactionKey(dbi, key, keyOptions);
    const hasData = dataOrOptions !== undefined && !thirdArgumentIsOptions;
    const data = hasData && (getDbiFlags(dbi) & MDB_DUPSORT) !== 0
      ? encodeDeleteValue(dataOrOptions as Value)
      : undefined;

    const txn = getTxnHandle(this);
    const dbiHandle = getDbiHandleForTxn(dbi, this);
    invalidateTransactionCursorCachesForWrite(this);
    lmdb.del(txn, dbiHandle, encodedKey, data);
  }

  /**
   * Commits this transaction and makes it terminal.
   *
   * Pending DBI handles become live only after a successful commit. A failed
   * native commit still closes the wrapper and invalidates pending handles.
   * Read-only cursors require a later explicit `close()` of their wrappers;
   * LMDB auto-closes write-transaction native cursors. No cursor or unsafe view
   * may be used afterward.
   *
   * @throws {Error} Synchronously if the transaction is inactive or native
   * commit fails.
   */
  commit(): void {
    const txn = getTxnHandle(this);
    let committed = false;
    try {
      prepareTransactionCursorsForEnd(this);
      lmdb.txn_commit(txn);
      committed = true;
      closeDeferredDbis(promotePendingDbis(this));
    } finally {
      if (!committed) closeDeferredDbis(invalidatePendingDbis(this));
      clearTxnHandle(this);
      this.#removeFromEnv();
    }
  }

  /**
   * Aborts this transaction and makes it terminal.
   *
   * Pending DBI handles, cursors, and unsafe views become invalid. Read-only
   * cursor wrappers still require explicit `close()`; LMDB auto-closes native
   * cursors owned by a write transaction.
   *
   * @throws {Error} Synchronously if the transaction is no longer active.
   */
  abort(): void {
    const txn = getTxnHandle(this);
    try {
      prepareTransactionCursorsForEnd(this);
      lmdb.txn_abort(txn);
    } finally {
      closeDeferredDbis(invalidatePendingDbis(this));
      clearTxnHandle(this);
      this.#removeFromEnv();
    }
  }

  /**
   * Resets an active read-only transaction while retaining its reader slot.
   *
   * Reset invalidates its snapshot, cursors, and unsafe views. Call
   * {@link Txn.renew} before reading again.
   *
   * @throws {Error} Synchronously if this is a writer or is not active.
   */
  reset(): void {
    if (!this.isReadonly) {
      throw new Error('Only read-only transactions can be reset');
    }
    assertTxnActive(this);
    prepareTransactionCursorsForEnd(this);
    lmdb.txn_reset(getTxnHandle(this));
    markTxnReset(this);
  }

  /**
   * Renews a reset read-only transaction with the latest snapshot.
   *
   * @throws {Error} Synchronously if this is a writer, is not currently reset,
   * or native renewal fails.
   */
  renew(): void {
    if (!this.isReadonly) {
      throw new Error('Only read-only transactions can be renewed');
    }
    assertTxnReset(this);
    lmdb.txn_renew(getTxnHandle(this));
    markTxnRenewed(this);
  }

  #get(
    dbi: Dbi,
    key: Key,
    options: KeyType | undefined,
    unsafe: boolean,
  ): Uint8Array | null {
    assertSameSharedEnvironment(this, dbi);
    assertTxnActive(this);
    const encodedKey = encodeTransactionKey(dbi, key, options);
    return unsafe
      ? lmdb.getUnsafe(
        getTxnHandle(this),
        getDbiHandleForTxn(dbi, this),
        encodedKey,
      )
      : lmdb.get(
        getTxnHandle(this),
        getDbiHandleForTxn(dbi, this),
        encodedKey,
      );
  }

  #put(
    dbi: Dbi,
    key: Key,
    data: Uint8Array,
    options?: PutOptions,
  ): void {
    assertSameSharedEnvironment(this, dbi);
    assertTxnActive(this);
    const encodedKey = encodeTransactionKey(dbi, key, options);
    let flags = 0;
    if (options?.append === true) flags |= MDB_APPEND;
    if (options?.noOverwrite === true) flags |= MDB_NOOVERWRITE;
    if (options?.noDupData === true) flags |= MDB_NODUPDATA;
    if (options?.appendDup === true) flags |= MDB_APPENDDUP;
    const txn = getTxnHandle(this);
    const dbiHandle = getDbiHandleForTxn(dbi, this);
    invalidateTransactionCursorCachesForWrite(this);
    lmdb.put(txn, dbiHandle, encodedKey, data, flags);
  }

  #removeFromEnv(): void {
    if (!this.#registered) return;
    this.#registered = false;
    unregisterOwnedTransaction(this.#env, this);
  }
}

function closeDeferredDbis(closes: DeferredDbiClose[]): void {
  for (const close of closes) {
    lmdb.dbi_close(close.environment, close.handle);
  }
}

function encodeTransactionKey(
  dbi: Dbi,
  key: Key,
  options?: KeyType,
): Uint8Array {
  const explicitKind = keyKindFromOptions(options);
  const inferredKind = inferKeyKind(key);
  if (explicitKind !== undefined && explicitKind !== inferredKind) {
    throw new Error("Specified key type doesn't match the key you gave.");
  }

  const dbiFormat = getDbiKeyFormat(dbi);
  if ('keyIsUint32' in dbiFormat && inferredKind !== 'uint32') {
    throw new Error(
      "You specified keyIsUint32 on the Dbi, so you can't use other key types with it.",
    );
  }

  if (inferredKind === 'uint32') {
    return encodeKey(key, { keyIsUint32: true });
  }
  if (inferredKind === 'buffer') {
    return encodeKey(key, { keyIsBuffer: true });
  }
  return encodeKey(key, { keyIsString: true });
}

function keyKindFromOptions(options?: KeyType): KeyKind | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== 'object') {
    throw new TypeError(
      'keyTypeFromOptions: Invalid argument passed to a node-lmdb function, must be an object.',
    );
  }
  const uint32 = options.keyIsUint32 === true;
  const buffer = options.keyIsBuffer === true;
  const string = options.keyIsString === true;
  if (Number(uint32) + Number(buffer) + Number(string) > 1) {
    throw new Error(
      "You can't specify multiple key types at once. Either set keyIsUint32, or keyIsBuffer or keyIsString (default).",
    );
  }
  if (uint32) return 'uint32';
  if (buffer) return 'buffer';
  if (string) return 'string';
  return undefined;
}

function inferKeyKind(key: Key): KeyKind {
  if (typeof key === 'string') return 'string';
  if (typeof key === 'number') return 'uint32';
  if (key instanceof Uint8Array) return 'buffer';
  throw new TypeError('Invalid key type');
}

function isKeyType(value: Value | KeyType | undefined): value is KeyType {
  return typeof value === 'object' && value !== null &&
    !(value instanceof Uint8Array);
}

function encodeDeleteValue(value: Value): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'boolean') return encodeBoolean(value);
  throw new TypeError('Invalid data type.');
}
