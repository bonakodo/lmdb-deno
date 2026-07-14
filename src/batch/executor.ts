import { encodeKey, type Key } from '../encoding.ts';
import {
  type BatchDbiLease,
  finishBatchDbiLeaseRelease,
  releaseBatchDbiLease,
  retainDbiForBatch,
  validateDbiForBatch,
} from '../internal/native_state.ts';
import * as lmdb from '../native/api.ts';
import type { NativeApi } from '../native/api.ts';
import { LmdbError } from '../native/errors.ts';
import type {
  BatchOperation,
  BatchOperationInput,
  BatchOptions,
  BatchProgress,
  BatchResult,
  KeyType,
} from '../types.ts';
import { BatchResult as Result } from '../types.ts';
import type {
  NormalizedBatchCondition,
  NormalizedBatchOperation,
  NormalizedBatchRequest,
} from './protocol.ts';

const MDB_NOOVERWRITE = 0x10;
const MDB_NODUPDATA = 0x20;
const MDB_APPEND = 0x20000;
const MDB_APPENDDUP = 0x40000;
const MDB_NOTFOUND = -30798;
const MDB_BAD_VALSIZE = -30781;

type KeyKind = 'string' | 'uint32' | 'buffer';

/** @internal A normalized request plus native DBI lifetime leases. */
export interface PreparedBatch {
  readonly request: NormalizedBatchRequest;
  readonly leases: readonly BatchDbiLease[];
  readonly owners: readonly object[];
  released: boolean;
}

interface BatchDbiTarget {
  readonly handle: number;
  readonly keyFormat: KeyType;
}

/** @internal Plain option data captured before native state is retained. */
export type BatchOptionsSnapshot = KeyType & {
  readonly noDupData: boolean;
  readonly noOverwrite: boolean;
  readonly append: boolean;
  readonly appendDup: boolean;
  readonly progress?: BatchProgress;
};

/** @internal Plain operation data captured before native state is retained. */
export interface BatchOperationSnapshot {
  readonly db: object;
  readonly key: Key;
  readonly value: unknown;
  readonly ifValue: unknown;
  readonly ifKey: Key | null | undefined;
  readonly ifDB: object | null | undefined;
  readonly exact: boolean;
}

/** @internal Complete getter-free public batch input snapshot. */
export interface BatchInputSnapshot {
  readonly operations: readonly BatchOperationSnapshot[];
  readonly options: BatchOptionsSnapshot;
}

/** @internal Hooks used by the Worker host without changing batch semantics. */
export interface BatchExecutionHooks {
  readonly onResult?: (index: number, result: BatchResult) => void;
  readonly terminateAfterBegin?: boolean;
}

/** @internal Deliberately uncaught only by the isolated hard-failure test. */
export class HardWorkerFailureSignal extends Error {
  constructor() {
    super('Test-only hard Worker failure after mdb_txn_begin');
    this.name = 'HardWorkerFailureSignal';
  }
}

/** Captures every user-observable field before acquiring native leases. */
export function snapshotBatchInputs(
  inputs: BatchOperationInput[],
  options: BatchOptions,
): BatchInputSnapshot {
  if (!Array.isArray(inputs)) {
    throw new TypeError('batchWrite operations must be an array');
  }
  const noDupData = options.noDupData;
  const noOverwrite = options.noOverwrite;
  const append = options.append;
  const appendDup = options.appendDup;
  const progress = options.progress;
  const keyIsUint32 = options.keyIsUint32;
  const keyIsString = options.keyIsString;
  const keyIsBuffer = options.keyIsBuffer;
  if (progress !== undefined && typeof progress !== 'function') {
    throw new TypeError('BatchOptions.progress must be a function');
  }
  const operations = inputs.map(snapshotOperation);
  return {
    operations,
    options: {
      noDupData: noDupData === true,
      noOverwrite: noOverwrite === true,
      append: append === true,
      appendDup: appendDup === true,
      ...(keyIsUint32 === true ? { keyIsUint32: true } : {}),
      ...(keyIsBuffer === true ? { keyIsBuffer: true } : {}),
      ...(keyIsString === true ? { keyIsString: true } : {}),
      ...(progress === undefined ? {} : { progress }),
    } as BatchOptionsSnapshot,
  };
}

/**
 * Validates and copies public operations into a structured-clone-safe request.
 *
 * @internal
 */
export function prepareBatch(
  env: object,
  inputs: BatchOperationInput[],
  options: BatchOptions,
): PreparedBatch {
  return prepareBatchSnapshot(env, snapshotBatchInputs(inputs, options));
}

/** Validates a getter-free snapshot and acquires its native DBI leases. */
export function prepareBatchSnapshot(
  env: object,
  snapshot: BatchInputSnapshot,
): PreparedBatch {
  const owners = new Set<object>();
  for (const operation of snapshot.operations) {
    owners.add(operation.db);
    if (operation.ifValue !== undefined) {
      owners.add(operation.ifDB ?? operation.db);
    }
  }
  for (const owner of owners) validateDbiForBatch(env, owner);

  const targetsByOwner = new Map<object, BatchDbiTarget>();
  const leasesByRecord = new Map<object, BatchDbiLease>();
  const lease = (owner: object): BatchDbiTarget => {
    let target = targetsByOwner.get(owner);
    if (target !== undefined) return target;
    const candidate = retainDbiForBatch(env, owner);
    const existing = leasesByRecord.get(candidate.record);
    if (existing === undefined) {
      leasesByRecord.set(candidate.record, candidate);
    } else {
      releaseBatchDbiLease(candidate);
      finishBatchDbiLeaseRelease(candidate);
    }
    target = { handle: candidate.handle, keyFormat: candidate.keyFormat };
    targetsByOwner.set(owner, target);
    return target;
  };

  try {
    const first = snapshot.operations[0];
    const keyKind = first === undefined ? undefined : inferBatchKeyKind(
      first.key,
      snapshot.options,
      lease(first.db).keyFormat,
    );
    const operations = snapshot.operations.map((input) =>
      normalizeOperation(input, keyKind!, lease)
    );
    return {
      request: {
        operations,
        putFlags: putFlags(snapshot.options),
      },
      leases: [...leasesByRecord.values()],
      owners: [...owners],
      released: false,
    };
  } catch (error) {
    try {
      releasePreparedBatch({
        request: { operations: [], putFlags: 0 },
        leases: [...leasesByRecord.values()],
        owners: [...targetsByOwner.keys()],
        released: false,
      });
    } catch {
      // Preserve the normalization error while still attempting every release.
    }
    throw error;
  }
}

/** @internal Releases all DBI leases, closing newly unreferenced handles. */
export function releasePreparedBatch(prepared: PreparedBatch): void {
  if (prepared.released) return;
  prepared.released = true;
  let firstError: unknown;
  for (const lease of prepared.leases) {
    try {
      const close = releaseBatchDbiLease(lease);
      if (close !== undefined) lmdb.dbi_close(close.environment, close.handle);
    } catch (error) {
      firstError ??= error;
    } finally {
      try {
        finishBatchDbiLeaseRelease(lease);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  if (firstError !== undefined) throw firstError;
}

/** Executes one normalized request in exactly one atomic write transaction. */
export function executeBatch(
  env: Deno.PointerObject,
  request: NormalizedBatchRequest,
  results: BatchResult[],
  api: NativeApi = lmdb.getDefaultNativeApi(),
  hooks?: BatchExecutionHooks,
): number {
  let txn: Deno.PointerObject | undefined;
  let commitAttempted = false;
  let completedCount = 0;
  const complete = (index: number, result: BatchResult): void => {
    results[index] = result;
    completedCount++;
    hooks?.onResult?.(index, result);
  };
  try {
    txn = api.txnBegin(env, false);
    if (hooks?.terminateAfterBegin === true) {
      throw new HardWorkerFailureSignal();
    }
    for (let index = 0; index < request.operations.length; index++) {
      const operation = request.operations[index];
      if (operation.condition !== undefined) {
        const condition = evaluateCondition(api, txn, operation.condition);
        if (condition !== Result.SUCCESS) {
          complete(index, condition);
          continue;
        }
      }

      if (operation.value === null) {
        try {
          api.del(txn, operation.dbi, operation.key);
          complete(index, Result.SUCCESS);
        } catch (error) {
          if (isLmdbCode(error, MDB_NOTFOUND)) {
            complete(index, Result.NOT_FOUND);
          } else if (isLmdbCode(error, MDB_BAD_VALSIZE)) {
            complete(index, Result.BAD_VALSIZE);
          } else {
            throw error;
          }
        }
        continue;
      }

      try {
        api.put(
          txn,
          operation.dbi,
          operation.key,
          operation.value,
          request.putFlags,
        );
        complete(index, Result.SUCCESS);
      } catch (error) {
        if (isLmdbCode(error, MDB_BAD_VALSIZE)) {
          complete(index, Result.BAD_VALSIZE);
        } else {
          throw error;
        }
      }
    }
    commitAttempted = true;
    api.txnCommit(txn);
    txn = undefined;
    return completedCount;
  } catch (error) {
    if (
      txn !== undefined && !commitAttempted &&
      !(error instanceof HardWorkerFailureSignal)
    ) api.txnAbort(txn);
    throw error;
  }
}

function snapshotOperation(
  input: BatchOperationInput,
  index: number,
): BatchOperationSnapshot {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`Batch operation ${index} must be an object or tuple`);
  }
  if (Array.isArray(input)) {
    const length = input.length;
    if (length < 2 || length > 4) {
      throw new TypeError(`Batch tuple ${index} must contain 2 to 4 items`);
    }
    const ifValue = input[3];
    validateIfValue(ifValue);
    return {
      db: input[0],
      key: input[1],
      value: input[2],
      ifValue,
      ifKey: undefined,
      ifDB: undefined,
      exact: false,
    };
  }
  const operation = input as BatchOperation;
  const db = operation.db;
  const key = operation.key;
  const value = operation.value;
  const ifValue = operation.ifValue;
  let exact = false;
  let ifDB: object | null | undefined;
  let ifKey: Key | null | undefined;
  if (ifValue !== undefined) {
    if (ifValue instanceof Uint8Array) {
      exact = operation.ifExactMatch === true;
    } else if (ifValue !== null) {
      throw invalidBatchValue('ifValue');
    }
    ifDB = operation.ifDB;
    ifKey = operation.ifKey;
  }
  return {
    db,
    key,
    value,
    ifValue,
    ifKey,
    ifDB,
    exact,
  };
}

function normalizeOperation(
  input: BatchOperationSnapshot,
  keyKind: KeyKind,
  lease: (owner: object) => BatchDbiTarget,
): NormalizedBatchOperation {
  const target = lease(input.db);
  const encodedKey = encodeBatchKey(input.key, keyKind);
  const normalized: {
    dbi: number;
    key: Uint8Array;
    value: Uint8Array | null;
    condition?: NormalizedBatchCondition;
  } = {
    dbi: target.handle,
    key: encodedKey,
    value: normalizeBatchValue(input.value, 'value'),
  };

  if (input.ifValue !== undefined) {
    const conditionTarget = lease(input.ifDB ?? input.db);
    normalized.condition = {
      dbi: conditionTarget.handle,
      key: input.ifKey === undefined || input.ifKey === null
        ? new Uint8Array(encodedKey)
        : encodeBatchKey(input.ifKey, keyKind),
      value: normalizeBatchValue(input.ifValue, 'ifValue'),
      exact: input.exact,
    };
  }
  return normalized;
}

function evaluateCondition(
  api: NativeApi,
  txn: Deno.PointerObject,
  condition: NormalizedBatchCondition,
): BatchResult {
  let actual: Uint8Array | null;
  try {
    actual = api.get(txn, condition.dbi, condition.key);
  } catch (error) {
    if (isLmdbCode(error, MDB_BAD_VALSIZE)) return Result.BAD_VALSIZE;
    throw error;
  }
  if (condition.value === null) {
    return actual === null ? Result.SUCCESS : Result.CONDITION_NOT_MET;
  }
  if (actual === null || actual.byteLength < condition.value.byteLength) {
    return Result.CONDITION_NOT_MET;
  }
  if (condition.exact && actual.byteLength !== condition.value.byteLength) {
    return Result.CONDITION_NOT_MET;
  }
  for (let index = 0; index < condition.value.byteLength; index++) {
    if (actual[index] !== condition.value[index]) {
      return Result.CONDITION_NOT_MET;
    }
  }
  return Result.SUCCESS;
}

function inferBatchKeyKind(
  key: Key,
  options: KeyType,
  firstDbiFormat: KeyType,
): KeyKind {
  const kind = inferKeyKind(key);
  const explicitKind = keyKindFromOptions(options);
  if (explicitKind !== undefined && explicitKind !== kind) {
    throw new Error("Specified key type doesn't match the key you gave.");
  }
  if (firstDbiFormat.keyIsUint32 === true && kind !== 'uint32') {
    throw new Error(
      "You specified keyIsUint32 on the Dbi, so you can't use other key types with it.",
    );
  }
  return kind;
}

function encodeBatchKey(key: Key, kind: KeyKind): Uint8Array {
  if (inferKeyKind(key) !== kind) {
    const expected = kind === 'string'
      ? 'string'
      : kind === 'uint32'
      ? 'unsigned 32-bit integer'
      : 'Uint8Array binary key';
    throw new TypeError(`Invalid key. Should be a ${expected}.`);
  }
  const encoding = kind === 'uint32'
    ? { keyIsUint32: true } as const
    : kind === 'buffer'
    ? { keyIsBuffer: true } as const
    : { keyIsString: true } as const;
  return new Uint8Array(encodeKey(key, encoding));
}

function normalizeBatchValue(
  value: unknown,
  name: 'value' | 'ifValue',
): Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError(
    `The ${name} must be a Uint8Array or null/undefined.`,
  );
}

function validateIfValue(value: unknown): void {
  if (
    value !== undefined && value !== null &&
    !(value instanceof Uint8Array)
  ) {
    throw invalidBatchValue('ifValue');
  }
}

function invalidBatchValue(name: 'value' | 'ifValue'): TypeError {
  return new TypeError(
    `The ${name} must be a Uint8Array or null/undefined.`,
  );
}

function inferKeyKind(key: Key): KeyKind {
  if (typeof key === 'string') return 'string';
  if (typeof key === 'number') return 'uint32';
  if (key instanceof Uint8Array) return 'buffer';
  throw new TypeError('Invalid key type');
}

function keyKindFromOptions(options: KeyType): KeyKind | undefined {
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

function putFlags(options: BatchOptionsSnapshot): number {
  let flags = 0;
  if (options.noOverwrite === true) flags |= MDB_NOOVERWRITE;
  if (options.noDupData === true) flags |= MDB_NODUPDATA;
  if (options.append === true) flags |= MDB_APPEND;
  if (options.appendDup === true) flags |= MDB_APPENDDUP;
  return flags;
}

function isLmdbCode(error: unknown, code: number): boolean {
  return error instanceof LmdbError && error.code === code;
}
