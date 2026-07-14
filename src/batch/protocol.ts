import type { Env } from '../env.ts';
import {
  getEnvHandle,
  getLiveGenerationCountForTest as getNativeLiveGenerationCountForTest,
  getSharedEnvironment,
  nextEnvironmentGeneration,
  registerEnvironmentDescriptorRevoker,
  releaseEnvironmentGeneration,
  type SharedEnvironmentState,
} from '../internal/native_state.ts';

/** @internal One cloneable condition evaluated inside the batch transaction. */
export interface NormalizedBatchCondition {
  readonly dbi: number;
  readonly key: Uint8Array;
  readonly value: Uint8Array | null;
  readonly exact: boolean;
}

/** @internal One cloneable operation ready for main-thread or Worker use. */
export interface NormalizedBatchOperation {
  readonly dbi: number;
  readonly key: Uint8Array;
  readonly value: Uint8Array | null;
  readonly condition?: NormalizedBatchCondition;
}

/** @internal Cloneable payload shared by both batch execution modes. */
export interface NormalizedBatchRequest {
  readonly operations: readonly NormalizedBatchOperation[];
  readonly putFlags: number;
}

/** @internal Test-only option key which is absent from all public types. */
export const TEST_TERMINATE_AFTER_BEGIN = Symbol(
  'deno-lmdb.test.terminate-after-begin',
);

/** @internal Parent-to-Worker initialization message. */
export interface BatchWorkerStartMessage {
  readonly type: 'start';
  readonly descriptor: WorkerEnvironmentDescriptor;
}

/** @internal Parent-to-Worker normalized batch message. */
export interface BatchWorkerJobMessage {
  readonly type: 'job';
  readonly id: number;
  readonly request: NormalizedBatchRequest;
  readonly terminateAfterBegin?: boolean;
}

/** @internal Cloneable representation of an exception crossing isolates. */
export interface SerializedBatchError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: number;
}

/** @internal One newly completed result sent to the parent. */
export type BatchResultDelta = readonly [index: number, result: number];

/** @internal Worker-to-parent protocol messages. */
export type BatchWorkerReply =
  | { readonly type: 'ready' }
  | {
    readonly type: 'progress';
    readonly id: number;
    readonly deltas: readonly BatchResultDelta[];
  }
  | { readonly type: 'complete'; readonly id: number }
  | {
    readonly type: 'error';
    readonly id: number;
    readonly error: SerializedBatchError;
  };

/** @internal Parent-to-Worker protocol messages. */
export type BatchWorkerMessage =
  | BatchWorkerStartMessage
  | BatchWorkerJobMessage;

/** @internal Cloneable authority for one live native environment. */
export interface WorkerEnvironmentDescriptor {
  readonly libraryPath: string;
  readonly envAddress: bigint;
  readonly generation: number;
  readonly capability: 'read' | 'batch';
}

interface IssuedDescriptorRecord extends WorkerEnvironmentDescriptor {
  readonly authenticator: WeakRef<WorkerEnvironmentDescriptor>;
  readonly state: WeakRef<SharedEnvironmentState>;
  readonly stateGeneration: number;
}

const issuedDescriptors = new Map<number, IssuedDescriptorRecord>();
const descriptorAuthenticators = new WeakMap<
  WorkerEnvironmentDescriptor,
  number
>();
const MAX_OUTSTANDING_PER_CAPABILITY = 64;

registerEnvironmentDescriptorRevoker((state) => {
  for (const token of [...state.descriptorTokens]) {
    const issued = issuedDescriptors.get(token);
    if (issued === undefined) releaseEnvironmentGeneration(token);
    else removeIssuedDescriptor(issued);
  }
});

/**
 * Creates an internal Worker authority for a live environment.
 *
 * This module is intentionally not exported from the package entrypoint.
 * Callers must validate the descriptor immediately before posting it.
 *
 * @internal
 */
export function getEnvironmentDescriptor(
  env: Env,
  capability: 'read' | 'batch',
): WorkerEnvironmentDescriptor {
  assertCapability(capability);
  const handle = getEnvHandle(env);
  const state = getSharedEnvironment(env);
  let outstanding = 0;
  for (const token of state.descriptorTokens) {
    if (issuedDescriptors.get(token)?.capability === capability) outstanding++;
  }
  if (outstanding >= MAX_OUTSTANDING_PER_CAPABILITY) {
    throw new Error(
      `Too many outstanding ${capability} environment descriptors`,
    );
  }
  const envAddress = Deno.UnsafePointer.value(handle);
  const descriptor: WorkerEnvironmentDescriptor = {
    libraryPath: state.library.path,
    envAddress,
    generation: nextEnvironmentGeneration(),
    capability,
  };
  issuedDescriptors.set(descriptor.generation, {
    ...descriptor,
    authenticator: new WeakRef(descriptor),
    state: new WeakRef(state),
    stateGeneration: state.generation,
  });
  descriptorAuthenticators.set(descriptor, descriptor.generation);
  state.descriptorTokens.add(descriptor.generation);
  return descriptor;
}

/**
 * Rejects stale or mismatched Worker authority before posting native work.
 *
 * Worker hosts cannot safely discover parent-isolate registry state, so this
 * parent-side check is mandatory immediately before every dispatch.
 *
 * @internal
 */
export function validateEnvironmentDescriptor(
  descriptor: WorkerEnvironmentDescriptor,
  capability: 'read' | 'batch',
): void {
  const issued = consumeIssuedDescriptor(descriptor);
  assertCapability(capability);
  assertDescriptorShape(descriptor);
  if (
    issued === undefined || issued.libraryPath !== descriptor.libraryPath ||
    issued.envAddress !== descriptor.envAddress ||
    issued.generation !== descriptor.generation ||
    issued.capability !== descriptor.capability ||
    issued.capability !== capability
  ) {
    throw new Error(
      `Environment descriptor does not grant authenticated ${capability} capability`,
    );
  }
  const state = issued.state.deref();
  if (
    state === undefined || state.poisoned || state.refCount === 0 ||
    state.generation !== issued.stateGeneration ||
    Deno.UnsafePointer.value(state.handle) !== descriptor.envAddress
  ) {
    throw new Error('The environment descriptor is stale or closed');
  }
}

/** @internal Returns registry size solely for repository protocol tests. */
export function getIssuedDescriptorCountForTest(): number {
  return issuedDescriptors.size;
}

/** @internal Returns live token count solely for repository protocol tests. */
export function getLiveGenerationCountForTest(): number {
  return getNativeLiveGenerationCountForTest();
}

function consumeIssuedDescriptor(
  descriptor: WorkerEnvironmentDescriptor,
): IssuedDescriptorRecord | undefined {
  if (typeof descriptor !== 'object' || descriptor === null) return undefined;
  const generation = descriptorAuthenticators.get(descriptor);
  if (generation === undefined) return undefined;
  descriptorAuthenticators.delete(descriptor);
  const issued = issuedDescriptors.get(generation);
  if (issued === undefined) return undefined;
  removeIssuedDescriptor(issued);
  return issued;
}

function removeIssuedDescriptor(issued: IssuedDescriptorRecord): void {
  issuedDescriptors.delete(issued.generation);
  const descriptor = issued.authenticator.deref();
  if (descriptor !== undefined) descriptorAuthenticators.delete(descriptor);
  issued.state.deref()?.descriptorTokens.delete(issued.generation);
  releaseEnvironmentGeneration(issued.generation);
}

function assertDescriptorShape(
  descriptor: WorkerEnvironmentDescriptor,
): void {
  if (
    typeof descriptor.libraryPath !== 'string' ||
    descriptor.libraryPath.length === 0 ||
    descriptor.libraryPath.includes('\0') ||
    typeof descriptor.envAddress !== 'bigint' || descriptor.envAddress <= 0n ||
    !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1
  ) {
    throw new TypeError('Invalid environment descriptor shape');
  }
  assertCapability(descriptor.capability);
}

function assertCapability(value: string): asserts value is 'read' | 'batch' {
  if (value !== 'read' && value !== 'batch') {
    throw new TypeError(`Invalid environment descriptor capability: ${value}`);
  }
}
