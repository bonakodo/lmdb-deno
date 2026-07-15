import * as lmdb from './native/api.ts';
import { checkLmdbResult } from './native/errors.ts';
import type { Txn } from './txn.ts';
import type { Env } from './env.ts';
import {
  assertDbiNotRetained,
  assertSameSharedEnvironment,
  assertTxnActive,
  clearDbiCursorCurrentRecords,
  getCommittedDbiHandle,
  getDbiEnvironmentHandle,
  getDbiHandleForTxn,
  getEnvHandle,
  getTxnHandle,
  invalidateDbiRecord,
  invalidateTransactionCursorCachesForWrite,
  type NativeKeyTypeOption,
  registerDbiHandle,
  releaseDbiHandle,
  releaseInternalWriter,
  reserveInternalWriter,
} from './internal/native_state.ts';
import type { DbiOptions, DropOptions, Stat } from './types.ts';

const MDB_REVERSEKEY = 0x02;
const MDB_DUPSORT = 0x04;
const MDB_INTEGERKEY = 0x08;
const MDB_DUPFIXED = 0x10;
const MDB_INTEGERDUP = 0x20;
const MDB_REVERSEDUP = 0x40;
const MDB_CREATE = 0x40000;
const MDB_BAD_VALSIZE = -30781;

/**
 * Represents one named or unnamed key/value database in an {@link Env}.
 *
 * Obtain handles through {@link Env.openDbi}. Multiple wrappers for the same
 * native database share lifetime state: deleting the database invalidates all
 * aliases. A handle opened inside a caller-owned transaction is usable only
 * after that transaction commits.
 */
export class Dbi {
  /**
   * Opens a database through its owning environment.
   *
   * Prefer {@link Env.openDbi}, which delegates here.
   *
   * @param env Open environment which will own the handle.
   * @param options Database name, flags, key encoding, and optional transaction.
   * @throws {TypeError} If the options object or database name is invalid.
   * @throws {Error} Synchronously if the environment/transaction is
   * unavailable, a writer conflicts, or LMDB rejects the database options.
   */
  constructor(env: Env, options: DbiOptions) {
    validateOptions(options);
    let flags = 0;
    const keyFormat = keyFormatFromOptions(options);
    if (options.reverseKey === true) flags |= MDB_REVERSEKEY;
    if (options.dupSort === true) flags |= MDB_DUPSORT;
    if (options.dupFixed === true) flags |= MDB_DUPFIXED;
    if (options.integerDup === true) flags |= MDB_INTEGERDUP;
    if (options.reverseDup === true) flags |= MDB_REVERSEDUP;
    if (options.create === true) flags |= MDB_CREATE;
    if ('keyIsUint32' in keyFormat) {
      flags |= MDB_INTEGERKEY;
    }

    const suppliedTxn = options.txn ?? undefined;
    if (suppliedTxn !== undefined) {
      assertSameSharedEnvironment(env, suppliedTxn);
      assertTxnActive(suppliedTxn);
      const txn = getTxnHandle(suppliedTxn);
      if ((flags & MDB_CREATE) !== 0) {
        invalidateTransactionCursorCachesForWrite(suppliedTxn);
      }
      const dbi = lmdb.dbi_open(txn, options.name, flags);
      registerDbiHandle(this, dbi, keyFormat, env, flags, suppliedTxn);
      return;
    }

    const envHandle = getEnvHandle(env);
    const reservation = options.create === true
      ? reserveInternalWriter(env)
      : undefined;
    let txn: Deno.PointerObject | undefined;
    let commitAttempted = false;
    let commitSucceeded = false;
    let openedDbi: number | undefined;
    try {
      txn = lmdb.txn_begin(envHandle, null, options.create !== true);
      openedDbi = lmdb.dbi_open(txn, options.name, flags);
      commitAttempted = true;
      lmdb.txn_commit(txn);
      commitSucceeded = true;
      registerDbiHandle(this, openedDbi, keyFormat, env, flags);
    } catch (error) {
      if (txn !== undefined && !commitAttempted) lmdb.txn_abort(txn);
      if (commitSucceeded && openedDbi !== undefined) {
        lmdb.dbi_close(envHandle, openedDbi);
      }
      throw error;
    } finally {
      releaseInternalWriter(reservation);
    }
  }

  /**
   * Releases this database wrapper.
   *
   * Existing transactions and cursors retaining the native DBI keep it alive
   * until their own terminal operation, but this wrapper cannot start new work.
   *
   * @throws {Error} Synchronously if this wrapper was already closed or its
   * shared environment is poisoned.
   */
  close(): void {
    const close = releaseDbiHandle(this);
    if (close !== undefined) {
      lmdb.dbi_close(close.environment, close.handle);
    }
  }

  /**
   * Deletes the database or empties all of its records.
   *
   * Without `options.txn`, the operation owns and commits an internal write
   * transaction. With a transaction, commit/abort remains the caller's
   * responsibility. Deleting the database invalidates every wrapper for it;
   * `justFreePages: true` keeps the database handle valid.
   *
   * @param options Optional transaction and empty-without-delete mode.
   * @throws {Error} Synchronously if the handle is closed/retained, a supplied
   * transaction is inactive or from another environment, a writer conflicts,
   * or the native drop/commit fails.
   */
  drop(options?: DropOptions): void {
    assertDbiNotRetained(this);
    const suppliedTxn = options?.txn ?? undefined;
    if (suppliedTxn !== undefined) {
      assertSameSharedEnvironment(this, suppliedTxn);
      assertTxnActive(suppliedTxn);
      const deleteDatabase = options?.justFreePages !== true;
      const txn = getTxnHandle(suppliedTxn);
      const dbi = getDbiHandleForTxn(this, suppliedTxn);
      invalidateTransactionCursorCachesForWrite(suppliedTxn);
      lmdb.drop(txn, dbi, deleteDatabase);
      if (deleteDatabase) invalidateDbiRecord(this);
      else clearDbiCursorCurrentRecords(this);
      return;
    }

    const dbi = getCommittedDbiHandle(this);
    const envHandle = getDbiEnvironmentHandle(this);
    const reservation = reserveInternalWriter(this);
    let txn: Deno.PointerObject | undefined;
    let commitAttempted = false;
    try {
      txn = lmdb.txn_begin(envHandle, null, false);
      const deleteDatabase = options?.justFreePages !== true;
      lmdb.drop(txn, dbi, deleteDatabase);
      commitAttempted = true;
      lmdb.txn_commit(txn);
      if (deleteDatabase) invalidateDbiRecord(this);
    } catch (error) {
      if (txn !== undefined && !commitAttempted) lmdb.txn_abort(txn);
      throw error;
    } finally {
      releaseInternalWriter(reservation);
    }
  }

  /**
   * Returns database statistics from an active transaction snapshot.
   *
   * @param tx Active transaction from the same environment.
   * @returns Database-tree statistics converted to JavaScript numbers.
   * @throws {Error} Synchronously if the transaction/database is inactive or
   * from another environment, or the native statistics call fails.
   */
  stat(tx: Txn): Stat {
    assertSameSharedEnvironment(this, tx);
    assertTxnActive(tx);
    const stat = lmdb.stat(
      getTxnHandle(tx),
      getDbiHandleForTxn(this, tx),
    );
    return {
      entryCount: Number(stat.entries),
      overflowPages: Number(stat.overflow_pages),
      pageSize: stat.psize,
      treeBranchPageCount: Number(stat.branch_pages),
      treeDepth: stat.depth,
      treeLeafPageCount: Number(stat.leaf_pages),
    };
  }
}

function validateOptions(options: DbiOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Invalid parameters.');
  }
  if (options.name !== null && typeof options.name !== 'string') {
    throw new TypeError('DbiOptions.name must be a string or null');
  }
  if (options.name === '') checkLmdbResult(MDB_BAD_VALSIZE);
}

function keyFormatFromOptions(options: DbiOptions): NativeKeyTypeOption {
  const uint32 = options.keyIsUint32 === true;
  const buffer = options.keyIsBuffer === true;
  const string = options.keyIsString === true;
  if (Number(uint32) + Number(buffer) + Number(string) > 1) {
    throw new Error(
      "You can't specify multiple key types at once. Either set keyIsUint32, or keyIsBuffer or keyIsString (default).",
    );
  }
  if (uint32) return { keyIsUint32: true };
  if (buffer) return { keyIsBuffer: true };
  return { keyIsString: true };
}
