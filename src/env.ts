import { Dbi } from './dbi.ts';
import {
  executeBatch,
  prepareBatchSnapshot,
  releasePreparedBatch,
  snapshotBatchInputs,
} from './batch/executor.ts';
import { queueWorkerBatch } from './batch/client.ts';
import { TEST_TERMINATE_AFTER_BEGIN } from './batch/protocol.ts';
import {
  abortOwnedTransactions,
  assertNoSharedEnvironmentOperations,
  attachSharedEnvironment,
  beginSharedEnvironmentOperation,
  clearEnvHandle,
  closeSharedBatchClient,
  detachSharedEnvironment,
  endSharedEnvironmentOperation,
  findSharedEnvironment,
  getEnvHandle,
  getSharedEnvironment,
  invalidateOwnedTransactions,
  invalidateSharedEnvironmentChildren,
  type NativeOpenOptions,
  nextEnvironmentGeneration,
  registerEnvHandle,
  registerSharedEnvironment,
  releaseInternalWriter,
  reserveInternalWriter,
  retireSharedEnvironmentGeneration,
  type SharedEnvironmentState,
  unregisterSharedEnvironment,
} from './internal/native_state.ts';
import * as lmdb from './native/api.ts';
import { Txn } from './txn.ts';
import type {
  BatchCallback,
  BatchOperationInput,
  BatchOptions,
  BatchResult,
  CopyCallback,
  DbiOptions,
  EnvOptions,
  Info,
  Stat,
  SyncCallback,
  TxnOptions,
} from './types.ts';

const MDB_NOSUBDIR = 0x4000;
const MDB_NOSYNC = 0x10000;
const MDB_RDONLY = 0x20000;
const MDB_NOMETASYNC = 0x40000;
const MDB_WRITEMAP = 0x80000;
const MDB_MAPASYNC = 0x100000;
const MDB_NOTLS = 0x200000;
const MDB_NOLOCK = 0x400000;
const MDB_NORDAHEAD = 0x800000;
const MDB_NOMEMINIT = 0x1000000;
const MDB_PREVSNAPSHOT = 0x02000000;
const DEFAULT_MAX_DBS = 1;
const DEFAULT_MAX_READERS = 126;

type EnvironmentStatus = 'new' | 'open' | 'closed';

/**
 * Owns one wrapper around an LMDB environment.
 *
 * Wrappers opened on the same canonical filesystem path share the first
 * reference-counted native environment within the current isolate. The first
 * wrapper's native open options remain in effect; later wrappers' native
 * options are ignored. Each wrapper still owns the transactions it creates and
 * may choose its own {@link EnvOptions.useWorker} batch mode. Arbitrary
 * user-created Workers cannot attach to this isolate-local environment. Close
 * every transaction and database before the final wrapper.
 *
 * @example Open an environment and create a database.
 * ```ts
 * const env = new Env();
 * env.open({ path: './data', mapSize: 64 * 1024 * 1024, maxDbs: 4 });
 * const users = env.openDbi({ name: 'users', create: true });
 * ```
 */
export class Env {
  #status: EnvironmentStatus = 'new';
  #useWorker = true;

  /**
   * Creates an unopened environment wrapper.
   *
   * Call {@link Env.open} exactly once before database operations, then call
   * {@link Env.close} exactly once when the wrapper is no longer needed.
   *
   * @throws {Error} If native environment allocation fails or unrestricted
   * FFI permission is unavailable.
   */
  constructor() {
    registerEnvHandle(this, lmdb.env_create());
  }

  /**
   * Opens an LMDB environment using the supplied path and native flags.
   *
   * Same canonical paths share one reference-counted native environment. A
   * later wrapper reuses the first wrapper's map size, reader/DB limits, and
   * native flags even when it supplies different values. In particular,
   * `usePreviousSnapshot: true` selects the immediately preceding committed
   * snapshot, and a successful write commit resets that native flag.
   * `useWorker` remains a wrapper-local batch choice. A hard batch Worker
   * failure poisons the shared environment and prevents reuse.
   *
   * @param options Environment path, sizing, native flags, and batch mode.
   * @throws {TypeError} If the options or path are invalid.
   * @throws {Error} If the wrapper was already opened/closed, the shared
   * environment is poisoned, or a new native environment cannot be opened.
   */
  open(options: EnvOptions): void {
    if (this.#status !== 'new') {
      throw new Error(
        this.#status === 'open'
          ? 'The environment is already open'
          : 'The environment is already closed',
      );
    }
    validateOpenOptions(options);
    const canonicalPath = canonicalizeEnvironmentPath(options);
    const nativeOptions = normalizeNativeOptions(options);
    this.#useWorker = options.useWorker === false ? false : true;

    const existing = findSharedEnvironment(canonicalPath);
    if (existing !== undefined) {
      if (existing.poisoned) {
        const unopenedHandle = getEnvHandle(this);
        lmdb.env_close(unopenedHandle);
        clearEnvHandle(this);
        this.#status = 'closed';
        throw new Error(
          'The environment is poisoned after a native Worker failure',
        );
      }
      lmdb.env_close(getEnvHandle(this));
      attachSharedEnvironment(this, existing);
      this.#status = 'open';
      return;
    }

    const handle = getEnvHandle(this);
    try {
      lmdb.env_set_maxdbs(handle, nativeOptions.maxDbs);
      lmdb.env_set_maxreaders(handle, nativeOptions.maxReaders);
      if (nativeOptions.mapSize !== undefined) {
        lmdb.env_set_mapsize(handle, nativeOptions.mapSize);
      }
      lmdb.env_open(handle, options.path, nativeOptions.flags);
    } catch (error) {
      lmdb.env_close(handle);
      clearEnvHandle(this);
      this.#status = 'closed';
      throw error;
    }

    const state: SharedEnvironmentState = {
      canonicalPath,
      handle,
      library: lmdb.getDefaultLibrary(),
      openOptions: nativeOptions,
      wrappers: new Set(),
      transactions: new Set(),
      dbis: new Set(),
      dbiRecords: new Map(),
      cursors: new Set(),
      descriptorTokens: new Set(),
      refCount: 0,
      poisoned: false,
      generation: nextEnvironmentGeneration(),
      activeAsyncOperations: 0,
      activeWriter: undefined,
    };
    registerSharedEnvironment(state);
    attachSharedEnvironment(this, state);
    this.#status = 'open';
  }

  /**
   * Opens a named or unnamed database in this environment.
   *
   * @param options Database name, persistent comparator flags, and optional
   * caller-owned transaction.
   * @returns A database handle owned by this environment.
   * @throws {TypeError} If `options` or its database name is invalid.
   * @throws {Error} Synchronously if the environment/transaction is unusable,
   * a writer conflicts, the database is missing, or LMDB rejects its flags.
   */
  openDbi(options: DbiOptions): Dbi {
    this.#assertOpen();
    return new Dbi(this, options);
  }

  /**
   * Begins a read-only or read-write transaction.
   *
   * Only one package-owned write transaction may be active for a native
   * environment at a time. Read-only transactions may be reset and renewed.
   *
   * @param options Set `readOnly` to create a reader; omitted means a writer.
   * @returns An active transaction owned by this wrapper.
   * @throws {Error} Synchronously if the environment is unavailable, another
   * writer is active, or LMDB cannot begin the transaction.
   */
  beginTxn(options?: TxnOptions): Txn {
    this.#assertOpen();
    return new Txn(
      this,
      options?.readOnly === undefined
        ? undefined
        : { readOnly: options.readOnly },
    );
  }

  /**
   * Detaches an `ArrayBuffer`, including one returned by an unsafe binary read.
   *
   * The operation deliberately performs no provenance check, matching
   * node-lmdb. Pass `view.buffer`, not the `Uint8Array` itself. Detach an
   * LMDB-backed buffer before ending the transaction that owns its memory;
   * afterward every view of that buffer has zero byte length.
   *
   * @param buffer Array buffer to detach through structured-clone transfer.
   * @throws {TypeError} If `buffer` is not an `ArrayBuffer` or is not
   * transferable.
   */
  detachBuffer(buffer: ArrayBuffer): void {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError('detachBuffer requires an ArrayBuffer');
    }
    structuredClone(buffer, { transfer: [buffer] });
  }

  /**
   * Returns statistics for the environment's unnamed database.
   *
   * @returns A snapshot whose native integer fields are converted to numbers.
   * @throws {Error} Synchronously if the environment is unavailable or the
   * native statistics call fails.
   */
  stat(): Stat {
    const stat = lmdb.env_stat(this.#handle());
    return {
      pageSize: stat.psize,
      treeBranchPageCount: Number(stat.branch_pages),
      treeLeafPageCount: Number(stat.leaf_pages),
      treeDepth: stat.depth,
      overflowPages: Number(stat.overflow_pages),
      entryCount: Number(stat.entries),
    };
  }

  /**
   * Atomically applies a batch and reports completion asynchronously.
   *
   * Input observation, validation, byte copying, normalization, and DBI
   * retention happen synchronously. By default a persistent Worker performs
   * the native transaction; {@link EnvOptions.useWorker} can keep that native
   * execution on the calling isolate. The completion callback is always
   * asynchronous.
   *
   * Optional {@link BatchOptions} provide put flags, key encoding, and
   * best-effort progress. Progress may run zero or more times. When invoked it
   * receives the same parent-owned, progressively populated array later passed
   * to a successful completion callback.
   *
   * A cooperative native failure aborts the batch. If a Worker dies after
   * entering native code, every same-path wrapper is permanently poisoned and
   * only cleanup through {@link Env.close} remains valid.
   *
   * @param operations Object or tuple operations; values must be
   * `Uint8Array`, `null`, or `undefined` at runtime.
   * @param callback Invoked asynchronously exactly once with `null` and
   * committed results, or with an error. An options object may precede it.
   * @throws {TypeError} Synchronously if inputs, options, or callback are
   * malformed or contain non-binary values.
   * @throws {Error} Synchronously if the environment or a DBI is unavailable.
   * Calling-thread writer conflicts are also synchronous. Once Worker inputs
   * validate, Worker startup, dispatch, writer reservation, native execution,
   * and hard-death failures are delivered asynchronously to `callback`.
   *
   * @example Write in the default persistent Worker.
   * ```ts
   * env.batchWrite(
   *   [[db, 'one', new Uint8Array([1])]],
   *   { progress: (results) => console.log(results) },
   *   (error, results) => {
   *     if (error) {
   *       console.error(error);
   *       return;
   *     }
   *     console.log(results); // [BatchResult.SUCCESS]
   *   },
   * );
   * ```
   */
  batchWrite(
    operations: BatchOperationInput[],
    callback: BatchCallback,
  ): void;
  /**
   * Accepts node-lmdb's declaration for source compatibility only. Runtime
   * success passes `null`, and a failed batch may omit `results`.
   */
  batchWrite(
    operations: BatchOperationInput[],
    callback: (error: Error, results: BatchResult[]) => void,
  ): void;
  /** Applies batch options while retaining truthful callback nullability. */
  batchWrite(
    operations: BatchOperationInput[],
    options: BatchOptions,
    callback: BatchCallback,
  ): void;
  /**
   * Accepts node-lmdb's options form for source compatibility only. Runtime
   * success passes `null`, and a failed batch may omit `results`.
   */
  batchWrite(
    operations: BatchOperationInput[],
    options: BatchOptions,
    callback: (error: Error, results: BatchResult[]) => void,
  ): void;
  batchWrite(
    operations: BatchOperationInput[],
    optionsOrCallback:
      | BatchOptions
      | BatchCallback
      | (
        (error: Error, results: BatchResult[]) => void
      ),
    callback?:
      | BatchCallback
      | (
        (error: Error, results: BatchResult[]) => void
      ),
  ): void {
    this.#assertOpen();
    const options = typeof optionsOrCallback === 'function'
      ? {}
      : optionsOrCallback;
    const compatibleCallback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;
    if (
      typeof options !== 'object' || options === null ||
      typeof compatibleCallback !== 'function'
    ) {
      throw new TypeError(
        'Call env.batchWrite(operations, options?, callback) with a callback function.',
      );
    }
    // node-lmdb declares non-null callback parameters although it supplies
    // `null` on success. The overload accepts that declaration while this
    // internal view preserves the runtime truth.
    const selectedCallback = compatibleCallback as BatchCallback;
    const snapshot = snapshotBatchInputs(operations, options);
    const terminateAfterBegin = (
      options as BatchOptions & { [TEST_TERMINATE_AFTER_BEGIN]?: boolean }
    )[TEST_TERMINATE_AFTER_BEGIN] === true;
    this.#assertOpen();

    const prepared = prepareBatchSnapshot(this, snapshot);

    if (this.#useWorker) {
      try {
        queueWorkerBatch(
          this,
          prepared,
          snapshot.options.progress,
          selectedCallback,
          terminateAfterBegin,
        );
      } catch (error) {
        let dispatchError = asError(error);
        try {
          releasePreparedBatch(prepared);
        } catch (cleanupError) {
          dispatchError = new Error(dispatchError.message, {
            cause: asError(cleanupError),
          });
        }
        queueMicrotask(() => selectedCallback(dispatchError));
      }
      return;
    }
    let reservation: ReturnType<typeof reserveInternalWriter>;
    try {
      reservation = reserveInternalWriter(this);
    } catch (error) {
      try {
        releasePreparedBatch(prepared);
      } catch {
        // Preserve the writer-conflict error which prevented native execution.
      }
      throw error;
    }

    const results = new Array<BatchResult>(snapshot.operations.length);
    let executionError: Error | null = null;
    let completedCount = 0;
    try {
      completedCount = executeBatch(
        reservation.state.handle,
        prepared.request,
        results,
      );
    } catch (error) {
      executionError = asError(error);
      while (completedCount in results) completedCount++;
    }

    try {
      releasePreparedBatch(prepared);
    } catch (error) {
      executionError ??= asError(error);
    } finally {
      releaseInternalWriter(reservation);
    }

    const progress = snapshot.options.progress;
    if (progress !== undefined && completedCount !== 0) {
      queueMicrotask(() => {
        try {
          progress(results);
        } catch (error) {
          setTimeout(() => {
            throw error;
          }, 0);
        }
      });
    }
    queueMicrotask(() => {
      if (executionError === null) selectedCallback(null, results);
      else selectedCallback(executionError);
    });
  }

  /**
   * Copies the environment through nonblocking FFI.
   *
   * With no callback, returns a Promise. With `[callback]` or
   * `[compact, callback]`, returns immediately and invokes the callback
   * asynchronously exactly once. `compact: true` omits free pages. Keep the
   * environment open until the Promise or callback settles.
   *
   * @param path Destination accepted by `mdb_env_copy2`.
   * @param compactOrCallback Optional compact flag or completion callback.
   * @param callback Completion callback used with an explicit compact flag.
   * @returns A Promise without a callback; otherwise `void`.
   * @throws {TypeError} Synchronously if arguments do not match a documented
   * form.
   * @throws {Error} Synchronously if the environment is unavailable. Native
   * and destination failures reject the Promise or reach the callback.
   *
   * @example Use either completion style.
   * ```ts
   * await env.copy('/backups/lmdb', true);
   * env.copy('/backups/lmdb', (error) => {
   *   if (error) console.error(error);
   * });
   * ```
   */
  copy(path: string, callback: CopyCallback): void;
  /**
   * Accepts node-lmdb's declaration for source compatibility only. Runtime
   * success passes `null`.
   */
  copy(path: string, callback: (error: Error) => void): void;
  /** Uses an explicit compact flag with truthful callback nullability. */
  copy(
    path: string,
    compact: boolean | undefined,
    callback: CopyCallback,
  ): void;
  /**
   * Accepts node-lmdb's compact form for source compatibility only. Runtime
   * success passes `null`.
   */
  copy(
    path: string,
    compact: boolean | undefined,
    callback: (error: Error) => void,
  ): void;
  /** Returns a Promise when no completion callback is supplied. */
  copy(path: string, compact?: boolean): Promise<void>;
  copy(
    path: string,
    compactOrCallback?: boolean | CopyCallback | ((error: Error) => void),
    callback?: CopyCallback | ((error: Error) => void),
  ): Promise<void> | void {
    this.#assertOpen();
    if (typeof path !== 'string') {
      throw new TypeError(
        'Call env.copy(path, compact?, callback) with a file path.',
      );
    }
    if (
      compactOrCallback !== undefined &&
      typeof compactOrCallback !== 'boolean' &&
      typeof compactOrCallback !== 'function'
    ) {
      throw new TypeError(
        'Call env.copy(path, compact?, callback) with a file path.',
      );
    }
    if (callback !== undefined && typeof callback !== 'function') {
      throw new TypeError(
        'Call env.copy(path, compact?, callback) with a file path.',
      );
    }
    if (typeof compactOrCallback === 'function' && callback !== undefined) {
      throw new TypeError(
        'Call env.copy(path, compact?, callback) with a file path.',
      );
    }
    const compact = typeof compactOrCallback === 'boolean'
      ? compactOrCallback
      : false;
    const compatibleCallback = typeof compactOrCallback === 'function'
      ? compactOrCallback
      : callback;
    const operation = beginSharedEnvironmentOperation(this);
    const completion = lmdb.env_copy(operation.state.handle, path, compact)
      .finally(() => endSharedEnvironmentOperation(operation));
    if (compatibleCallback === undefined) return completion;
    const selectedCallback = compatibleCallback as CopyCallback;
    void completion.then(
      () => dispatchCompletionCallback(selectedCallback, null),
      (error) => dispatchCompletionCallback(selectedCallback, asError(error)),
    );
  }

  /**
   * Flushes environment changes and invokes a callback on completion.
   *
   * @param callback Invoked asynchronously exactly once.
   * @throws {TypeError} Synchronously if `callback` is not a function.
   * @throws {Error} Synchronously if the environment is unavailable. Native
   * sync failures are delivered to `callback`.
   */
  sync(callback: SyncCallback): void;
  /**
   * Accepts node-lmdb's declaration for source compatibility only. Runtime
   * success passes `null`.
   */
  sync(callback: (error: Error) => void): void;
  /**
   * Flushes environment changes and resolves when the native call completes.
   *
   * This Promise overload is an additive Deno convenience. Do not close the
   * environment while the sync is pending.
   *
   * @returns A Promise settled with the nonblocking native sync.
   * @throws {Error} Synchronously if the environment is unavailable. The
   * returned Promise rejects when native sync fails.
   */
  sync(): Promise<void>;
  /**
   * Flushes environment changes through nonblocking FFI.
   *
   * Without a callback, returns a Promise. Otherwise returns immediately and
   * invokes the callback asynchronously exactly once. Keep the environment
   * open until completion.
   *
   * @param callback Optional completion callback receiving `null` or the
   * native sync error.
   * @returns A Promise without `callback`; otherwise `void`.
   * @throws {TypeError} Synchronously if `callback` is not a function.
   * @throws {Error} Synchronously if the environment is unavailable. Native
   * failures reject the Promise or reach the callback.
   *
   * @example Use either completion style.
   * ```ts
   * await env.sync();
   * env.sync((error) => {
   *   if (error) console.error(error);
   * });
   * ```
   */
  sync(
    callback?: SyncCallback | ((error: Error) => void),
  ): Promise<void> | void {
    this.#assertOpen();
    if (callback !== undefined && typeof callback !== 'function') {
      throw new TypeError('Call env.sync(callback) with a function.');
    }
    const operation = beginSharedEnvironmentOperation(this);
    const completion = lmdb.env_sync(operation.state.handle, true)
      .finally(() => endSharedEnvironmentOperation(operation));
    if (callback === undefined) return completion;
    const selectedCallback = callback as SyncCallback;
    void completion.then(
      () => dispatchCompletionCallback(selectedCallback, null),
      (error) => dispatchCompletionCallback(selectedCallback, asError(error)),
    );
  }

  /**
   * Closes this wrapper, aborting transactions it owns.
   *
   * The native environment closes only after its final same-path wrapper. The
   * final close stops the persistent batch Worker and invalidates child
   * handles. A pending `sync`, `copy`, or batch prevents close. After a hard
   * Worker failure, close performs poison-safe cleanup without re-entering the
   * potentially compromised native environment.
   *
   * Read-only cursors require explicit `cursor.close()`, including after their
   * transaction ends. Write transaction termination auto-closes native cursors
   * and makes their JavaScript wrappers unusable.
   *
   * @throws {Error} Synchronously if already closed or a sync, copy, batch, or
   * retained batch DBI is pending.
   */
  close(): void {
    if (this.#status === 'closed') {
      throw new Error('The environment is already closed');
    }
    if (this.#status === 'new') {
      const handle = getEnvHandle(this);
      lmdb.env_close(handle);
      clearEnvHandle(this);
      this.#status = 'closed';
      return;
    }

    const shared = getSharedEnvironment(this);
    assertNoSharedEnvironmentOperations(this);
    if (shared.poisoned) invalidateOwnedTransactions(this);
    else abortOwnedTransactions(this);
    if (shared.refCount === 1) closeSharedBatchClient(shared);
    const state = detachSharedEnvironment(this);
    this.#status = 'closed';
    if (state.refCount === 0 && state.generation !== 0) {
      retireSharedEnvironmentGeneration(state);
      const readCursors = invalidateSharedEnvironmentChildren(state);
      if (!state.poisoned) {
        unregisterSharedEnvironment(state);
        for (const cursor of readCursors) lmdb.cursor_close(cursor);
        lmdb.env_close(state.handle);
      }
    }
  }

  /**
   * Returns current memory-map and reader information.
   *
   * @returns A snapshot with native integer fields converted to numbers.
   * @throws {Error} Synchronously if the environment is unavailable or the
   * native information call fails.
   */
  info(): Info {
    const info = lmdb.env_info(this.#handle());
    return {
      mapAddress: Number(info.mapaddr),
      mapSize: Number(info.mapsize),
      lastPageNumber: Number(info.last_pgno),
      lastTxnId: Number(info.last_tnxid),
      maxReaders: info.maxreaders,
      numReaders: info.numreaders,
    };
  }

  /**
   * Changes the maximum memory-map size.
   *
   * @param newSize Positive safe-integer size in bytes.
   * @throws {Error} Synchronously if the environment is unavailable, has an
   * active transaction, or native resizing fails.
   * @throws {RangeError} If `newSize` is not a positive safe integer.
   */
  resize(newSize: number): void {
    this.#assertOpen();
    if (getSharedEnvironment(this).transactions.size > 0) {
      throw new Error(
        'There are active transactions within the environment. Commit or abort all transactions before calling env.resize()',
      );
    }
    if (!Number.isSafeInteger(newSize) || newSize <= 0) {
      throw new RangeError(
        'Environment map size must be a positive safe integer',
      );
    }
    lmdb.env_set_mapsize(this.#handle(), newSize);
  }

  #handle(): Deno.PointerObject {
    this.#assertOpen();
    return getEnvHandle(this);
  }

  #assertOpen(): void {
    if (this.#status !== 'open') {
      throw new Error(
        this.#status === 'closed'
          ? 'The environment is already closed'
          : 'The environment is not open',
      );
    }
    const state = getSharedEnvironment(this);
    if (state.poisoned) {
      throw new Error(
        'The environment is poisoned after a native Worker failure',
      );
    }
  }
}

function nativeFlags(options: EnvOptions): number {
  let flags = MDB_NOTLS;
  if (options.noSubdir === true) flags |= MDB_NOSUBDIR;
  if (options.noSync === true) flags |= MDB_NOSYNC;
  if (options.readOnly === true) flags |= MDB_RDONLY;
  if (options.noMetaSync === true) flags |= MDB_NOMETASYNC;
  if (options.useWritemap === true) flags |= MDB_WRITEMAP;
  if (options.mapAsync === true) flags |= MDB_MAPASYNC;
  if (options.unsafeNoLock === true) flags |= MDB_NOLOCK;
  if (options.noReadAhead === true) flags |= MDB_NORDAHEAD;
  if (options.noMemInit === true) flags |= MDB_NOMEMINIT;
  if (options.usePreviousSnapshot === true) flags |= MDB_PREVSNAPSHOT;
  return flags;
}

function normalizeNativeOptions(options: EnvOptions): NativeOpenOptions {
  return Object.freeze({
    flags: nativeFlags(options),
    mapSize: options.mapSize,
    maxDbs: options.maxDbs ?? DEFAULT_MAX_DBS,
    maxReaders: options.maxReaders ?? DEFAULT_MAX_READERS,
  });
}

function validateOpenOptions(options: EnvOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Env.open requires an options object');
  }
  if (typeof options.path !== 'string' || options.path.length === 0) {
    throw new TypeError('Env.open requires a non-empty path');
  }
  validatePositiveInteger(options.mapSize, 'mapSize');
  validatePositiveInteger(options.maxDbs, 'maxDbs');
  validatePositiveInteger(options.maxReaders, 'maxReaders');
}

function validatePositiveInteger(
  value: number | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function canonicalizeEnvironmentPath(options: EnvOptions): string {
  try {
    return Deno.realPathSync(options.path);
  } catch (error) {
    if (options.noSubdir !== true || !(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const absolute = options.path.startsWith('/')
    ? options.path
    : `${Deno.cwd()}/${options.path}`;
  const separator = absolute.lastIndexOf('/');
  const parent = separator === 0 ? '/' : absolute.slice(0, separator);
  const basename = absolute.slice(separator + 1);
  if (basename.length === 0) {
    throw new TypeError('A noSubdir environment path must name a data file');
  }
  const canonicalParent = Deno.realPathSync(parent);
  return canonicalParent === '/'
    ? `/${basename}`
    : `${canonicalParent}/${basename}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function dispatchCompletionCallback(
  callback: (error: Error | null) => void,
  error: Error | null,
): void {
  queueMicrotask(() => callback(error));
}
