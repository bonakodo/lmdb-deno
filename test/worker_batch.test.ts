import {
  deepStrictEqual as assertEquals,
  match as assertMatch,
  ok as assert,
  throws as assertThrows,
} from 'node:assert/strict';
import type {
  BatchOperationInput,
  BatchOptions,
  BatchResult,
  DbiContract,
  EnvContract,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';
import { loadSubject } from './_support/subject.ts';

interface BatchCompletion {
  readonly error: Error | null;
  readonly results?: BatchResult[];
}

interface InjectedWorkerFailure {
  readonly postCount: () => number;
  readonly terminationCount: () => number;
  readonly restore: () => void;
}

function injectWorkerConstructionFailure(): {
  readonly error: Error;
  readonly restore: () => void;
} {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  if (original === undefined) throw new Error('Worker global is unavailable');
  const error = new Error('injected Worker construction failure');
  const InjectedWorker = function (): Worker {
    throw error;
  } as unknown as typeof Worker;
  Object.defineProperty(globalThis, 'Worker', {
    ...original,
    value: InjectedWorker,
  });
  return {
    error,
    restore: () => Object.defineProperty(globalThis, 'Worker', original),
  };
}

function injectWorkerPostFailure(failAt: number): InjectedWorkerFailure {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  if (original === undefined) throw new Error('Worker global is unavailable');
  const NativeWorker = Worker;
  let posts = 0;
  let terminations = 0;
  const InjectedWorker = function (
    this: Worker,
    specifier: string | URL,
    options?: WorkerOptions,
  ): Worker {
    const worker = new NativeWorker(specifier, options);
    return new Proxy(worker, {
      get(target, property) {
        if (property === 'postMessage') {
          return (message: unknown, options?: StructuredSerializeOptions) => {
            posts++;
            if (posts === failAt) {
              throw new Error(`injected Worker post failure ${failAt}`);
            }
            target.postMessage(message, options);
          };
        }
        if (property === 'terminate') {
          return () => {
            terminations++;
            target.terminate();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      },
    });
  } as unknown as typeof Worker;
  Object.defineProperty(globalThis, 'Worker', {
    ...original,
    value: InjectedWorker,
  });
  return {
    postCount: () => posts,
    terminationCount: () => terminations,
    restore: () => Object.defineProperty(globalThis, 'Worker', original),
  };
}

function submitBatch(
  env: EnvContract,
  operations: BatchOperationInput[],
  options?: BatchOptions,
): Promise<BatchCompletion> {
  return new Promise((resolve) => {
    const callback = (error: Error | null, results?: BatchResult[]) => {
      resolve({ error, results });
    };
    if (options) env.batchWrite(operations, options, callback);
    else env.batchWrite(operations, callback);
  });
}

function awaitBatch(
  completion: Promise<BatchCompletion>,
  operation = 'batch completion callback',
): Promise<BatchCompletion> {
  return withDeadline(completion, 10_000, operation);
}

async function runMode(
  path: string,
  useWorker: boolean | undefined,
): Promise<{ results?: BatchResult[]; value: Uint8Array | null }> {
  const { Env } = await loadSubject();
  const env = new Env();
  let dbi: DbiContract | undefined;
  let txn: TxnContract | undefined;
  return await withCleanup(
    async () => {
      Deno.mkdirSync(path);
      env.open({
        path,
        mapSize: 16 * 1024 * 1024,
        maxDbs: 2,
        ...(useWorker === undefined ? {} : { useWorker }),
      });
      dbi = env.openDbi({ name: 'mode', create: true });
      const completion = await awaitBatch(
        submitBatch(env, [
          [dbi, 'same-key', new Uint8Array([3, 1, 4])],
        ]),
      );
      assertEquals(completion.error, null);
      txn = env.beginTxn({ readOnly: true });
      const value = txn.getBinary(dbi, 'same-key');
      txn.commit();
      txn = undefined;
      return { results: completion.results, value };
    },
    [
      () => txn?.abort(),
      () => dbi?.close(),
      () => env.close(),
    ],
  );
}

Deno.test('default Worker mode and useWorker false produce identical results', async () => {
  await withTempDir(async (root) => {
    const worker = await runMode(`${root}/worker`, undefined);
    const callingThread = await runMode(`${root}/calling-thread`, false);
    assertEquals(worker, {
      results: [0],
      value: new Uint8Array([3, 1, 4]),
    });
    assertEquals(callingThread, worker);
  });
});

Deno.test('Worker construction failure is asynchronous and releases retained state', async () => {
  const { Env } = await loadSubject();
  const accessModule = '../src/internal/native_test_access.ts';
  const access = await import(accessModule) as {
    getNativeBindingCounts(env: object): { batchDbiLeases: number };
    hasSharedActiveWriter(env: object): boolean;
  };
  await withTempDir((path) => {
    const injected = injectWorkerConstructionFailure();
    let restored = false;
    const env = new Env();
    let dbi: DbiContract | undefined;
    const events: string[] = [];
    let callbackCount = 0;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        const completion = new Promise<BatchCompletion>((resolve) => {
          events.push('before');
          env.batchWrite(
            [[dbi!, 'construction', new Uint8Array([1])]],
            (error, results) => {
              callbackCount++;
              events.push('callback');
              resolve({ error, results });
            },
          );
          events.push('after');
        });
        assertEquals(events, ['before', 'after']);
        const failure = await awaitBatch(
          completion,
          'Worker construction failure callback',
        );
        assert(failure.error instanceof Error);
        assertMatch(failure.error.message, /construction failure/i);
        assertEquals(failure.results, undefined);
        assertEquals(callbackCount, 1);
        assertEquals(events, ['before', 'after', 'callback']);
        assertEquals(access.hasSharedActiveWriter(env), false);
        assertEquals(access.getNativeBindingCounts(env).batchDbiLeases, 0);

        injected.restore();
        restored = true;
        assertEquals(
          await awaitBatch(submitBatch(env, [
            [dbi, 'recovered', new Uint8Array([2])],
          ])),
          { error: null, results: [0] },
        );
      },
      [
        () => restored ? undefined : injected.restore(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('Worker writer reservation failure reaches the callback asynchronously', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let writer: TxnContract | undefined;
    let closed = false;
    const events: string[] = [];
    let callbackCount = 0;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        writer = env.beginTxn();
        const completion = new Promise<BatchCompletion>((resolve, reject) => {
          events.push('before');
          env.batchWrite(
            [[dbi!, 'blocked', new Uint8Array([1])]],
            (error, results) => {
              callbackCount++;
              events.push('callback');
              try {
                writer!.abort();
                writer = undefined;
                dbi!.close();
                dbi = undefined;
                env.close();
                closed = true;
                resolve({ error, results });
              } catch (caught) {
                reject(caught);
              }
            },
          );
          events.push('after');
        });
        assertEquals(events, ['before', 'after']);
        const failure = await awaitBatch(
          completion,
          'Worker writer reservation failure callback',
        );
        assert(failure.error instanceof Error);
        assertMatch(
          failure.error.message,
          /write transaction|second one|writer/i,
        );
        assertEquals(failure.results, undefined);
        assertEquals(callbackCount, 1);
        assertEquals(events, ['before', 'after', 'callback']);
        assertEquals(closed, true);
      },
      [
        () => writer?.abort(),
        () => dbi?.close(),
        () => closed ? undefined : env.close(),
      ],
    );
  });
});

Deno.test('batch input validation throws synchronously before callbacks', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        let callbackCount = 0;
        const callback = () => callbackCount++;
        const unsafeBatch = env.batchWrite.bind(env) as unknown as (
          ...args: unknown[]
        ) => unknown;
        assertThrows(
          () => unsafeBatch('not-an-array', callback),
          /operations.*array/i,
        );
        assertThrows(
          () => unsafeBatch([[dbi, 'key', 'not-binary']], callback),
          /Uint8Array|binary/i,
        );
        assertThrows(
          () => unsafeBatch([[dbi, 'key', new Uint8Array([1])]]),
          /callback/i,
        );
        await Promise.resolve();
        assertEquals(callbackCount, 0);
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('default batching starts one Worker lazily and reuses it across wrappers', async () => {
  const { Env } = await loadSubject();
  const accessModule = '../src/internal/native_test_access.ts';
  const { getBatchWorkerDetails } = await import(accessModule) as {
    getBatchWorkerDetails(env: object): {
      active: boolean;
      queued: number;
      started: boolean;
      workerId?: number;
    };
  };
  await withTempDir((path) => {
    const first = new Env();
    const second = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        first.open({ path });
        second.open({ path: `${path}/.` });
        dbi = first.openDbi({ name: null, create: true });
        assertEquals(getBatchWorkerDetails(first), {
          active: false,
          queued: 0,
          started: false,
          workerId: undefined,
        });

        assertEquals(
          (await awaitBatch(submitBatch(first, [
            [dbi, 'first', new Uint8Array([1])],
          ]))).error,
          null,
        );
        const afterFirst = getBatchWorkerDetails(first);
        assertEquals(afterFirst.started, true);
        assertEquals(typeof afterFirst.workerId, 'number');
        assertEquals(getBatchWorkerDetails(second), afterFirst);

        assertEquals(
          (await awaitBatch(submitBatch(second, [
            [dbi, 'second', new Uint8Array([2])],
          ]))).error,
          null,
        );
        assertEquals(getBatchWorkerDetails(first), afterFirst);
      },
      [() => dbi?.close(), () => second.close(), () => first.close()],
    );
  });
});

Deno.test('startup post failure releases state and a later Worker batch recovers', async () => {
  const { Env } = await loadSubject();
  const accessModule = '../src/internal/native_test_access.ts';
  const access = await import(accessModule) as {
    getBatchWorkerDetails(env: object): {
      active: boolean;
      queued: number;
      started: boolean;
      workerId?: number;
    };
    getNativeBindingCounts(env: object): { batchDbiLeases: number };
    hasSharedActiveWriter(env: object): boolean;
  };
  await withTempDir((path) => {
    const injected = injectWorkerPostFailure(1);
    const env = new Env();
    let dbi: DbiContract | undefined;
    let callbackCalls = 0;
    const callbackEvents: string[] = [];
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        callbackEvents.push('before');
        const failed = await awaitBatch(
          new Promise<BatchCompletion>((resolve) => {
            env.batchWrite(
              [[dbi!, 'failed-start', new Uint8Array([1])]],
              (error, results) => {
                callbackCalls++;
                callbackEvents.push('callback');
                resolve({ error, results });
              },
            );
            callbackEvents.push('after');
            assertEquals(callbackEvents, ['before', 'after']);
          }),
          'startup post failure callback',
        );
        assert(failed.error instanceof Error);
        assertEquals(failed.results, undefined);
        assertEquals(callbackCalls, 1);
        assertEquals(callbackEvents, ['before', 'after', 'callback']);
        assertEquals(access.hasSharedActiveWriter(env), false);
        assertEquals(access.getNativeBindingCounts(env).batchDbiLeases, 0);
        assertEquals(access.getBatchWorkerDetails(env), {
          active: false,
          queued: 0,
          started: false,
          workerId: undefined,
        });
        assertEquals(injected.terminationCount(), 1);

        const recovered = await awaitBatch(submitBatch(env, [
          [dbi, 'recovered', new Uint8Array([2])],
        ]));
        assertEquals(recovered, { error: null, results: [0] });
        assertEquals(injected.postCount(), 3);
      },
      [
        injected.restore,
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('queued dispatch post failure releases every retained job once', async () => {
  const { Env } = await loadSubject();
  const accessModule = '../src/internal/native_test_access.ts';
  const access = await import(accessModule) as {
    getBatchWorkerDetails(env: object): {
      active: boolean;
      queued: number;
      started: boolean;
      workerId?: number;
    };
    getNativeBindingCounts(env: object): { batchDbiLeases: number };
    hasSharedActiveWriter(env: object): boolean;
  };
  await withTempDir((path) => {
    const injected = injectWorkerPostFailure(3);
    const env = new Env();
    let dbi: DbiContract | undefined;
    const callbackOrder: number[] = [];
    const callbackCounts = [0, 0, 0];
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        const tracked = (
          index: number,
          key: string,
        ): Promise<BatchCompletion> =>
          new Promise((resolve) => {
            env.batchWrite(
              [[dbi!, key, new Uint8Array([index])]],
              (error, results) => {
                callbackCounts[index - 1]++;
                callbackOrder.push(index);
                resolve({ error, results });
              },
            );
          });
        const first = tracked(1, 'first');
        const second = tracked(2, 'second');
        const third = tracked(3, 'third');
        const completions = await withDeadline(
          Promise.all([first, second, third]),
          10_000,
          'queued dispatch failure callbacks',
        );
        assertEquals(completions[0], { error: null, results: [0] });
        assert(completions[1].error instanceof Error);
        assertEquals(completions[1].results, undefined);
        assert(completions[2].error instanceof Error);
        assertEquals(completions[2].results, undefined);
        assertEquals(callbackCounts, [1, 1, 1]);
        assertEquals(callbackOrder, [1, 2, 3]);
        assertEquals(access.hasSharedActiveWriter(env), false);
        assertEquals(access.getNativeBindingCounts(env).batchDbiLeases, 0);
        assertEquals(access.getBatchWorkerDetails(env), {
          active: false,
          queued: 0,
          started: false,
          workerId: undefined,
        });
        assertEquals(injected.terminationCount(), 1);

        const recovered = await awaitBatch(submitBatch(env, [
          [dbi, 'after-dispatch-failure', new Uint8Array([4])],
        ]));
        assertEquals(recovered, { error: null, results: [0] });
        assertEquals(injected.postCount(), 5);
      },
      [
        injected.restore,
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('default Worker batches execute FIFO and block calling-thread writers', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const workerEnv = new Env();
    const callingEnv = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        workerEnv.open({ path });
        callingEnv.open({ path: `${path}/.`, useWorker: false });
        dbi = workerEnv.openDbi({ name: null, create: true });
        const callbackOrder: number[] = [];
        const first = submitBatch(
          workerEnv,
          Array.from(
            { length: 256 },
            (_, index) => [
              dbi!,
              `first-${index}`,
              new Uint8Array([index]),
            ],
          ),
        ).then((result) => {
          callbackOrder.push(1);
          return result;
        });
        const second = submitBatch(workerEnv, [
          [dbi, 'second', new Uint8Array([2])],
        ]).then((result) => {
          callbackOrder.push(2);
          return result;
        });
        const third = submitBatch(workerEnv, [
          [dbi, 'third', new Uint8Array([3])],
        ]).then((result) => {
          callbackOrder.push(3);
          return result;
        });

        assertThrows(
          () =>
            callingEnv.batchWrite(
              [[dbi!, 'blocked', new Uint8Array([9])]],
              () => {},
            ),
          /write transaction|second one|writer/i,
        );
        const completions = await Promise.all([
          awaitBatch(first),
          awaitBatch(second),
          awaitBatch(third),
        ]);
        assertEquals(completions.map(({ error }) => error), [null, null, null]);
        assertEquals(callbackOrder, [1, 2, 3]);
      },
      [() => dbi?.close(), () => callingEnv.close(), () => workerEnv.close()],
    );
  });
});

Deno.test('batch completion callback is always asynchronous', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    const calls: string[] = [];
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        calls.push('before');
        const completed = new Promise<void>((resolve, reject) => {
          env.batchWrite(
            [[dbi!, 'key', new Uint8Array([1])]],
            (error, results) => {
              calls.push('callback');
              try {
                assertEquals(error, null);
                assertEquals(results, [0]);
                assertEquals(calls, ['before', 'after', 'callback']);
                resolve();
              } catch (assertionError) {
                reject(assertionError);
              }
            },
          );
        });
        calls.push('after');
        assertEquals(calls, ['before', 'after']);
        await withDeadline(completed, 10_000, 'asynchronous batch callback');
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('progress and completion share one parent-owned result array', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        const operations: BatchOperationInput[] = Array.from(
          { length: 128 },
          (_, index) => [dbi!, `key-${index}`, new Uint8Array([index])],
        );
        let identity: BatchResult[] | undefined;
        let completedPrefix = 0;
        let progressError: unknown;
        const calls: string[] = [];
        const completion = await awaitBatch(
          submitBatch(env, operations, {
            progress(results) {
              calls.push('progress');
              try {
                if (identity === undefined) identity = results;
                else assertEquals(results === identity, true);
                assertEquals(results.length, operations.length);

                let prefix = 0;
                while (prefix < results.length && prefix in results) prefix++;
                assert(prefix >= completedPrefix);
                assertEquals(results.slice(0, prefix), Array(prefix).fill(0));
                for (let index = prefix; index < results.length; index++) {
                  assertEquals(index in results, false);
                }
                completedPrefix = prefix;
              } catch (error) {
                progressError ??= error;
              }
            },
          }).then((completion) => {
            calls.push('completion');
            return completion;
          }),
        );

        if (progressError !== undefined) throw progressError;
        assertEquals(completion.error, null);
        assertEquals(completion.results, Array(operations.length).fill(0));
        assertEquals(identity !== undefined, true);
        assertEquals(completion.results === identity, true);
        assertEquals(calls, ['progress', 'completion']);
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('progress skips empty and immediate-error batches', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let seed: TxnContract | undefined;
    let progressCalls = 0;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        const empty = await awaitBatch(submitBatch(env, [], {
          progress: () => progressCalls++,
        }));
        assertEquals(empty, { error: null, results: [] });

        seed = env.beginTxn();
        seed.putBinary(dbi, 'existing', new Uint8Array([1]));
        seed.commit();
        seed = undefined;
        const failed = await awaitBatch(submitBatch(
          env,
          [[dbi, 'existing', new Uint8Array([2])]],
          { noOverwrite: true, progress: () => progressCalls++ },
        ));
        assert(failed.error instanceof Error);
        assertEquals(failed.results, undefined);
        assertEquals(progressCalls, 0);
      },
      [() => seed?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('progress reports only the completed prefix before a later error', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let seed: TxnContract | undefined;
    let progressResults: BatchResult[] | undefined;
    const calls: string[] = [];
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        seed = env.beginTxn();
        seed.putBinary(dbi, 'existing', new Uint8Array([1]));
        seed.commit();
        seed = undefined;
        const completion = await awaitBatch(
          submitBatch(
            env,
            [
              [dbi, 'completed', new Uint8Array([2])],
              [dbi, 'existing', new Uint8Array([3])],
            ],
            {
              noOverwrite: true,
              progress(results) {
                calls.push('progress');
                progressResults = results;
                assertEquals(results.length, 2);
                assertEquals(results[0], 0);
                assertEquals(1 in results, false);
              },
            },
          ).then((result) => {
            calls.push('final');
            return result;
          }),
        );
        assert(completion.error instanceof Error);
        assertEquals(completion.results, undefined);
        assertEquals(progressResults?.length, 2);
        assertEquals(progressResults?.[0], 0);
        assertEquals(1 in progressResults!, false);
        assertEquals(calls, ['progress', 'final']);
      },
      [() => seed?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('calling-thread batch clears native state before callbacks run', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        const operations: BatchOperationInput[] = Array.from(
          { length: 256 },
          (_, index) => [dbi!, `key-${index}`, new Uint8Array([index])],
        );
        const completion = submitBatch(env, operations);
        const txn = env.beginTxn();
        txn.abort();
        const second = submitBatch(env, [
          [dbi, 'after-first', new Uint8Array([9])],
        ]);
        dbi.close();
        dbi = undefined;
        env.close();
        const result = await awaitBatch(
          completion,
          'calling-thread batch completion callback',
        );
        assertEquals(result.error, null);
        assertEquals(result.results, Array(operations.length).fill(0));
        assertEquals((await awaitBatch(second)).results, [0]);
      },
      [() => dbi?.close(), () => dbi === undefined ? undefined : env.close()],
    );
  });
});

Deno.test('close succeeds from the final batch callback', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let closed = false;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        await withDeadline(
          new Promise<void>((resolve, reject) => {
            env.batchWrite(
              [[dbi!, 'key', new Uint8Array([1])]],
              (error, results) => {
                try {
                  assertEquals(error, null);
                  assertEquals(results, [0]);
                  dbi!.close();
                  dbi = undefined;
                  env.close();
                  closed = true;
                  resolve();
                } catch (assertionError) {
                  reject(assertionError);
                }
              },
            );
          }),
          10_000,
          'close in final batch callback',
        );
        assertEquals(closed, true);
      },
      [() => dbi?.close(), () => closed ? undefined : env.close()],
    );
  });
});

Deno.test('progress errors surface after completion without retaining native state', async () => {
  const { Env } = await loadSubject();
  await withTempDir(async (path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    const sentinel = new Error('batch progress sentinel');
    const order: string[] = [];
    let listener: ((event: ErrorEvent) => void) | undefined;
    await withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        const reported = new Promise<unknown>((resolve) => {
          listener = (event) => {
            if (event.error !== sentinel) return;
            event.preventDefault();
            order.push('error');
            resolve(event.error);
          };
          addEventListener('error', listener);
        });
        const completed = new Promise<void>((resolve, reject) => {
          env.batchWrite(
            [[dbi!, 'key', new Uint8Array([1])]],
            {
              progress(results) {
                order.push('progress');
                assertEquals(results, [0]);
                throw sentinel;
              },
            },
            (error, results) => {
              try {
                order.push('final');
                assertEquals(error, null);
                assertEquals(results, [0]);
                const txn = env.beginTxn();
                txn.abort();
                resolve();
              } catch (caught) {
                reject(caught);
              }
            },
          );
        });
        await withDeadline(completed, 10_000, 'final callback after progress');
        assertEquals(
          await withDeadline(reported, 10_000, 'reported progress exception'),
          sentinel,
        );
        assertEquals(order, ['progress', 'final', 'error']);
      },
      [
        () => {
          if (listener !== undefined) removeEventListener('error', listener);
        },
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('final callback errors surface after calling-thread state release', async () => {
  const { Env } = await loadSubject();
  await withTempDir(async (path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    const sentinel = new Error('batch final sentinel');
    let listener: ((event: ErrorEvent) => void) | undefined;
    await withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        const reported = new Promise<unknown>((resolve) => {
          listener = (event) => {
            if (event.error !== sentinel) return;
            event.preventDefault();
            const txn = env.beginTxn();
            txn.abort();
            resolve(event.error);
          };
          addEventListener('error', listener);
        });
        env.batchWrite([[dbi, 'key', new Uint8Array([1])]], () => {
          throw sentinel;
        });
        assertEquals(
          await withDeadline(reported, 10_000, 'reported final exception'),
          sentinel,
        );
      },
      [
        () => {
          if (listener !== undefined) removeEventListener('error', listener);
        },
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('Worker reports a cooperative LMDB write error', async () => {
  const { Env } = await loadSubject();
  await withTempDir(async (path) => {
    const seedEnv = new Env();
    let seedDbi: DbiContract | undefined;
    await withCleanup(
      () => {
        seedEnv.open({ path, maxDbs: 2, useWorker: false });
        seedDbi = seedEnv.openDbi({ name: 'readonly', create: true });
      },
      [() => seedDbi?.close(), () => seedEnv.close()],
    );

    const env = new Env();
    let dbi: DbiContract | undefined;
    await withCleanup(
      async () => {
        env.open({ path, maxDbs: 2, readOnly: true });
        dbi = env.openDbi({ name: 'readonly' });
        const completion = await awaitBatch(submitBatch(env, [
          [dbi, 'key', new Uint8Array([1])],
        ]));
        assert(completion.error instanceof Error);
        assertMatch(completion.error.message, /read.?only|permission|access/i);
        assertEquals(completion.results, undefined);
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('Worker remains reusable after a cooperative batch error', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let seed: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        seed = env.beginTxn();
        seed.putBinary(dbi, 'existing', new Uint8Array([1]));
        seed.commit();
        seed = undefined;

        const failed = await awaitBatch(submitBatch(
          env,
          [[dbi, 'existing', new Uint8Array([2])]],
          { noOverwrite: true },
        ));
        assert(failed.error instanceof Error);
        assertEquals(failed.results, undefined);

        const recovered = await awaitBatch(submitBatch(env, [
          [dbi, 'recovered', new Uint8Array([3])],
        ]));
        assertEquals(recovered, { error: null, results: [0] });
        const read = env.beginTxn({ readOnly: true });
        assertEquals(read.getBinary(dbi, 'recovered'), new Uint8Array([3]));
        read.commit();
      },
      [() => seed?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('default Worker progress shares the final result array', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        const operations: BatchOperationInput[] = Array.from(
          { length: 64 },
          (_, index) => [dbi!, `key-${index}`, new Uint8Array([index])],
        );
        let progressResults: BatchResult[] | undefined;
        let completedPrefix = 0;
        const completion = await awaitBatch(submitBatch(
          env,
          operations,
          {
            progress(results) {
              progressResults ??= results;
              assertEquals(results === progressResults, true);
              assertEquals(results.length, operations.length);
              let prefix = 0;
              while (prefix < results.length && prefix in results) prefix++;
              assert(prefix > completedPrefix);
              for (let index = prefix; index < results.length; index++) {
                assertEquals(index in results, false);
              }
              completedPrefix = prefix;
            },
          },
        ));
        assertEquals(completion.error, null);
        assertEquals(progressResults !== undefined, true);
        assertEquals(completion.results === progressResults, true);
        assertEquals(completedPrefix, operations.length);
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('Worker result bookkeeping ignores progress-array mutations', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        const operations: BatchOperationInput[] = Array.from(
          { length: 8 },
          (_, index) => [dbi!, `mutated-${index}`, new Uint8Array([index])],
        );
        let identity: BatchResult[] | undefined;
        let progressCalls = 0;
        let completionCalls = 0;
        const completion = await awaitBatch(
          new Promise<BatchCompletion>((resolve) => {
            env.batchWrite(
              operations,
              {
                progress(results) {
                  progressCalls++;
                  identity ??= results;
                  assertEquals(results === identity, true);
                  if (progressCalls !== 1) return;
                  results[operations.length - 1] = 99 as BatchResult;
                  delete results[0];
                  results.length = 2;
                  results.push(77 as BatchResult);
                },
              },
              (error, results) => {
                completionCalls++;
                resolve({ error, results });
              },
            );
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEquals(completionCalls, 1);
        assertEquals(completion.error, null);
        assertEquals(completion.results === identity, true);
        assertEquals(progressCalls, operations.length);
        assertEquals(completion.results?.[operations.length - 1], 0);

        read = env.beginTxn({ readOnly: true });
        for (let index = 0; index < operations.length; index++) {
          assertEquals(
            read.getBinary(dbi, `mutated-${index}`),
            new Uint8Array([index]),
          );
        }
        read.commit();
        read = undefined;

        const recovered = await awaitBatch(submitBatch(env, [
          [dbi, 'after-mutation', new Uint8Array([9])],
        ]));
        assertEquals(recovered, { error: null, results: [0] });
      },
      [() => read?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('invalid or missing Worker deltas poison isolated environments', async () => {
  await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir(async (root) => {
    const fixturePath = new URL(
      './fixtures/worker_delta_fault.ts',
      import.meta.url,
    ).pathname;
    const projectPath = new URL('../', import.meta.url).pathname;
    const children: ReturnType<typeof trackChild>[] = [];
    await withCleanup(
      async () => {
        for (
          const fault of ['duplicate', 'out-of-range', 'missing'] as const
        ) {
          const path = `${root}/${fault}`;
          Deno.mkdirSync(path);
          const record = trackChild(new Deno.Command(Deno.execPath(), {
            args: [
              'run',
              '--allow-env=LMDB_LIB_PATH',
              '--allow-ffi',
              `--allow-read=${projectPath},${path}`,
              `--allow-write=${path}`,
              fixturePath,
              path,
              fault,
            ],
            env: { LMDB_LIB_PATH: libraryPath },
            stdout: 'piped',
            stderr: 'piped',
          }).spawn());
          children.push(record);
          const output = await withDeadline(
            record.output,
            15_000,
            `${fault} Worker delta fault subprocess`,
          );
          const stderr = new TextDecoder().decode(output.stderr);
          assertEquals(output.code, 0, stderr);
          assertEquals(
            new TextDecoder().decode(output.stdout),
            `${fault}-delta-fault-ok\n`,
          );
          assertEquals(stderr, '');
        }
      },
      [
        () =>
          terminateChildren(
            children,
            1_000,
            'Worker delta fault subprocess shutdown',
          ),
      ],
    );
  });
});

Deno.test('close throws while a Worker batch is pending', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        const completion = submitBatch(
          env,
          Array.from(
            { length: 256 },
            (_, index) => [dbi!, `worker-${index}`, new Uint8Array([index])],
          ),
        );
        assertThrows(() => env.close(), /batch|pending|active|queued/i);
        const result = await awaitBatch(completion, 'Worker batch callback');
        assertEquals(result.error, null);
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('close succeeds from the final Worker batch callback', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let closed = false;
    return withCleanup(
      async () => {
        env.open({ path });
        dbi = env.openDbi({ name: null, create: true });
        await withDeadline(
          new Promise<void>((resolve, reject) => {
            env.batchWrite([[dbi!, 'key', new Uint8Array([1])]], (error) => {
              try {
                assertEquals(error, null);
                dbi!.close();
                dbi = undefined;
                env.close();
                closed = true;
                resolve();
              } catch (caught) {
                reject(caught);
              }
            });
          }),
          10_000,
          'close in Worker callback',
        );
        assertEquals(closed, true);
      },
      [() => dbi?.close(), () => closed ? undefined : env.close()],
    );
  });
});

Deno.test('hard Worker death poisons only its isolated subprocess environment', async () => {
  await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir((path) => {
    const fixturePath = new URL(
      './fixtures/hard_worker_failure.ts',
      import.meta.url,
    ).pathname;
    const record = trackChild(new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-env=LMDB_LIB_PATH',
        '--allow-ffi',
        `--allow-read=${new URL('../', import.meta.url).pathname},${path}`,
        `--allow-write=${path}`,
        fixturePath,
        path,
      ],
      env: { LMDB_LIB_PATH: libraryPath },
      stdout: 'piped',
      stderr: 'piped',
    }).spawn());

    return withCleanup(
      async () => {
        const output = await withDeadline(
          record.output,
          15_000,
          'hard Worker failure subprocess',
        );
        const stderr = new TextDecoder().decode(output.stderr);
        assertEquals(output.code, 0, stderr);
        assertEquals(
          new TextDecoder().decode(output.stdout),
          'hard-worker-failure-ok\n',
        );
        assertMatch(
          stderr,
          /Uncaught \(in worker.*HardWorkerFailureSignal.*mdb_txn_begin/s,
        );
      },
      [
        () =>
          terminateChildren(
            [record],
            1_000,
            'hard Worker failure subprocess shutdown',
          ),
      ],
    );
  });
});
