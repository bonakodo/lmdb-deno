import type { LoadedLibrary } from '../native/library.ts';
import * as lmdb from '../native/api.ts';

const envBindings = new WeakMap<object, EnvironmentBinding>();
const txnBindings = new WeakMap<object, TransactionBinding>();
const dbiBindings = new WeakMap<object, DbiBinding>();
const cursorBindings = new WeakMap<object, CursorBinding>();
const environmentRegistry = new Map<string, SharedEnvironmentState>();
const liveGenerationTokens = new Set<number>();
let descriptorRevoker:
  | ((state: SharedEnvironmentState) => void)
  | undefined;

interface EnvironmentBinding {
  handle?: Deno.PointerObject;
  state?: SharedEnvironmentState;
  readonly transactions: Set<TransactionBinding>;
}

interface TransactionBinding {
  handle?: Deno.PointerObject;
  state?: SharedEnvironmentState;
  environment?: EnvironmentBinding;
  readOnly?: boolean;
  phase: 'active' | 'reset' | 'closed';
  readonly cursors: Set<CursorBinding>;
  readonly pendingDbis: Set<DbiBinding>;
}

interface SharedDbiRecord {
  readonly handle: number;
  readonly state: SharedEnvironmentState;
  readonly wrappers: Set<DbiBinding>;
  readonly pending: Set<DbiBinding>;
  cursorRefs: number;
  batchRefs: number;
  committed: boolean;
}

interface DbiBinding {
  handle: number;
  readonly keyFormat: NativeKeyTypeOption;
  readonly flags: number;
  readonly record: SharedDbiRecord;
  pendingTxn?: TransactionBinding;
  closed: boolean;
}

interface CursorBinding {
  handle?: Deno.PointerObject;
  state?: SharedEnvironmentState;
  txn?: TransactionBinding;
  dbi?: DbiBinding;
  readonly readOnly: boolean;
  readonly invalidateCurrent: () => void;
  phase: 'active' | 'detached' | 'closed';
}

interface InternalWriterToken {
  readonly kind: 'internal-writer';
}

/** @internal Retains a shared environment during nonblocking native work. */
export interface SharedEnvironmentOperation {
  /** Shared state whose native handle is currently borrowed. */
  readonly state: SharedEnvironmentState;
  /** Whether this operation has already released its shared-state lease. */
  released: boolean;
}

type WriterOwner = TransactionBinding | InternalWriterToken;

/** @internal Minimal lifecycle surface retained by shared native state. */
export interface SharedBatchClient {
  readonly active: boolean;
  readonly queued: number;
  readonly started: boolean;
  readonly workerId: number;
  close(): void;
}

const environmentFinalizer = new FinalizationRegistry<EnvironmentBinding>(
  finalizeEnvironmentBinding,
);
const transactionFinalizer = new FinalizationRegistry<TransactionBinding>(
  finalizeTransactionBinding,
);
const dbiFinalizer = new FinalizationRegistry<DbiBinding>(finalizeDbiBinding);
const cursorFinalizer = new FinalizationRegistry<CursorBinding>(
  finalizeCursorBinding,
);

/** @internal Native options which must agree for same-path reuse. */
export interface NativeOpenOptions {
  readonly flags: number;
  readonly mapSize?: number;
  readonly maxDbs: number;
  readonly maxReaders: number;
}

/** @internal Reference-counted state shared by same-path wrappers. */
export interface SharedEnvironmentState {
  readonly canonicalPath: string;
  readonly handle: Deno.PointerObject;
  readonly library: LoadedLibrary;
  readonly openOptions: NativeOpenOptions;
  readonly wrappers: Set<EnvironmentBinding>;
  readonly transactions: Set<TransactionBinding>;
  readonly dbis: Set<DbiBinding>;
  readonly dbiRecords: Map<number, SharedDbiRecord>;
  readonly cursors: Set<CursorBinding>;
  readonly descriptorTokens: Set<number>;
  refCount: number;
  poisoned: boolean;
  generation: number;
  /** Number of pending nonblocking sync and copy calls. */
  activeAsyncOperations: number;
  activeWriter?: WriterOwner;
  batchClient?: SharedBatchClient;
}

/** @internal Native DBI close deferred until a transaction terminal event. */
export interface DeferredDbiClose {
  readonly environment: Deno.PointerObject;
  readonly handle: number;
}

/** @internal Reservation preventing two synchronous internal/public writers. */
export interface InternalWriterReservation {
  readonly state: SharedEnvironmentState;
  readonly token: InternalWriterToken;
}

/** @internal Retained committed DBI metadata for one pending batch. */
export interface BatchDbiLease {
  readonly handle: number;
  readonly keyFormat: NativeKeyTypeOption;
  readonly flags: number;
  readonly owner: object;
  readonly record: SharedDbiRecord;
  released: boolean;
}

/** @internal Exact key format stored for a native database handle. */
export type NativeKeyTypeOption =
  | { keyIsUint32: true }
  | { keyIsBuffer: true }
  | { keyIsString: true };

/** @internal Counts live native bindings without exposing their handles. */
export interface NativeBindingCounts {
  readonly environments: number;
  readonly transactions: number;
  readonly dbis: number;
  readonly cursors: number;
  readonly pendingDbis: number;
  readonly batchDbiLeases: number;
}

/** @internal Returns an unpredictable process-unique safe-integer token. */
export function nextEnvironmentGeneration(): number {
  const words = new Uint32Array(2);
  while (true) {
    crypto.getRandomValues(words);
    const generation = (words[0] & 0x1f_ffff) * 0x1_0000_0000 + words[1];
    if (generation !== 0 && !liveGenerationTokens.has(generation)) {
      liveGenerationTokens.add(generation);
      return generation;
    }
  }
}

/** @internal Releases a descriptor or closed-environment generation token. */
export function releaseEnvironmentGeneration(generation: number): void {
  liveGenerationTokens.delete(generation);
}

/** @internal Returns live generation count solely for repository tests. */
export function getLiveGenerationCountForTest(): number {
  return liveGenerationTokens.size;
}

/** @internal Installs the protocol's narrow descriptor revocation hook. */
export function registerEnvironmentDescriptorRevoker(
  revoker: (state: SharedEnvironmentState) => void,
): void {
  descriptorRevoker = revoker;
}

/** @internal Revokes capabilities and releases a terminal environment token. */
export function retireSharedEnvironmentGeneration(
  state: SharedEnvironmentState,
): void {
  if (state.generation === 0) return;
  revokeEnvironmentDescriptors(state);
  releaseEnvironmentGeneration(state.generation);
  state.generation = 0;
}

/** @internal Poisons shared state and immediately revokes its capabilities. */
export function poisonSharedEnvironment(owner: object): void {
  poisonSharedEnvironmentState(getSharedEnvironment(owner));
}

/** @internal Poisons a retained state after an unexpected Worker failure. */
export function poisonSharedEnvironmentState(
  state: SharedEnvironmentState,
): void {
  if (state.poisoned) {
    revokeEnvironmentDescriptors(state);
    return;
  }
  state.poisoned = true;
  revokeEnvironmentDescriptors(state);
  releaseEnvironmentGeneration(state.generation);
  state.generation = nextEnvironmentGeneration();
}

/** @internal Terminates an idle persistent batch Worker before native close. */
export function closeSharedBatchClient(state: SharedEnvironmentState): void {
  state.batchClient?.close();
}

function revokeEnvironmentDescriptors(state: SharedEnvironmentState): void {
  descriptorRevoker?.(state);
  state.descriptorTokens.clear();
}

/** @internal Returns test-only counts for one live shared environment. */
export function getSharedBindingCounts(owner: object): NativeBindingCounts {
  const state = getSharedEnvironment(owner);
  let pendingDbis = 0;
  for (const transaction of state.transactions) {
    pendingDbis += transaction.pendingDbis.size;
  }
  let batchDbiLeases = 0;
  for (const record of state.dbiRecords.values()) {
    batchDbiLeases += record.batchRefs;
  }
  return {
    environments: state.wrappers.size,
    transactions: state.transactions.size,
    dbis: state.dbis.size,
    cursors: state.cursors.size,
    pendingDbis,
    batchDbiLeases,
  };
}

/** @internal Registers a newly created, unopened environment handle. */
export function registerEnvHandle(
  owner: object,
  handle: Deno.PointerObject,
): void {
  const binding: EnvironmentBinding = {
    handle,
    transactions: new Set(),
  };
  envBindings.set(owner, binding);
  environmentFinalizer.register(owner, binding, binding);
}

/** @internal Returns a live native environment handle. */
export function getEnvHandle(owner: object): Deno.PointerObject {
  const binding = envBindings.get(owner);
  if (binding?.handle === undefined) {
    throw new Error('The environment is already closed');
  }
  assertSharedStateUsable(binding.state);
  return binding.handle;
}

/** @internal Invalidates an environment wrapper's native handle. */
export function clearEnvHandle(owner: object): void {
  const binding = envBindings.get(owner);
  if (binding !== undefined) {
    binding.handle = undefined;
    binding.state = undefined;
    environmentFinalizer.unregister(binding);
  }
  envBindings.delete(owner);
}

/** @internal Reports whether an environment wrapper retains a native handle. */
export function hasEnvHandle(owner: object): boolean {
  return envBindings.get(owner)?.handle !== undefined;
}

/** @internal Finds live shared state for a canonical environment path. */
export function findSharedEnvironment(
  canonicalPath: string,
): SharedEnvironmentState | undefined {
  return environmentRegistry.get(canonicalPath);
}

/** @internal Registers newly opened shared environment state. */
export function registerSharedEnvironment(
  state: SharedEnvironmentState,
): void {
  if (environmentRegistry.has(state.canonicalPath)) {
    throw new Error(
      `Environment is already registered: ${state.canonicalPath}`,
    );
  }
  environmentRegistry.set(state.canonicalPath, state);
}

/** @internal Removes final shared state from the path registry. */
export function unregisterSharedEnvironment(
  state: SharedEnvironmentState,
): void {
  if (environmentRegistry.get(state.canonicalPath) === state) {
    environmentRegistry.delete(state.canonicalPath);
  }
}

/** @internal Attaches one public wrapper to shared native state. */
export function attachSharedEnvironment(
  owner: object,
  state: SharedEnvironmentState,
): void {
  const binding = requireEnvironmentBinding(owner);
  binding.handle = state.handle;
  binding.state = state;
  state.wrappers.add(binding);
  state.refCount++;
}

/** @internal Detaches one public wrapper from shared native state. */
export function detachSharedEnvironment(
  owner: object,
): SharedEnvironmentState {
  const binding = requireEnvironmentBinding(owner);
  const state = requireEnvironmentState(binding);
  detachEnvironmentBinding(binding);
  environmentFinalizer.unregister(binding);
  envBindings.delete(owner);
  return state;
}

/** @internal Returns the shared state attached to an open wrapper. */
export function getSharedEnvironment(owner: object): SharedEnvironmentState {
  return requireEnvironmentState(requireEnvironmentBinding(owner));
}

/** @internal Retains shared native state for one nonblocking FFI operation. */
export function beginSharedEnvironmentOperation(
  owner: object,
): SharedEnvironmentOperation {
  const state = getSharedEnvironment(owner);
  assertSharedStateUsable(state);
  state.activeAsyncOperations++;
  return { state, released: false };
}

/** @internal Releases shared state after nonblocking native work settles. */
export function endSharedEnvironmentOperation(
  operation: SharedEnvironmentOperation,
): void {
  if (operation.released) return;
  operation.released = true;
  operation.state.activeAsyncOperations--;
  closeSharedEnvironmentIfUnused(operation.state);
}

/** @internal Prevents close from invalidating an active native operation. */
export function assertNoSharedEnvironmentOperations(owner: object): void {
  const state = getSharedEnvironment(owner);
  if (state.activeAsyncOperations !== 0) {
    throw new Error(
      'Cannot close the environment while a sync or copy operation is still active',
    );
  }
  if (isInternalWriterToken(state.activeWriter)) {
    throw new Error(
      'Cannot close the environment while a batch operation is pending or active',
    );
  }
  if (hasBatchDbiLeases(state)) {
    throw new Error(
      'Cannot close the environment while a batch DBI is retained',
    );
  }
}

/** @internal Registers a live native transaction handle and its owner. */
export function registerTxnHandle(
  owner: object,
  handle: Deno.PointerObject,
): void {
  const binding: TransactionBinding = {
    handle,
    phase: 'active',
    cursors: new Set(),
    pendingDbis: new Set(),
  };
  txnBindings.set(owner, binding);
  transactionFinalizer.register(owner, binding, binding);
}

/** @internal Returns a live native transaction handle. */
export function getTxnHandle(owner: object): Deno.PointerObject {
  const binding = txnBindings.get(owner);
  if (binding?.handle === undefined) {
    throw new Error('The transaction is already closed');
  }
  assertSharedStateUsable(binding.state);
  return binding.handle;
}

/** @internal Reports whether a transaction still has a native handle. */
export function hasTxnHandle(owner: object): boolean {
  return txnBindings.get(owner)?.handle !== undefined;
}

/** @internal Invalidates a native transaction handle. */
export function clearTxnHandle(owner: object): void {
  const binding = txnBindings.get(owner);
  if (binding === undefined) return;
  finishTransactionCursorsBinding(binding);
  binding.handle = undefined;
  binding.phase = 'closed';
  detachTransactionBinding(binding);
  transactionFinalizer.unregister(binding);
}

/**
 * Closes read-only native cursors while their transaction is still valid.
 * LMDB 1.0 may dereference the transaction from `mdb_cursor_close`, even
 * though its public contract permits closing a read cursor after transaction
 * termination. The JavaScript cursor remains logically closable once.
 */
export function prepareTransactionCursorsForEnd(owner: object): void {
  prepareTransactionCursorsForEndBinding(requireTransactionBinding(owner));
}

/** @internal Rejects native operations while a read transaction is reset. */
export function assertTxnActive(owner: object): void {
  getTxnHandle(owner);
  if (txnBindings.get(owner)?.phase !== 'active') {
    throw new Error('The read-only transaction is reset; call renew() first');
  }
}

/** @internal Marks a read transaction as reset while retaining its handle. */
export function markTxnReset(owner: object): void {
  assertTxnActive(owner);
  const binding = requireTransactionBinding(owner);
  binding.phase = 'reset';
  finishTransactionCursorsBinding(binding);
}

/** @internal Marks a successfully renewed read transaction active. */
export function markTxnRenewed(owner: object): void {
  getTxnHandle(owner);
  const binding = requireTransactionBinding(owner);
  if (binding.phase !== 'reset') {
    throw new Error('The read-only transaction must be reset before renew()');
  }
  binding.phase = 'active';
}

/** @internal Ensures a transaction is currently reset before native renewal. */
export function assertTxnReset(owner: object): void {
  getTxnHandle(owner);
  if (txnBindings.get(owner)?.phase !== 'reset') {
    throw new Error('The read-only transaction must be reset before renew()');
  }
}

/** @internal Reports whether shared state owns an active write transaction. */
export function hasOwnedWriteTransaction(envOwner: object): boolean {
  return getSharedEnvironment(envOwner).activeWriter !== undefined;
}

/** @internal Reserves the shared writer slot for a synchronous DBI operation. */
export function reserveInternalWriter(
  envOwner: object,
): InternalWriterReservation {
  const state = environmentStateForOwner(envOwner);
  assertSharedStateUsable(state);
  if (state.activeWriter !== undefined) {
    throw secondWriterError();
  }
  const token: InternalWriterToken = { kind: 'internal-writer' };
  state.activeWriter = token;
  return { state, token };
}

/** @internal Releases an internal writer reservation exactly once. */
export function releaseInternalWriter(
  reservation: InternalWriterReservation | undefined,
): void {
  if (
    reservation !== undefined &&
    reservation.state.activeWriter === reservation.token
  ) {
    reservation.state.activeWriter = undefined;
    closeSharedEnvironmentIfUnused(reservation.state);
  }
}

/** @internal Registers a transaction for wrapper-local lifecycle cleanup. */
export function registerOwnedTransaction(
  envOwner: object,
  txnOwner: object,
  readOnly: boolean,
): void {
  const environment = requireEnvironmentBinding(envOwner);
  const state = requireEnvironmentState(environment);
  const transaction = requireTransactionBinding(txnOwner);
  if (!readOnly && state.activeWriter !== undefined) {
    throw secondWriterError();
  }
  transaction.state = state;
  transaction.environment = environment;
  transaction.readOnly = readOnly;
  environment.transactions.add(transaction);
  state.transactions.add(transaction);
  if (!readOnly) state.activeWriter = transaction;
}

/** @internal Removes a completed transaction from its owner and environment. */
export function unregisterOwnedTransaction(
  _envOwner: object,
  txnOwner: object,
): void {
  const transaction = txnBindings.get(txnOwner);
  if (transaction !== undefined) detachTransactionBinding(transaction);
}

/** @internal Invalidates wrapper-owned transactions without native calls. */
export function invalidateOwnedTransactions(envOwner: object): void {
  const environment = requireEnvironmentBinding(envOwner);
  for (const transaction of [...environment.transactions]) {
    invalidatePendingDbiBindings(transaction, false);
    finishTransactionCursorsBinding(transaction);
    closeTransactionBinding(transaction);
  }
}

/** @internal Aborts every transaction owned by one wrapper. */
export function abortOwnedTransactions(envOwner: object): void {
  const environment = requireEnvironmentBinding(envOwner);
  for (const transaction of [...environment.transactions]) {
    abortTransactionBinding(transaction);
  }
}

/** @internal Registers a live native database handle. */
export function registerDbiHandle(
  owner: object,
  handle: number,
  keyFormat: NativeKeyTypeOption = { keyIsString: true },
  envOwner: object,
  flags = 0,
  pendingTxnOwner?: object,
): void {
  const state = getSharedEnvironment(envOwner);
  const pendingTxn = pendingTxnOwner === undefined
    ? undefined
    : requireTransactionBinding(pendingTxnOwner);
  if (pendingTxn !== undefined) {
    if (pendingTxn.state !== state) {
      throw new Error('Native LMDB handles belong to a different environment');
    }
    assertTxnActive(pendingTxnOwner!);
  }

  let record = state.dbiRecords.get(handle);
  if (record === undefined) {
    record = {
      handle,
      state,
      wrappers: new Set(),
      pending: new Set(),
      cursorRefs: 0,
      batchRefs: 0,
      committed: pendingTxn === undefined,
    };
    state.dbiRecords.set(handle, record);
  } else if (pendingTxn === undefined) {
    record.committed = true;
  }

  const binding: DbiBinding = {
    handle,
    keyFormat,
    flags,
    record,
    pendingTxn,
    closed: false,
  };
  dbiBindings.set(owner, binding);
  dbiFinalizer.register(owner, binding, binding);
  state.dbis.add(binding);
  record.wrappers.add(binding);
  if (pendingTxn !== undefined) {
    record.pending.add(binding);
    pendingTxn.pendingDbis.add(binding);
  }
}

/** @internal Returns the native flags used to open a database wrapper. */
export function getDbiFlags(owner: object): number {
  return requireLiveDbiBinding(owner).flags;
}

/** @internal Returns a live native database handle. */
export function getDbiHandle(owner: object): number {
  return requireLiveDbiBinding(owner).handle;
}

/** @internal Returns a DBI handle valid for the given active transaction. */
export function getDbiHandleForTxn(owner: object, txnOwner: object): number {
  const binding = requireLiveDbiBinding(owner);
  const transaction = requireTransactionBinding(txnOwner);
  if (
    binding.pendingTxn !== undefined && binding.pendingTxn !== transaction
  ) {
    throw new Error(
      'The database is pending and can only be used by its opening transaction',
    );
  }
  return binding.handle;
}

/** @internal Returns a DBI handle only after its opening transaction commits. */
export function getCommittedDbiHandle(owner: object): number {
  const binding = requireLiveDbiBinding(owner);
  if (binding.pendingTxn !== undefined) {
    throw new Error(
      'The database is pending and requires its opening transaction',
    );
  }
  return binding.handle;
}

/** @internal Returns the shared native environment backing a DBI wrapper. */
export function getDbiEnvironmentHandle(owner: object): Deno.PointerObject {
  return requireLiveDbiBinding(owner).record.state.handle;
}

/** @internal Returns the key format associated with a database wrapper. */
export function getDbiKeyFormat(owner: object): NativeKeyTypeOption {
  return requireLiveDbiBinding(owner).keyFormat;
}

/** @internal Retains a committed DBI record for a pending batch operation. */
export function retainDbiForBatch(
  envOwner: object,
  owner: object,
): BatchDbiLease {
  assertSameSharedEnvironment(envOwner, owner);
  const binding = requireLiveDbiBinding(owner);
  if (binding.pendingTxn !== undefined || !binding.record.committed) {
    throw new Error(
      'The database is pending and cannot be used by a batch operation',
    );
  }
  binding.record.batchRefs++;
  return {
    handle: binding.handle,
    keyFormat: binding.keyFormat,
    flags: binding.flags,
    owner,
    record: binding.record,
    released: false,
  };
}

/** @internal Validates a committed DBI before any batch lease is acquired. */
export function validateDbiForBatch(envOwner: object, owner: object): void {
  assertSameSharedEnvironment(envOwner, owner);
  const binding = requireLiveDbiBinding(owner);
  if (binding.pendingTxn !== undefined || !binding.record.committed) {
    throw new Error(
      'The database is pending and cannot be used by a batch operation',
    );
  }
}

/** @internal Releases a batch DBI lease and reports a deferred native close. */
export function releaseBatchDbiLease(
  lease: BatchDbiLease,
): DeferredDbiClose | undefined {
  if (lease.released) return undefined;
  lease.released = true;
  if (lease.record.batchRefs > 0) lease.record.batchRefs--;
  return finalizeEmptyDbiRecord(
    lease.record,
    lease.record.committed && !lease.record.state.poisoned,
  );
}

/** @internal Completes deferred environment retirement after DBI release. */
export function finishBatchDbiLeaseRelease(lease: BatchDbiLease): void {
  closeSharedEnvironmentIfUnused(lease.record.state);
}

/** @internal Rejects dropping a DBI retained by a pending batch. */
export function assertDbiNotRetained(owner: object): void {
  if (requireLiveDbiBinding(owner).record.batchRefs !== 0) {
    throw new Error(
      'Cannot drop a database while a batch operation is pending',
    );
  }
}

/** @internal Logically closes a wrapper and reports a final native close. */
export function releaseDbiHandle(owner: object): DeferredDbiClose | undefined {
  const binding = requireLiveDbiBinding(owner);
  dbiFinalizer.unregister(binding);
  return releaseDbiBinding(binding, true);
}

/** @internal Invalidates a native database handle without a native close. */
export function clearDbiHandle(owner: object): void {
  const binding = dbiBindings.get(owner);
  if (binding === undefined || binding.closed) return;
  dbiFinalizer.unregister(binding);
  invalidateDbiBinding(binding);
}

/** @internal Invalidates every wrapper alias for one native DBI record. */
export function invalidateDbiRecord(owner: object): void {
  const record = requireLiveDbiBinding(owner).record;
  for (const binding of [...record.wrappers]) {
    dbiFinalizer.unregister(binding);
    invalidateDbiBinding(binding);
  }
  for (const binding of [...record.pending]) {
    dbiFinalizer.unregister(binding);
    detachPendingBinding(binding);
    binding.closed = true;
  }
  if (record.state.dbiRecords.get(record.handle) === record) {
    record.state.dbiRecords.delete(record.handle);
  }
}

/** @internal Promotes DBIs opened by a successfully committed transaction. */
export function promotePendingDbis(txnOwner: object): DeferredDbiClose[] {
  return promotePendingDbiBindings(requireTransactionBinding(txnOwner));
}

/** @internal Invalidates DBIs opened by an aborted or failed transaction. */
export function invalidatePendingDbis(
  txnOwner: object,
): DeferredDbiClose[] {
  return invalidatePendingDbiBindings(
    requireTransactionBinding(txnOwner),
    true,
  );
}

/** @internal Replaces a DBI handle solely for native failure-path tests. */
export function swapDbiHandle(owner: object, next: number): number {
  const binding = requireLiveDbiBinding(owner);
  const previous = binding.handle;
  binding.handle = next;
  return previous;
}

/** @internal Registers a live cursor under its transaction and environment. */
export function registerCursorHandle(
  owner: object,
  handle: Deno.PointerObject,
  txnOwner: object,
  dbiOwner: object,
  readOnly: boolean,
  invalidateCurrent: () => void,
): void {
  const transaction = requireTransactionBinding(txnOwner);
  const dbi = requireLiveDbiBinding(dbiOwner);
  const state = transaction.state;
  if (state === undefined) throw new Error('The transaction is already closed');
  const binding: CursorBinding = {
    handle,
    state,
    txn: transaction,
    dbi,
    readOnly,
    invalidateCurrent,
    phase: 'active',
  };
  cursorBindings.set(owner, binding);
  cursorFinalizer.register(owner, binding, binding);
  state.cursors.add(binding);
  transaction.cursors.add(binding);
  dbi.record.cursorRefs++;
}

/** @internal Returns a live native cursor handle. */
export function getCursorHandle(owner: object): Deno.PointerObject {
  const binding = requireLiveCursorBinding(owner);
  if (binding.phase !== 'active') {
    throw new Error(
      'The cursor transaction has ended; the cursor can only be closed',
    );
  }
  if (binding.dbi?.closed !== false) {
    throw new Error('The cursor database is already closed');
  }
  return binding.handle!;
}

/** @internal Returns a live cursor for explicit close without using its DBI. */
export function getCursorHandleForClose(
  owner: object,
): Deno.PointerObject | undefined {
  return requireLiveCursorBinding(owner).handle;
}

/** @internal Invalidates a cursor handle without making another native call. */
export function clearCursorHandle(owner: object): void {
  const binding = cursorBindings.get(owner);
  if (binding === undefined || binding.phase === 'closed') return;
  cursorFinalizer.unregister(binding);
  closeCursorBinding(binding, false);
}

/** @internal Detaches read cursors and forgets auto-closed write cursors. */
export function finishTransactionCursors(txnOwner: object): void {
  finishTransactionCursorsBinding(requireTransactionBinding(txnOwner));
}

/** @internal Invalidates children and returns read cursors needing native close. */
export function invalidateSharedEnvironmentChildren(
  state: SharedEnvironmentState,
): Deno.PointerObject[] {
  const readCursors: Deno.PointerObject[] = [];
  for (const cursor of [...state.cursors]) {
    if (cursor.handle !== undefined && cursor.readOnly) {
      readCursors.push(cursor.handle);
    }
    // The final environment close owns all DBI handles, so do not issue an
    // individual DBI close while a detached read cursor is still native-live.
    closeCursorBinding(cursor, false, false);
  }
  for (const dbi of [...state.dbis]) invalidateDbiBinding(dbi);
  for (const transaction of [...state.transactions]) {
    closeTransactionBinding(transaction);
  }
  state.transactions.clear();
  state.activeWriter = undefined;
  return readCursors;
}

/** @internal Rejects objects backed by different native environments. */
export function assertSameSharedEnvironment(...owners: object[]): void {
  const states = owners.map(stateForOwner);
  const first = states[0];
  if (first === undefined || states.some((state) => state === undefined)) {
    throw new Error('A native LMDB handle is already closed');
  }
  assertSharedStateUsable(first);
  if (states.some((state) => state !== first)) {
    throw new Error('Native LMDB handles belong to a different environment');
  }
}

function finalizeEnvironmentBinding(binding: EnvironmentBinding): void {
  if (binding.state === undefined) {
    if (binding.handle !== undefined) lmdb.env_close(binding.handle);
    binding.handle = undefined;
    return;
  }
  const state = binding.state;
  if (state.poisoned) {
    for (const transaction of [...binding.transactions]) {
      invalidatePendingDbiBindings(transaction, false);
      finishTransactionCursorsBinding(transaction);
      closeTransactionBinding(transaction);
    }
  } else {
    for (const transaction of [...binding.transactions]) {
      abortTransactionBinding(transaction);
    }
  }
  detachEnvironmentBinding(binding);
  closeSharedEnvironmentIfUnused(state);
}

function finalizeTransactionBinding(binding: TransactionBinding): void {
  abortTransactionBinding(binding);
}

function finalizeDbiBinding(binding: DbiBinding): void {
  const close = releaseDbiBinding(binding, true);
  if (close !== undefined) lmdb.dbi_close(close.environment, close.handle);
}

function finalizeCursorBinding(binding: CursorBinding): void {
  closeCursorBinding(binding, true);
}

function requireEnvironmentBinding(owner: object): EnvironmentBinding {
  const binding = envBindings.get(owner);
  if (binding === undefined || binding.handle === undefined) {
    throw new Error('The environment is not open');
  }
  return binding;
}

function requireEnvironmentState(
  binding: EnvironmentBinding,
): SharedEnvironmentState {
  if (binding.state === undefined) {
    throw new Error('The environment is not open');
  }
  return binding.state;
}

function requireTransactionBinding(owner: object): TransactionBinding {
  const binding = txnBindings.get(owner);
  if (binding === undefined || binding.handle === undefined) {
    throw new Error('The transaction is already closed');
  }
  assertSharedStateUsable(binding.state);
  return binding;
}

function requireLiveDbiBinding(owner: object): DbiBinding {
  const binding = dbiBindings.get(owner);
  if (binding === undefined || binding.closed) {
    throw new Error('The database is already closed');
  }
  assertSharedStateUsable(binding.record.state);
  return binding;
}

function requireLiveCursorBinding(owner: object): CursorBinding {
  const binding = cursorBindings.get(owner);
  if (binding === undefined || binding.phase === 'closed') {
    throw new Error('Attempted to use an already closed cursor');
  }
  assertSharedStateUsable(binding.state);
  return binding;
}

function environmentStateForOwner(owner: object): SharedEnvironmentState {
  const environment = envBindings.get(owner)?.state;
  const dbi = dbiBindings.get(owner)?.record.state;
  const state = environment ?? dbi;
  if (state === undefined) {
    throw new Error('A native LMDB handle is already closed');
  }
  return state;
}

function stateForOwner(owner: object): SharedEnvironmentState | undefined {
  return envBindings.get(owner)?.state ?? txnBindings.get(owner)?.state ??
    dbiBindings.get(owner)?.record.state ?? cursorBindings.get(owner)?.state;
}

function detachEnvironmentBinding(binding: EnvironmentBinding): void {
  const state = binding.state;
  if (state !== undefined && state.wrappers.delete(binding)) {
    state.refCount--;
  }
  binding.state = undefined;
  binding.handle = undefined;
}

function detachTransactionBinding(binding: TransactionBinding): void {
  const state = binding.state;
  binding.environment?.transactions.delete(binding);
  binding.environment = undefined;
  state?.transactions.delete(binding);
  if (state?.activeWriter === binding) state.activeWriter = undefined;
  binding.state = undefined;
}

function closeTransactionBinding(binding: TransactionBinding): void {
  finishTransactionCursorsBinding(binding);
  binding.handle = undefined;
  binding.phase = 'closed';
  detachTransactionBinding(binding);
  transactionFinalizer.unregister(binding);
}

function abortTransactionBinding(binding: TransactionBinding): void {
  const handle = binding.handle;
  const state = binding.state;
  if (handle === undefined) return;
  if (state?.poisoned !== true) {
    prepareTransactionCursorsForEndBinding(binding);
    lmdb.txn_abort(handle);
  }
  closeDeferredDbis(invalidatePendingDbiBindings(binding, true));
  closeTransactionBinding(binding);
}

function releaseDbiBinding(
  binding: DbiBinding,
  closeNative: boolean,
): DeferredDbiClose | undefined {
  if (binding.closed) return undefined;
  invalidateDbiCursorCaches(binding);
  binding.closed = true;
  binding.record.wrappers.delete(binding);
  binding.record.state.dbis.delete(binding);
  if (binding.pendingTxn !== undefined) return undefined;
  return finalizeEmptyDbiRecord(binding.record, closeNative);
}

function invalidateDbiBinding(binding: DbiBinding): void {
  if (binding.closed) return;
  invalidateDbiCursorCaches(binding);
  binding.closed = true;
  binding.record.wrappers.delete(binding);
  binding.record.state.dbis.delete(binding);
  detachPendingBinding(binding);
  finalizeEmptyDbiRecord(binding.record, false);
  dbiFinalizer.unregister(binding);
}

function invalidateDbiCursorCaches(binding: DbiBinding): void {
  for (const cursor of binding.record.state.cursors) {
    if (cursor.dbi === binding) cursor.invalidateCurrent();
  }
}

function detachPendingBinding(binding: DbiBinding): void {
  const transaction = binding.pendingTxn;
  if (transaction === undefined) return;
  binding.record.pending.delete(binding);
  transaction.pendingDbis.delete(binding);
  binding.pendingTxn = undefined;
}

function promotePendingDbiBindings(
  transaction: TransactionBinding,
): DeferredDbiClose[] {
  const bindings = [...transaction.pendingDbis];
  transaction.pendingDbis.clear();
  const records = new Set<SharedDbiRecord>();
  for (const binding of bindings) {
    binding.record.pending.delete(binding);
    binding.pendingTxn = undefined;
    binding.record.committed = true;
    records.add(binding.record);
  }
  return finalizeDbiRecords(records, true);
}

function invalidatePendingDbiBindings(
  transaction: TransactionBinding,
  closeCommitted: boolean,
): DeferredDbiClose[] {
  const bindings = [...transaction.pendingDbis];
  transaction.pendingDbis.clear();
  const records = new Set<SharedDbiRecord>();
  for (const binding of bindings) {
    binding.record.pending.delete(binding);
    binding.pendingTxn = undefined;
    if (!binding.closed) {
      binding.closed = true;
      binding.record.wrappers.delete(binding);
      binding.record.state.dbis.delete(binding);
      dbiFinalizer.unregister(binding);
    }
    records.add(binding.record);
  }
  const closes: DeferredDbiClose[] = [];
  for (const record of records) {
    const close = finalizeEmptyDbiRecord(
      record,
      closeCommitted && record.committed,
    );
    if (close !== undefined) closes.push(close);
  }
  return closes;
}

function finalizeDbiRecords(
  records: Set<SharedDbiRecord>,
  closeNative: boolean,
): DeferredDbiClose[] {
  const closes: DeferredDbiClose[] = [];
  for (const record of records) {
    const close = finalizeEmptyDbiRecord(record, closeNative);
    if (close !== undefined) closes.push(close);
  }
  return closes;
}

function finalizeEmptyDbiRecord(
  record: SharedDbiRecord,
  closeNative: boolean,
): DeferredDbiClose | undefined {
  if (
    record.wrappers.size !== 0 || record.pending.size !== 0 ||
    record.cursorRefs !== 0 || record.batchRefs !== 0
  ) return undefined;
  if (record.state.dbiRecords.get(record.handle) === record) {
    record.state.dbiRecords.delete(record.handle);
  }
  return closeNative && record.committed && !record.state.poisoned
    ? { environment: record.state.handle, handle: record.handle }
    : undefined;
}

function isInternalWriterToken(
  writer: WriterOwner | undefined,
): writer is InternalWriterToken {
  return writer !== undefined && 'kind' in writer &&
    writer.kind === 'internal-writer';
}

function finishTransactionCursorsBinding(
  transaction: TransactionBinding,
): void {
  for (const cursor of [...transaction.cursors]) {
    if (cursor.readOnly && cursor.state?.poisoned !== true) {
      cursor.invalidateCurrent();
      cursor.phase = 'detached';
      cursor.txn = undefined;
      transaction.cursors.delete(cursor);
    } else {
      closeCursorBinding(cursor, false);
    }
  }
  transaction.cursors.clear();
}

function prepareTransactionCursorsForEndBinding(
  transaction: TransactionBinding,
): void {
  for (const cursor of [...transaction.cursors]) {
    if (!cursor.readOnly) continue;
    if (cursor.handle !== undefined) lmdb.cursor_close(cursor.handle);
    cursor.invalidateCurrent();
    cursor.handle = undefined;
    cursor.phase = 'detached';
    cursor.txn = undefined;
    transaction.cursors.delete(cursor);
  }
}

function closeCursorBinding(
  binding: CursorBinding,
  closeNative: boolean,
  closeDbiNative = true,
): void {
  const handle = binding.handle;
  const state = binding.state;
  const record = binding.dbi?.record;
  binding.invalidateCurrent();
  if (binding.phase === 'closed') return;
  if (closeNative && handle !== undefined && state?.poisoned !== true) {
    lmdb.cursor_close(handle);
  }
  binding.txn?.cursors.delete(binding);
  state?.cursors.delete(binding);
  binding.handle = undefined;
  binding.state = undefined;
  binding.txn = undefined;
  binding.dbi = undefined;
  binding.phase = 'closed';
  cursorFinalizer.unregister(binding);
  if (record !== undefined) {
    record.cursorRefs--;
    const close = finalizeEmptyDbiRecord(record, closeDbiNative);
    if (close !== undefined) lmdb.dbi_close(close.environment, close.handle);
  }
}

function closeSharedEnvironmentIfUnused(state: SharedEnvironmentState): void {
  if (state.generation === 0) return;
  if (
    state.refCount !== 0 || state.activeAsyncOperations !== 0 ||
    state.activeWriter !== undefined || hasBatchDbiLeases(state)
  ) return;
  closeSharedBatchClient(state);
  retireSharedEnvironmentGeneration(state);
  const readCursors = invalidateSharedEnvironmentChildren(state);
  if (state.poisoned) return;
  unregisterSharedEnvironment(state);
  for (const cursor of readCursors) lmdb.cursor_close(cursor);
  lmdb.env_close(state.handle);
}

function hasBatchDbiLeases(state: SharedEnvironmentState): boolean {
  for (const record of state.dbiRecords.values()) {
    if (record.batchRefs !== 0) return true;
  }
  return false;
}

function closeDeferredDbis(closes: DeferredDbiClose[]): void {
  for (const close of closes) {
    lmdb.dbi_close(close.environment, close.handle);
  }
}

function assertSharedStateUsable(
  state: SharedEnvironmentState | undefined,
): void {
  if (state?.poisoned) {
    throw new Error(
      'The environment is poisoned after a native Worker failure',
    );
  }
}

function secondWriterError(): Error {
  return new Error(
    "You have already opened a write transaction in the current process, can't open a second one.",
  );
}
