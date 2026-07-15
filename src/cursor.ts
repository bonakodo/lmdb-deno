import {
  decodeNumber,
  decodeString,
  decodeUint32Key,
  encodeBoolean,
  encodeKey,
  encodeNumber,
  encodeString,
} from './encoding.ts';
import * as lmdb from './native/api.ts';
import type { Dbi } from './dbi.ts';
import type { Txn } from './txn.ts';
import {
  assertSameSharedEnvironment,
  assertTxnActive,
  clearCursorHandle,
  getCursorHandle,
  getCursorHandleForClose,
  getDbiHandleForTxn,
  getDbiKeyFormat,
  getTxnHandle,
  invalidateCursorTransactionCachesForWrite,
  type NativeKeyTypeOption,
  registerCursorHandle,
} from './internal/native_state.ts';
import type {
  CursorCallback,
  DelOptions,
  Key,
  KeyType,
  Value,
} from './types.ts';

type KeyKind = 'string' | 'uint32' | 'buffer';

interface CurrentRecord {
  key?: Uint8Array;
  data?: Uint8Array;
  fallbackAllowed: boolean;
}

/**
 * Navigates the records visible to one transaction through an LMDB cursor.
 *
 * A cursor becomes invalid when it is closed, its transaction reaches a
 * terminal state, or its database wrapper is closed or dropped. Read-only
 * cursor wrappers require explicit {@link Cursor.close}; ending a write
 * transaction lets LMDB auto-close its native cursors and immediately closes
 * their JavaScript wrappers.
 *
 * @typeParam T - JavaScript representation returned for cursor keys.
 *
 * @example Iterate string keys in transaction order.
 * ```ts
 * const txn = env.beginTxn({ readOnly: true });
 * const cursor = new Cursor(txn, db);
 * for (let key = cursor.goToFirst(); key !== null; key = cursor.goToNext()) {
 *   console.log(key, cursor.getCurrentString());
 * }
 * cursor.close();
 * txn.abort();
 * ```
 */
export class Cursor<T extends Key = string> {
  readonly #keyFormat: NativeKeyTypeOption;
  readonly #current: CurrentRecord = { fallbackAllowed: true };

  /**
   * Opens a cursor for `dbi` within the active `txn`.
   *
   * @param txn Active transaction that owns the cursor and its snapshot.
   * @param dbi Database from the same environment.
   * @param keyType Optional return-key encoding; defaults to the DBI encoding.
   * @throws {TypeError} If `keyType` is not a valid key-options object.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * mismatched, key formats conflict, or native cursor creation fails.
   */
  constructor(txn: Txn, dbi: Dbi, keyType?: KeyType) {
    assertSameSharedEnvironment(txn, dbi);
    assertTxnActive(txn);

    const dbiKeyFormat = getDbiKeyFormat(dbi);
    this.#keyFormat = keyFormatFromOptions(keyType, dbiKeyFormat);
    if (
      'keyIsUint32' in dbiKeyFormat &&
      !('keyIsUint32' in this.#keyFormat)
    ) {
      throw new Error(
        "You specified keyIsUint32 on the Dbi, so you can't use other key types with it.",
      );
    }

    const cursor = lmdb.cursor_open(
      getTxnHandle(txn),
      getDbiHandleForTxn(dbi, txn),
    );
    try {
      const current = this.#current;
      registerCursorHandle(
        this,
        cursor,
        txn,
        dbi,
        txn.isReadonly,
        (fallbackAllowed) => clearCurrentRecord(current, fallbackAllowed),
      );
    } catch (error) {
      lmdb.cursor_close(cursor);
      throw error;
    }
  }

  /**
   * Moves to the first key/value pair.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The current key, or `null` when the database is empty.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native navigation fails.
   */
  goToFirst(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_FIRST);
  }

  /**
   * Moves to the last key/value pair.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The current key, or `null` when the database is empty.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native navigation fails.
   */
  goToLast(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_LAST);
  }

  /**
   * Moves to the next key/value pair, including duplicate values.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The new current key, or `null` at the end.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native navigation fails.
   */
  goToNext(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_NEXT);
  }

  /**
   * Moves to the previous key/value pair, including duplicate values.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The new current key, or `null` at the beginning.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native navigation fails.
   */
  goToPrev(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_PREV);
  }

  /**
   * Moves to an exact key.
   *
   * @param key Key in the cursor's configured representation.
   * @param options Optional explicit key encoding.
   * @returns The matched key, or `null` when absent.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously for invalid argument count, conflicting key
   * encodings, unavailable state, or native navigation failure.
   */
  goToKey(key: T, options?: KeyType): T | null {
    if (arguments.length !== 1 && arguments.length !== 2) {
      throw new Error(
        'You called cursor.goToKey with an incorrect number of arguments. Arguments are: key (mandatory), options (optional).',
      );
    }
    return this.#navigate(
      lmdb.CursorOperation.MDB_SET_KEY,
      encodeCursorKey(key, options, this.#keyFormat),
    );
  }

  /**
   * Moves to the first key greater than or equal to `key`.
   *
   * @param key Lower-bound key in the cursor's configured representation.
   * @param options Optional explicit key encoding.
   * @returns The matched key, or `null` when no key is in range.
   * @throws {TypeError} If the key or options object has an invalid type.
   * @throws {Error} Synchronously for invalid argument count, conflicting key
   * encodings, unavailable state, or native navigation failure.
   */
  goToRange(key: T, options?: KeyType): T | null {
    if (arguments.length !== 1 && arguments.length !== 2) {
      throw new Error(
        'You called cursor.goToRange with an incorrect number of arguments. Arguments are: key (mandatory), options (optional).',
      );
    }
    return this.#navigate(
      lmdb.CursorOperation.MDB_SET_RANGE,
      encodeCursorKey(key, options, this.#keyFormat),
    );
  }

  /**
   * Moves to the first duplicate value for the current key.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The current key, or `null` when no duplicate is available.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native duplicate navigation fails.
   */
  goToFirstDup(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_FIRST_DUP);
  }

  /**
   * Moves to the last duplicate value for the current key.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The current key, or `null` when no duplicate is available.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native duplicate navigation fails.
   */
  goToLastDup(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_LAST_DUP);
  }

  /**
   * Moves to the next duplicate value for the current key.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The current key, or `null` after the final duplicate.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native duplicate navigation fails.
   */
  goToNextDup(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_NEXT_DUP);
  }

  /**
   * Moves to the previous duplicate value for the current key.
   *
   * @param _options Accepted for node-lmdb signature compatibility.
   * @returns The current key, or `null` before the first duplicate.
   * @throws {Error} Synchronously if the cursor/environment/database is
   * unavailable or native duplicate navigation fails.
   */
  goToPrevDup(_options?: KeyType): T | null {
    return this.#navigate(lmdb.CursorOperation.MDB_PREV_DUP);
  }

  /**
   * Moves to an exact key/value pair in a duplicate-sorted database.
   *
   * @param key Exact key to seek.
   * @param data Exact typed duplicate value to seek.
   * @param options Optional explicit key encoding.
   * @returns The matched key, or `null` when the pair is absent.
   * @throws {TypeError} If the key, data, or options object has an invalid type.
   * @throws {Error} Synchronously for invalid argument count, conflicting key
   * encodings, unavailable state, or native navigation failure.
   */
  goToDup(key: T, data: Value, options?: KeyType): T | null {
    if (arguments.length !== 2 && arguments.length !== 3) {
      throw new Error(
        'You called cursor.goToDup with an incorrect number of arguments. Arguments are: key (mandatory), data (mandatory), options (optional).',
      );
    }
    return this.#navigate(
      lmdb.CursorOperation.MDB_GET_BOTH,
      encodeCursorKey(key, options, this.#keyFormat),
      encodeCursorValue(data),
    );
  }

  /**
   * Moves to an exact key and the first duplicate value greater than or equal
   * to `data`.
   *
   * @param key Exact key to seek.
   * @param data Lower bound for the duplicate value.
   * @param options Optional explicit key encoding.
   * @returns The matched key, or `null` when no pair is in range.
   * @throws {TypeError} If the key, data, or options object has an invalid type.
   * @throws {Error} Synchronously for invalid argument count, conflicting key
   * encodings, unavailable state, or native navigation failure.
   */
  goToDupRange(key: T, data: Value, options?: KeyType): T | null {
    if (arguments.length !== 2 && arguments.length !== 3) {
      throw new Error(
        'You called cursor.goToDupRange with an incorrect number of arguments. Arguments are: key (mandatory), data (mandatory), options (optional).',
      );
    }
    return this.#navigate(
      lmdb.CursorOperation.MDB_GET_BOTH_RANGE,
      encodeCursorKey(key, options, this.#keyFormat),
      encodeCursorValue(data),
    );
  }

  /**
   * Reads the current value as a native-endian IEEE-754 double.
   *
   * @param callback Optionally receives the current key and decoded number.
   * @returns The current number, or `null` without a current record.
   * @throws {Error} Synchronously if cursor state is unavailable, stored bytes
   * are too short for a number, or the native read fails. Exceptions from
   * `callback` propagate synchronously.
   */
  getCurrentNumber(callback?: CursorCallback<number>): number | null {
    return this.#getCurrent(decodeNumber, callback, false);
  }

  /**
   * Reads the current value as a node-lmdb-compatible boolean.
   *
   * @param callback Optionally receives the current key and decoded boolean.
   * @returns The current boolean, or `null` without a current record.
   * @throws {Error} Synchronously if cursor state is unavailable or the native
   * read fails. Exceptions from `callback` propagate synchronously.
   */
  getCurrentBoolean(callback?: CursorCallback<boolean>): boolean | null {
    return this.#getCurrent(
      (value) => value.byteLength !== 0 && value[0] !== 0,
      callback,
      false,
    );
  }

  /**
   * Reads the current zero-terminated UTF-16LE string as a durable copy.
   *
   * @param callback Optionally receives the current key and decoded string.
   * @returns The current string, or `null` without a current record.
   * @throws {Error} Synchronously if cursor state is unavailable or the native
   * read fails. Exceptions from `callback` propagate synchronously.
   */
  getCurrentString(callback?: CursorCallback<string>): string | null {
    return this.#getCurrent(decodeString, callback, false);
  }

  /**
   * Reads the current binary value into a durable `Uint8Array` copy.
   *
   * @param callback Optionally receives the current key and copied bytes.
   * @returns Copied bytes, or `null` without a current record.
   * @throws {Error} Synchronously if cursor state is unavailable or the native
   * read fails. Exceptions from `callback` propagate synchronously.
   */
  getCurrentBinary(
    callback?: CursorCallback<Uint8Array>,
  ): Uint8Array | null {
    return this.#getCurrent((value) => value, callback, true);
  }

  /**
   * Reads through the unsafe string API as a durable JavaScript copy.
   *
   * Pure TypeScript cannot construct node-lmdb's external V8 string, so this
   * method provides identical value semantics without that allocation
   * optimization.
   *
   * @param callback Optionally receives the current key and decoded string.
   * @returns The current string copy, or `null` without a current record.
   * @throws {Error} Synchronously if cursor state is unavailable or the native
   * read fails. Exceptions from `callback` propagate synchronously.
   */
  getCurrentStringUnsafe(callback?: CursorCallback<string>): string | null {
    return this.#getCurrent(decodeString, callback, false);
  }

  /**
   * Reads the current binary value as an LMDB-backed zero-copy view.
   *
   * The view can be invalidated by cursor movement, transaction mutation or a
   * transaction terminal/reset operation. Consume it immediately or detach
   * `view.buffer` through {@link Env.detachBuffer}. Use
   * {@link Cursor.getCurrentBinary} when the bytes must survive independently.
   *
   * @param callback Optionally receives the current key and borrowed view.
   * @returns A borrowed zero-copy view, or `null` without a current record.
   * @throws {Error} Synchronously if cursor state is unavailable or the native
   * read fails. Exceptions from `callback` propagate synchronously.
   */
  getCurrentBinaryUnsafe(
    callback?: CursorCallback<Uint8Array>,
  ): Uint8Array | null {
    return this.#getCurrent((value) => value, callback, false);
  }

  /**
   * Deletes the current value, or every duplicate for its key.
   *
   * The owning transaction must be writable.
   *
   * @param options Set `noDupData` to delete all duplicate values.
   * @throws {TypeError} If `options` is supplied but is not an object.
   * @throws {Error} Synchronously for invalid argument count, inactive or
   * read-only cursor state, or native deletion failure.
   */
  del(options?: DelOptions): void {
    if (arguments.length !== 0 && arguments.length !== 1) {
      throw new Error(
        'cursor.del: Incorrect number of arguments provided, arguments: options (optional).',
      );
    }
    if (
      arguments.length === 1 &&
      (typeof options !== 'object' || options === null)
    ) {
      throw new TypeError(
        'cursor.del: Invalid options argument. It should be an object.',
      );
    }
    const cursor = getCursorHandle(this);
    invalidateCursorTransactionCachesForWrite(this);
    try {
      lmdb.cursor_del(cursor, options?.noDupData === true);
    } finally {
      clearCurrentRecord(this.#current, false);
    }
  }

  /**
   * Closes this cursor exactly once.
   *
   * A read-only cursor wrapper must be closed explicitly, including after its
   * transaction reaches a terminal state. Write transaction termination
   * auto-closes the native cursor and its wrapper, so a later `close()` is an
   * already-closed error. Navigation and getters are invalid after any
   * transaction terminal operation.
   *
   * @throws {Error} Synchronously if this cursor was already closed or its
   * shared environment has been poisoned.
   */
  close(): void {
    try {
      const cursor = getCursorHandleForClose(this);
      if (cursor !== undefined) lmdb.cursor_close(cursor);
      clearCursorHandle(this);
    } finally {
      clearCurrentRecord(this.#current, false);
    }
  }

  #navigate(
    operation: lmdb.CursorOperation,
    key?: Uint8Array,
    data?: Uint8Array,
  ): T | null {
    const cursor = getCursorHandle(this);
    const currentKey = key ?? this.#current.key;
    const currentData = data ?? this.#current.data;
    try {
      const result = lmdb.cursor_get(
        cursor,
        currentKey,
        currentData,
        operation,
        true,
      );
      if (result === null) {
        clearCurrentRecord(this.#current, false);
        return null;
      }
      this.#current.key = result.key;
      this.#current.data = result.data;
      this.#current.fallbackAllowed = true;
      return this.#formatKey(result.key);
    } catch (error) {
      clearCurrentRecord(this.#current, false);
      throw error;
    }
  }

  #getCurrent<R extends Value>(
    convert: (value: Uint8Array) => R,
    callback: CursorCallback<R> | undefined,
    copy: boolean,
  ): R | null {
    const cursor = getCursorHandle(this);
    let key = this.#current.key;
    let data = this.#current.data;
    if (
      key === undefined || data === undefined ||
      (data.buffer instanceof ArrayBuffer && data.buffer.detached)
    ) {
      if (!this.#current.fallbackAllowed) return null;
      const result = lmdb.cursor_get(
        cursor,
        undefined,
        undefined,
        lmdb.CursorOperation.MDB_GET_CURRENT,
        true,
      );
      if (result === null) return null;
      key = result.key;
      data = result.data;
      this.#current.key = key;
      this.#current.data = data;
      this.#current.fallbackAllowed = true;
    }

    const value = convert(copy ? data.slice() : data);
    if (typeof callback === 'function') {
      callback(this.#formatKey(key), value);
    }
    return value;
  }

  #formatKey(key: Uint8Array): T {
    if ('keyIsUint32' in this.#keyFormat) {
      return decodeUint32Key(key) as T;
    }
    if ('keyIsBuffer' in this.#keyFormat) return key as T;
    return decodeString(key) as T;
  }
}

function clearCurrentRecord(
  current: CurrentRecord,
  fallbackAllowed: boolean,
): void {
  current.key = undefined;
  current.data = undefined;
  current.fallbackAllowed = fallbackAllowed;
}

function keyFormatFromOptions(
  options: KeyType | undefined,
  fallback: NativeKeyTypeOption,
): NativeKeyTypeOption {
  const kind = keyKindFromOptions(options);
  if (kind === undefined) return fallback;
  if (kind === 'uint32') return { keyIsUint32: true };
  if (kind === 'buffer') return { keyIsBuffer: true };
  return { keyIsString: true };
}

function encodeCursorKey(
  key: Key,
  options: KeyType | undefined,
  cursorFormat: NativeKeyTypeOption,
): Uint8Array {
  const explicitKind = keyKindFromOptions(options);
  const inferredKind = inferKeyKind(key);
  if (explicitKind !== undefined && explicitKind !== inferredKind) {
    throw new Error("Specified key type doesn't match the key you gave.");
  }
  if ('keyIsUint32' in cursorFormat && inferredKind !== 'uint32') {
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

function encodeCursorValue(value: Value): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'boolean') return encodeBoolean(value);
  throw new TypeError('Invalid data type.');
}
