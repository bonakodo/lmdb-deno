import type { Env } from '../env.ts';
import {
  getSharedEnvironment,
  type InternalWriterReservation,
  poisonSharedEnvironmentState,
  releaseInternalWriter,
  reserveInternalWriter,
  type SharedBatchClient,
  type SharedEnvironmentState,
} from '../internal/native_state.ts';
import { LmdbError } from '../native/errors.ts';
import type { BatchCallback, BatchProgress, BatchResult } from '../types.ts';
import { type PreparedBatch, releasePreparedBatch } from './executor.ts';
import {
  type BatchResultDelta,
  type BatchWorkerMessage,
  type BatchWorkerReply,
  getEnvironmentDescriptor,
  type SerializedBatchError,
  validateEnvironmentDescriptor,
} from './protocol.ts';

interface RetainedBatchJob {
  readonly id: number;
  readonly env: Env;
  readonly prepared: PreparedBatch;
  readonly operationCount: number;
  readonly received: Uint8Array;
  readonly progress?: BatchProgress;
  readonly callback: BatchCallback;
  readonly results: BatchResult[];
  readonly terminateAfterBegin: boolean;
  readonly callbackErrors: unknown[];
  receivedCount: number;
}

let nextClientId = 1;
let nextJobId = 1;

/** @internal One persistent FIFO Worker client per shared environment. */
export class BatchWorkerClient implements SharedBatchClient {
  readonly workerId = nextClientId++;
  readonly #state: SharedEnvironmentState;
  readonly #jobs = new Map<number, RetainedBatchJob>();
  #queue: RetainedBatchJob[] = [];
  #active?: RetainedBatchJob;
  #reservation?: InternalWriterReservation;
  #worker?: Worker;
  #ready = false;
  #dispatchedJobId?: number;
  #closed = false;

  constructor(state: SharedEnvironmentState) {
    this.#state = state;
  }

  get active(): boolean {
    return this.#active !== undefined;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get started(): boolean {
    return this.#worker !== undefined;
  }

  enqueue(
    env: Env,
    prepared: PreparedBatch,
    progress: BatchProgress | undefined,
    callback: BatchCallback,
    terminateAfterBegin: boolean,
  ): void {
    if (this.#closed || this.#state.poisoned) {
      throw new Error(
        'The environment is poisoned after a native Worker failure',
      );
    }
    const job: RetainedBatchJob = {
      id: nextJobId++,
      env,
      prepared,
      operationCount: prepared.request.operations.length,
      received: new Uint8Array(prepared.request.operations.length),
      progress,
      callback,
      results: new Array<BatchResult>(prepared.request.operations.length),
      terminateAfterBegin,
      callbackErrors: [],
      receivedCount: 0,
    };
    this.#jobs.set(job.id, job);
    if (this.#active !== undefined) {
      this.#queue.push(job);
      return;
    }

    try {
      this.#activate(job);
    } catch (error) {
      this.#jobs.delete(job.id);
      throw error;
    }
  }

  close(): void {
    if (this.#active !== undefined || this.#queue.length !== 0) {
      throw new Error(
        'Cannot close the environment while a batch operation is pending or active',
      );
    }
    this.#closed = true;
    this.#resetWorker();
    if (this.#state.batchClient === this) {
      this.#state.batchClient = undefined;
    }
  }

  #activate(job: RetainedBatchJob): void {
    try {
      const reservation = reserveInternalWriter(job.env);
      this.#reservation = reservation;
      this.#active = job;
      if (this.#worker === undefined) this.#start(job.env);
      if (this.#ready) this.#postJob(job);
    } catch (error) {
      this.#recoverUndispatched(asError(error));
    }
  }

  #start(env: Env): void {
    const descriptor = getEnvironmentDescriptor(env, 'batch');
    validateEnvironmentDescriptor(descriptor, 'batch');
    const worker = new Worker(new URL('./worker.ts', import.meta.url).href, {
      type: 'module',
    });
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<BatchWorkerReply>) => {
      if (this.#worker !== worker) return;
      this.#handleMessage(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.#worker !== worker) return;
      const error = event.error instanceof Error ? event.error : new Error(
        event.message || 'The batch Worker terminated unexpectedly',
      );
      if (this.#dispatchedJobId === undefined) {
        this.#recoverUndispatched(error);
      } else {
        this.#failUnexpectedly(error);
      }
    };
    worker.onmessageerror = () => {
      if (this.#worker !== worker) return;
      const error = new Error('The batch Worker protocol failed to clone');
      if (this.#dispatchedJobId === undefined) {
        this.#recoverUndispatched(error);
      } else {
        this.#failUnexpectedly(error);
      }
    };
    const message: BatchWorkerMessage = { type: 'start', descriptor };
    worker.postMessage(message);
  }

  #postJob(job: RetainedBatchJob): void {
    const worker = this.#worker;
    if (worker === undefined) {
      throw new Error('The batch Worker is unavailable');
    }
    const message: BatchWorkerMessage = {
      type: 'job',
      id: job.id,
      request: job.prepared.request,
      ...(job.terminateAfterBegin ? { terminateAfterBegin: true } : {}),
    };
    worker.postMessage(message);
    this.#dispatchedJobId = job.id;
  }

  #handleMessage(message: BatchWorkerReply): void {
    if (this.#closed) return;
    if (message.type === 'ready') {
      if (this.#ready || this.#active === undefined) {
        this.#failProtocol(
          new Error('Unexpected batch Worker ready message'),
        );
        return;
      }
      this.#ready = true;
      try {
        this.#postJob(this.#active);
      } catch (error) {
        this.#recoverUndispatched(asError(error));
      }
      return;
    }

    const job = this.#active;
    if (
      job === undefined || job.id !== message.id ||
      this.#dispatchedJobId !== message.id
    ) {
      this.#failProtocol(new Error('Unexpected batch Worker job response'));
      return;
    }
    if (message.type === 'progress') {
      try {
        applyDeltas(job, message.deltas);
      } catch (error) {
        this.#failUnexpectedly(asError(error));
        return;
      }
      if (job.progress !== undefined) {
        try {
          job.progress(job.results);
        } catch (error) {
          job.callbackErrors.push(error);
        }
      }
      return;
    }
    if (message.type === 'error') {
      this.#dispatchedJobId = undefined;
      this.#finish(job, reviveError(message.error));
      return;
    }
    if (!hasEveryResult(job)) {
      this.#failUnexpectedly(
        new Error('Batch Worker completed without every operation result'),
      );
      return;
    }
    this.#dispatchedJobId = undefined;
    this.#finish(job, null);
  }

  #finish(job: RetainedBatchJob, workerError: Error | null): void {
    if (this.#active !== job) return;
    this.#active = undefined;
    this.#jobs.delete(job.id);
    let completionError = workerError;
    try {
      releasePreparedBatch(job.prepared);
    } catch (error) {
      completionError ??= asError(error);
    }
    const reservation = this.#reservation;
    this.#reservation = undefined;
    releaseInternalWriter(reservation);

    const next = this.#queue.shift();
    if (next !== undefined) {
      try {
        this.#activate(next);
      } catch (error) {
        this.#recoverUndispatched(asError(error));
      }
    }

    try {
      if (completionError === null) job.callback(null, job.results);
      else job.callback(completionError);
    } catch (error) {
      job.callbackErrors.push(error);
    }
    reportCallbackErrors(job.callbackErrors);
  }

  #failUnexpectedly(cause: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetWorker();
    poisonSharedEnvironmentState(this.#state);

    const jobs = [...this.#jobs.values()];
    this.#active = undefined;
    this.#queue = [];
    this.#jobs.clear();
    const reservation = this.#reservation;
    this.#reservation = undefined;
    releaseInternalWriter(reservation);

    const failure = new Error(
      `The batch Worker terminated unexpectedly; the environment is poisoned: ${cause.message}`,
      { cause },
    );
    for (const job of jobs) {
      try {
        releasePreparedBatch(job.prepared);
      } catch {
        // Poisoning forbids native cleanup; callback failure stays authoritative.
      }
    }
    for (const job of jobs) {
      try {
        job.callback(failure);
      } catch (error) {
        job.callbackErrors.push(error);
      }
      reportCallbackErrors(job.callbackErrors);
    }
  }

  #failProtocol(cause: Error): void {
    if (this.#dispatchedJobId === undefined) {
      this.#recoverUndispatched(cause);
    } else {
      this.#failUnexpectedly(cause);
    }
  }

  #recoverUndispatched(cause: Error): void {
    if (this.#closed) return;
    this.#resetWorker();
    const jobs = [...this.#jobs.values()];
    this.#active = undefined;
    this.#queue = [];
    this.#jobs.clear();
    const reservation = this.#reservation;
    this.#reservation = undefined;
    releaseInternalWriter(reservation);

    let cleanupError: Error | undefined;
    for (const job of jobs) {
      try {
        releasePreparedBatch(job.prepared);
      } catch (error) {
        cleanupError ??= asError(error);
      }
    }
    const failure = new Error(
      `The batch Worker could not dispatch; no native transaction was started: ${cause.message}`,
      { cause: cleanupError ?? cause },
    );
    queueMicrotask(() => {
      for (const job of jobs) {
        try {
          job.callback(failure);
        } catch (error) {
          job.callbackErrors.push(error);
        }
        reportCallbackErrors(job.callbackErrors);
      }
    });
  }

  #resetWorker(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#ready = false;
    this.#dispatchedJobId = undefined;
    worker?.terminate();
  }
}

/** @internal Queues one normalized batch on the shared persistent Worker. */
export function queueWorkerBatch(
  env: Env,
  prepared: PreparedBatch,
  progress: BatchProgress | undefined,
  callback: BatchCallback,
  terminateAfterBegin = false,
): void {
  const state = getSharedEnvironment(env);
  const client = state.batchClient ?? new BatchWorkerClient(state);
  state.batchClient = client;
  if (!(client instanceof BatchWorkerClient)) {
    throw new Error('Invalid shared batch Worker client');
  }
  client.enqueue(env, prepared, progress, callback, terminateAfterBegin);
}

function applyDeltas(
  job: RetainedBatchJob,
  deltas: readonly BatchResultDelta[],
): void {
  for (const [index, result] of deltas) {
    if (
      !Number.isSafeInteger(index) || index < 0 ||
      index >= job.operationCount ||
      job.received[index] !== 0 || !Number.isSafeInteger(result)
    ) {
      throw new Error('Invalid or duplicate batch Worker result delta');
    }
    job.received[index] = 1;
    job.receivedCount++;
    job.results[index] = result as BatchResult;
  }
}

function hasEveryResult(job: RetainedBatchJob): boolean {
  if (job.receivedCount !== job.operationCount) return false;
  for (let index = 0; index < job.operationCount; index++) {
    if (job.received[index] === 0) return false;
  }
  return true;
}

function reviveError(serialized: SerializedBatchError): Error {
  const error = serialized.code === undefined
    ? new Error(serialized.message)
    : new LmdbError(serialized.code, serialized.message);
  error.name = serialized.name;
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  return error;
}

function reportCallbackErrors(errors: readonly unknown[]): void {
  for (const error of errors) {
    setTimeout(() => {
      throw error;
    }, 0);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
