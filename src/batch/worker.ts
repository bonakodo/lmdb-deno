import type { NativeApi } from '../native/api.ts';
import type {
  BatchWorkerJobMessage,
  BatchWorkerMessage,
  BatchWorkerReply,
  SerializedBatchError,
  WorkerEnvironmentDescriptor,
} from './protocol.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent<BatchWorkerMessage>) => void) | null;
  postMessage(message: BatchWorkerReply): void;
}

type ExecuteBatch = typeof import('./executor.ts')['executeBatch'];
type HardFailureConstructor =
  typeof import('./executor.ts')['HardWorkerFailureSignal'];

const workerSelf = self as unknown as WorkerScope;
let environment: Deno.PointerObject | undefined;
let api: NativeApi | undefined;
let executeBatch: ExecuteBatch | undefined;
let HardWorkerFailureSignal: HardFailureConstructor | undefined;
let initialization: Promise<void> | undefined;

workerSelf.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'start') {
    if (initialization !== undefined) {
      reportUnhandled(new Error('Batch Worker was initialized more than once'));
      return;
    }
    initialization = initialize(message.descriptor);
    void initialization.then(
      () => workerSelf.postMessage({ type: 'ready' }),
      reportUnhandled,
    );
    return;
  }

  if (initialization === undefined) {
    reportUnhandled(new Error('Batch Worker received a job before startup'));
    return;
  }
  void initialization.then(
    () => runJob(message),
    reportUnhandled,
  );
};

async function initialize(
  descriptor: WorkerEnvironmentDescriptor,
): Promise<void> {
  assertDescriptor(descriptor);
  const pointer = Deno.UnsafePointer.create(descriptor.envAddress);
  if (pointer === null) {
    throw new Error('Batch Worker received a null environment pointer');
  }

  const { loadLibrary } = await import('../native/library.ts');
  const library = loadLibrary(descriptor.libraryPath);
  const slot = '__denoLmdbWorkerLibrary';
  const workerGlobal = globalThis as typeof globalThis & {
    [slot]?: typeof library;
  };
  workerGlobal[slot] = library;
  const nativeModule = await import('../native/api.ts');
  const executorModule = await import('./executor.ts');
  api = nativeModule.createNativeApi(library);
  executeBatch = executorModule.executeBatch;
  HardWorkerFailureSignal = executorModule.HardWorkerFailureSignal;
  environment = pointer;
}

function runJob(message: BatchWorkerJobMessage): void {
  if (
    environment === undefined || api === undefined ||
    executeBatch === undefined || HardWorkerFailureSignal === undefined
  ) {
    reportUnhandled(new Error('Batch Worker native state is unavailable'));
    return;
  }
  const results = new Array(message.request.operations.length);
  try {
    executeBatch(environment, message.request, results, api, {
      terminateAfterBegin: message.terminateAfterBegin,
      onResult(index, result) {
        workerSelf.postMessage({
          type: 'progress',
          id: message.id,
          deltas: [[index, result]],
        });
      },
    });
  } catch (error) {
    if (error instanceof HardWorkerFailureSignal) {
      reportUnhandled(error);
      return;
    }
    workerSelf.postMessage({
      type: 'error',
      id: message.id,
      error: serializeError(error),
    });
    return;
  }
  workerSelf.postMessage({ type: 'complete', id: message.id });
}

function assertDescriptor(descriptor: WorkerEnvironmentDescriptor): void {
  if (
    typeof descriptor !== 'object' || descriptor === null ||
    descriptor.capability !== 'batch' ||
    typeof descriptor.libraryPath !== 'string' ||
    descriptor.libraryPath.length === 0 ||
    descriptor.libraryPath.includes('\0') ||
    typeof descriptor.envAddress !== 'bigint' || descriptor.envAddress <= 0n ||
    !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1
  ) {
    throw new TypeError(
      'Batch Worker received an invalid environment descriptor',
    );
  }
}

function serializeError(value: unknown): SerializedBatchError {
  const error = value instanceof Error ? value : new Error(String(value));
  const code = 'code' in error && typeof error.code === 'number'
    ? error.code
    : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(code === undefined ? {} : { code }),
  };
}

function reportUnhandled(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}
