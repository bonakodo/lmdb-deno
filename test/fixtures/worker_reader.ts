import { hex } from '../_support/bytes.ts';
import type { WorkerEnvironmentDescriptor } from '../../src/batch/protocol.ts';

interface ReaderRequest {
  descriptor: WorkerEnvironmentDescriptor;
  dbName: string;
  key: string;
  expectedHex: string;
}

interface NativeLibrary {
  handle: { close(): void };
}

interface NativeApi {
  txnBegin(env: Deno.PointerObject, readOnly: boolean): Deno.PointerObject;
  dbiOpen(txn: Deno.PointerObject, name: string, flags: number): number;
  get(
    txn: Deno.PointerObject,
    dbi: number,
    key: Uint8Array,
  ): Uint8Array | null;
  txnAbort(txn: Deno.PointerObject): void;
}

interface KeyOptions {
  keyIsString: true;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ReaderRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
  close(): void;
}

interface WorkerReply {
  ok: boolean;
  hex?: string;
  error?: string;
  cleanupComplete?: boolean;
}

const workerSelf = self as unknown as WorkerScope;

workerSelf.onmessage = async (event: MessageEvent<ReaderRequest>) => {
  // Authentication is parent-isolate state. This trusted internal Worker only
  // accepts its read capability and validates the cloned transport shape.
  const { dbName, descriptor, expectedHex, key } = event.data;
  let api: NativeApi | undefined;
  let library: NativeLibrary | undefined;
  let txn: Deno.PointerObject | undefined;
  let reply: WorkerReply;

  try {
    if (descriptor.capability !== 'read') {
      throw new Error('Worker reader requires read capability');
    }
    if (
      !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1
    ) {
      throw new Error('Worker reader received an invalid generation');
    }
    if (
      typeof descriptor.libraryPath !== 'string' ||
      descriptor.libraryPath.length === 0 ||
      descriptor.libraryPath.includes('\0')
    ) {
      throw new Error('Worker reader received an invalid library path');
    }
    if (
      typeof descriptor.envAddress !== 'bigint' || descriptor.envAddress <= 0n
    ) {
      throw new Error('Worker reader received an invalid environment address');
    }
    const nativeRoot = new URL('../../src/native/', import.meta.url);
    const sourceRoot = new URL('../../src/', import.meta.url);
    const libraryModuleUrl = new URL('library.ts', nativeRoot).href;
    const apiModuleUrl = new URL('api.ts', nativeRoot).href;
    const encodingModuleUrl = new URL('encoding.ts', sourceRoot).href;
    const [{ loadLibrary }, { createNativeApi }, { encodeKey }] = await Promise
      .all([
        import(libraryModuleUrl) as Promise<{
          loadLibrary(path: string): NativeLibrary;
        }>,
        import(apiModuleUrl) as Promise<{
          createNativeApi(library: NativeLibrary): NativeApi;
        }>,
        import(encodingModuleUrl) as Promise<{
          encodeKey(key: string, options: KeyOptions): Uint8Array;
        }>,
      ]);

    const env = Deno.UnsafePointer.create(descriptor.envAddress);
    if (env === null) throw new Error('Parent environment address is null');
    library = loadLibrary(descriptor.libraryPath);
    api = createNativeApi(library);
    txn = api.txnBegin(env, true);
    const dbi = api.dbiOpen(txn, dbName, 0);
    const value = api.get(txn, dbi, encodeKey(key, { keyIsString: true }));
    if (value === null) throw new Error(`Missing value for ${key}`);

    const actualHex = hex(value);
    if (actualHex !== expectedHex) {
      throw new Error(`Expected ${expectedHex}, received ${actualHex}`);
    }
    reply = { ok: true, hex: actualHex };
  } catch (error) {
    reply = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (api && txn) api.txnAbort(txn);
    } finally {
      library?.handle.close();
    }
  }
  workerSelf.postMessage({ ...reply, cleanupComplete: true });
  workerSelf.close();
};
