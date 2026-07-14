import { env_get_flags } from '../native/api.ts';
import {
  getDbiHandle,
  getEnvHandle,
  getSharedBindingCounts,
  getSharedEnvironment,
  getTxnHandle,
  hasEnvHandle,
  hasTxnHandle,
  poisonSharedEnvironment,
  swapDbiHandle,
} from './native_state.ts';

/** Returns native binding counts solely for repository finalizer tests. */
export const getNativeBindingCounts = getSharedBindingCounts;

/**
 * Returns native handles solely for package tests that validate memory
 * provenance. This module is intentionally absent from the public exports.
 */
export function getNativeHandles(
  txn: object,
  dbi: object,
): {
  readonly txnPointer: Deno.PointerValue;
  readonly dbiHandle: number;
} {
  return {
    txnPointer: getTxnHandle(txn),
    dbiHandle: getDbiHandle(dbi),
  };
}

/** Returns environment internals solely for repository lifecycle tests. */
export function getNativeEnvironmentDetails(env: object): {
  readonly address: bigint;
  readonly flags: number;
  readonly refCount: number;
} {
  const handle = getEnvHandle(env);
  return {
    address: Deno.UnsafePointer.value(handle),
    flags: env_get_flags(handle),
    refCount: getSharedEnvironment(env).refCount,
  };
}

/** Reports native transaction ownership solely for repository tests. */
export function hasNativeTransaction(txn: object): boolean {
  return hasTxnHandle(txn);
}

/** Reports native environment ownership solely for repository tests. */
export function hasNativeEnvironment(env: object): boolean {
  return hasEnvHandle(env);
}

/** Marks shared state poisoned solely for repository lifecycle tests. */
export function poisonNativeEnvironment(env: object): void {
  poisonSharedEnvironment(env);
}

/** Reports shared writer ownership solely for terminal cleanup tests. */
export function hasSharedActiveWriter(env: object): boolean {
  return getSharedEnvironment(env).activeWriter !== undefined;
}

/** Reports persistent batch Worker state solely for repository tests. */
export function getBatchWorkerDetails(env: object): {
  readonly active: boolean;
  readonly queued: number;
  readonly started: boolean;
  readonly workerId?: number;
} {
  const client = getSharedEnvironment(env).batchClient;
  return {
    active: client?.active ?? false,
    queued: client?.queued ?? 0,
    started: client?.started ?? false,
    workerId: client?.started === true ? client.workerId : undefined,
  };
}

/** Swaps a native DBI handle solely to exercise LMDB failure cleanup. */
export function swapNativeDbiHandle(dbi: object, next: number): number {
  return swapDbiHandle(dbi, next);
}
