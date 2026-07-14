import { assertEquals, assertThrows } from './_support/assertions.ts';
import type {
  BatchOperationInput,
  BatchResult,
  DbiContract,
  EnvContract,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const EXPECTED_RESULTS = [1, 0, 0, 0, 2, 1, 0, 0] as BatchResult[];

Deno.test('binary batch writes preserve conditions and progress', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let readTxn: TxnContract | undefined;
    let callbackCount = 0;
    let progressIdentity: BatchResult[] | undefined;
    let progressError: unknown;
    let completedProgress = 0;

    return withCleanup(
      async () => {
        env.open({
          path,
          maxDbs: 10,
          maxReaders: 422,
          mapSize: 256 * 1024 * 1024,
          useWorker: false,
        });
        dbi = env.openDbi({ name: 'mydb8', create: true });
        const operations: BatchOperationInput[] = [
          [
            dbi,
            new Uint8Array([47]),
            new Uint8Array([1, 2]),
            new Uint8Array([5, 2]),
          ],
          [dbi, new Uint8Array([4]), new Uint8Array([1, 2])],
          [dbi, new Uint8Array([5]), new Uint8Array([3, 4])],
          [dbi, new Uint8Array([6]), new Uint8Array([5, 6])],
          [dbi, new Uint8Array([7])],
          [
            dbi,
            new Uint8Array([6]),
            new Uint8Array([7, 8]),
            new Uint8Array([1, 1]),
          ],
          [
            dbi,
            new Uint8Array([6]),
            new Uint8Array([7, 8]),
            new Uint8Array([5]),
          ],
          {
            db: dbi,
            key: new Uint8Array([5]),
            value: new Uint8Array([8, 9]),
            ifValue: new Uint8Array([7]),
            ifKey: new Uint8Array([6]),
            ifExactMatch: false,
          },
        ];

        const completed = new Promise<void>((resolve, reject) => {
          env.batchWrite(
            operations,
            {
              keyIsBuffer: true,
              progress(results) {
                try {
                  if (progressIdentity === undefined) {
                    progressIdentity = results;
                  } else {
                    assertEquals(results === progressIdentity, true);
                  }
                  assertEquals(results.length, operations.length);

                  let completed = 0;
                  while (
                    completed < results.length && completed in results
                  ) {
                    completed++;
                  }
                  assertEquals(completed >= completedProgress, true);
                  assertEquals(
                    results.slice(0, completed),
                    EXPECTED_RESULTS.slice(0, completed),
                  );
                  for (let index = completed; index < results.length; index++) {
                    assertEquals(index in results, false);
                  }
                  completedProgress = completed;
                } catch (error) {
                  progressError ??= error;
                }
              },
            },
            (error, results) => {
              callbackCount++;
              try {
                assertEquals(error, null);
                assertEquals(results, EXPECTED_RESULTS);
                if (progressIdentity !== undefined) {
                  assertEquals(results === progressIdentity, true);
                }
                if (progressError !== undefined) throw progressError;
                resolve();
              } catch (assertionError) {
                reject(assertionError);
              }
            },
          );
        });
        await withDeadline(completed, 10_000, 'binary batch callback');
        assertEquals(callbackCount, 1);

        readTxn = env.beginTxn();
        const expectedData: [Uint8Array, Uint8Array?][] = [
          [new Uint8Array([4]), new Uint8Array([1, 2])],
          [new Uint8Array([5]), new Uint8Array([8, 9])],
          [new Uint8Array([7])],
          [new Uint8Array([6]), new Uint8Array([7, 8])],
        ];
        for (const [key, expectedValue] of expectedData) {
          assertEquals(readTxn.getBinary(dbi, key), expectedValue ?? null);
        }
        readTxn.commit();
        readTxn = undefined;
      },
      [
        () => readTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('string-key batch writes can be read back', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let readTxn: TxnContract | undefined;
    let callbackCount = 0;

    return withCleanup(
      async () => {
        env.open({
          path,
          maxDbs: 10,
          maxReaders: 422,
          mapSize: 256 * 1024 * 1024,
          useWorker: false,
        });
        dbi = env.openDbi({ name: 'mydb8', create: true });
        const operations: BatchOperationInput[] = [
          [dbi, 'key 1', new Uint8Array([1, 2])],
          [dbi, 'key 2', new Uint8Array([3, 4])],
          [dbi, 'key 3', new Uint8Array([5, 6])],
        ];

        const completed = new Promise<void>((resolve, reject) => {
          env.batchWrite(operations, (error, results) => {
            callbackCount++;
            try {
              assertEquals(error, null);
              assertEquals(results, [0, 0, 0]);
              resolve();
            } catch (assertionError) {
              reject(assertionError);
            }
          });
        });
        await withDeadline(completed, 10_000, 'string batch callback');
        assertEquals(callbackCount, 1);

        readTxn = env.beginTxn();
        for (const operation of operations) {
          if (!Array.isArray(operation)) continue;
          const [, key, expectedValue] = operation;
          assertEquals(
            readTxn.getBinary(dbi, key),
            expectedValue instanceof Uint8Array ? expectedValue : null,
          );
        }
        readTxn.commit();
        readTxn = undefined;
      },
      [
        () => readTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('object conditions support exact matches, missing values, ifKey, and ifDB', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let data: DbiContract | undefined;
    let conditions: DbiContract | undefined;
    let seed: TxnContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, maxDbs: 3, useWorker: false });
        data = env.openDbi({ name: 'data', create: true });
        conditions = env.openDbi({ name: 'conditions', create: true });
        seed = env.beginTxn();
        seed.putBinary(
          conditions,
          'guard',
          new Uint8Array([1, 2, 3]),
        );
        seed.commit();
        seed = undefined;

        const completion = new Promise<{
          error: Error | null;
          results?: BatchResult[];
        }>((resolve) => {
          env.batchWrite(
            [
              {
                db: data!,
                key: 'prefix',
                value: new Uint8Array([4]),
                ifDB: conditions!,
                ifKey: 'guard',
                ifValue: new Uint8Array([1, 2]),
              },
              {
                db: data!,
                key: 'exact-fails',
                value: new Uint8Array([5]),
                ifDB: conditions!,
                ifKey: 'guard',
                ifValue: new Uint8Array([1, 2]),
                ifExactMatch: true,
              },
              {
                db: data!,
                key: 'missing',
                value: new Uint8Array([6]),
                ifValue: null,
              },
            ],
            (error, results) => resolve({ error, results }),
          );
        });

        const result = await withDeadline(
          completion,
          10_000,
          'object condition batch callback',
        );
        assertEquals(result.error, null);
        assertEquals(result.results, [0, 1, 0]);

        read = env.beginTxn({ readOnly: true });
        assertEquals(read.getBinary(data, 'prefix'), new Uint8Array([4]));
        assertEquals(read.getBinary(data, 'exact-fails'), null);
        assertEquals(read.getBinary(data, 'missing'), new Uint8Array([6]));
        read.commit();
        read = undefined;
      },
      [
        () => read?.abort(),
        () => seed?.abort(),
        () => conditions?.close(),
        () => data?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('put flags abort the complete batch on an execution error', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let seed: TxnContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        seed = env.beginTxn();
        seed.putBinary(dbi, 'existing', new Uint8Array([1]));
        seed.commit();
        seed = undefined;

        const completion = new Promise<{
          error: Error | null;
          results?: BatchResult[];
        }>((resolve) => {
          env.batchWrite(
            [
              [dbi!, 'must-rollback', new Uint8Array([2])],
              [dbi!, 'existing', new Uint8Array([3])],
            ],
            { noOverwrite: true },
            (error, results) => resolve({ error, results }),
          );
        });
        const result = await withDeadline(
          completion,
          10_000,
          'failed atomic batch callback',
        );
        assertEquals(result.error instanceof Error, true);
        assertEquals(result.results, undefined);

        read = env.beginTxn({ readOnly: true });
        assertEquals(read.getBinary(dbi, 'must-rollback'), null);
        assertEquals(read.getBinary(dbi, 'existing'), new Uint8Array([1]));
        read.commit();
        read = undefined;
      },
      [
        () => read?.abort(),
        () => seed?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('normalization copies binary inputs before returning', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true, keyIsBuffer: true });
        const key = new Uint8Array([1]);
        const value = new Uint8Array([2]);
        const completion = new Promise<{
          error: Error | null;
          results?: BatchResult[];
        }>((resolve) => {
          env.batchWrite(
            [[dbi!, key, value]],
            { keyIsBuffer: true },
            (error, results) => resolve({ error, results }),
          );
        });
        key[0] = 7;
        value[0] = 8;

        const result = await withDeadline(
          completion,
          10_000,
          'copied batch input callback',
        );
        assertEquals(result, { error: null, results: [0] });
        read = env.beginTxn({ readOnly: true });
        assertEquals(
          read.getBinary(dbi, new Uint8Array([1])),
          new Uint8Array([2]),
        );
        read.commit();
        read = undefined;
      },
      [() => read?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('bad value sizes are per-operation results and do not abort valid writes', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true, keyIsBuffer: true });
        const completion = new Promise<{
          error: Error | null;
          results?: BatchResult[];
        }>((resolve) => {
          env.batchWrite(
            [
              [dbi!, new Uint8Array(), new Uint8Array([1])],
              {
                db: dbi!,
                key: new Uint8Array([4]),
                value: new Uint8Array([5]),
                ifKey: new Uint8Array(),
                ifValue: null,
              },
              [dbi!, new Uint8Array([2]), new Uint8Array([3])],
            ],
            { keyIsBuffer: true },
            (error, results) => resolve({ error, results }),
          );
        });
        const result = await withDeadline(
          completion,
          10_000,
          'bad value size batch callback',
        );
        assertEquals(result, { error: null, results: [3, 3, 0] });
        read = env.beginTxn({ readOnly: true });
        assertEquals(
          read.getBinary(dbi, new Uint8Array([2])),
          new Uint8Array([3]),
        );
        read.commit();
        read = undefined;
      },
      [() => read?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('batch validation rejects closed, cross-environment, and active-writer DBIs', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (root) => {
    const first = new Env();
    const second = new Env();
    let firstDbi: DbiContract | undefined;
    let closedDbi: DbiContract | undefined;
    let secondDbi: DbiContract | undefined;
    let writer: TxnContract | undefined;
    await withCleanup(
      () => {
        Deno.mkdirSync(`${root}/first`);
        Deno.mkdirSync(`${root}/second`);
        first.open({ path: `${root}/first`, useWorker: false });
        second.open({ path: `${root}/second`, useWorker: false });
        firstDbi = first.openDbi({ name: null, create: true });
        closedDbi = first.openDbi({ name: null });
        secondDbi = second.openDbi({ name: null, create: true });
        closedDbi.close();

        assertThrows(
          () =>
            first.batchWrite(
              [[closedDbi!, 'key', new Uint8Array([1])]],
              () => {},
            ),
          /closed/i,
        );
        assertThrows(
          () =>
            first.batchWrite(
              [[secondDbi!, 'key', new Uint8Array([1])]],
              () => {},
            ),
          /different environment/i,
        );

        writer = first.beginTxn();
        assertThrows(
          () =>
            first.batchWrite(
              [[firstDbi!, 'key', new Uint8Array([1])]],
              () => {},
            ),
          /write transaction|second one/i,
        );
        writer.abort();
        writer = undefined;
      },
      [
        () => writer?.abort(),
        () => secondDbi?.close(),
        () => firstDbi?.close(),
        () => second.close(),
        () => first.close(),
      ],
    );
  });
});

Deno.test('batch runtime rejects primitive values but preserves zero and empty Uint8Arrays', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true, keyIsUint32: true });
        for (const value of ['', 0, false, true]) {
          assertThrows(
            () =>
              env.batchWrite(
                [{ db: dbi!, key: 1, value }],
                { keyIsUint32: true },
                () => {},
              ),
            /value.*Uint8Array.*null.*undefined/i,
          );
          assertThrows(
            () =>
              env.batchWrite(
                [{
                  db: dbi!,
                  key: 1,
                  value: new Uint8Array([1]),
                  ifValue: value,
                }],
                { keyIsUint32: true },
                () => {},
              ),
            /ifValue.*Uint8Array.*null.*undefined/i,
          );
        }
        const completed = new Promise<BatchResult[] | undefined>((resolve) => {
          env.batchWrite(
            [
              { db: dbi!, key: 0, value: new Uint8Array() },
              { db: dbi!, key: 1, value: new Uint8Array([0]) },
            ],
            { keyIsUint32: true },
            (error, results) => {
              if (error) throw error;
              resolve(results);
            },
          );
        });
        assertEquals(
          await withDeadline(completed, 10_000, 'binary value batch callback'),
          [0, 0],
        );
        read = env.beginTxn({ readOnly: true });
        assertEquals(read.getBinary(dbi, 0), new Uint8Array());
        assertEquals(read.getBinary(dbi, 1), new Uint8Array([0]));
        read.commit();
        read = undefined;
      },
      [() => read?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('batch infers one key type from the first operation and applies it to ifKey', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        assertThrows(
          () =>
            env.batchWrite([
              [dbi!, 'first', new Uint8Array([1])],
              [dbi!, new Uint8Array([2]), new Uint8Array([2])],
            ], () => {}),
          /key.*string/i,
        );
        assertThrows(
          () =>
            env.batchWrite(
              [
                [dbi!, new Uint8Array([1]), new Uint8Array([1])],
                [dbi!, 'second', new Uint8Array([2])],
              ],
              { keyIsBuffer: true },
              () => {},
            ),
          /key.*Uint8Array|binary key/i,
        );
        assertThrows(
          () =>
            env.batchWrite([{
              db: dbi!,
              key: 'first',
              value: new Uint8Array([1]),
              ifKey: new Uint8Array([2]),
              ifValue: null,
            }], () => {}),
          /key.*string/i,
        );
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('batch snapshots hostile getters before retaining native state', async () => {
  const { Env } = await loadSubject();
  const { getNativeBindingCounts } = await import(
    '../src/internal/native_test_access.ts'
  );
  await withTempDir(async (root) => {
    const leaseCounts: number[] = [];
    for (
      const [name, makeArguments] of [
        [
          'option',
          (env: EnvContract, dbi: DbiContract) => ({
            operations: [[dbi, 'key', new Uint8Array([1])]],
            options: Object.defineProperty({}, 'noOverwrite', {
              get() {
                leaseCounts.push(
                  getNativeBindingCounts(env as object).batchDbiLeases,
                );
                env.close();
                return true;
              },
            }),
          }),
        ],
        [
          'operation',
          (env: EnvContract, dbi: DbiContract) => ({
            operations: [Object.defineProperties({}, {
              db: {
                get() {
                  leaseCounts.push(
                    getNativeBindingCounts(env as object).batchDbiLeases,
                  );
                  env.close();
                  return dbi;
                },
              },
              key: { value: 'key', enumerable: true },
              value: { value: new Uint8Array([1]), enumerable: true },
            })],
            options: {},
          }),
        ],
      ] as const
    ) {
      const path = `${root}/${name}`;
      Deno.mkdirSync(path);
      const env = new Env();
      env.open({ path, useWorker: false });
      const dbi = env.openDbi({ name: null, create: true });
      let called = false;
      const input = makeArguments(env, dbi);
      assertThrows(
        () =>
          env.batchWrite(
            input.operations as BatchOperationInput[],
            input.options,
            () => called = true,
          ),
        /closed|open/i,
      );
      await Promise.resolve();
      assertEquals(called, false);
    }
    assertEquals(leaseCounts, [0, 0]);
  });
});

Deno.test('object condition getters follow node observation gates before leases', async () => {
  const { Env } = await loadSubject();
  await withTempDir(async (root) => {
    const run = async (
      name: string,
      operation: (env: EnvContract, dbi: DbiContract) => object,
      verify: (
        env: EnvContract,
        invoke: () => Promise<{ error: Error | null; results?: BatchResult[] }>,
      ) => void | Promise<void>,
    ) => {
      const path = `${root}/${name}`;
      Deno.mkdirSync(path);
      const env = new Env();
      let dbi: DbiContract | undefined;
      await withCleanup(
        async () => {
          env.open({ path, useWorker: false });
          dbi = env.openDbi({ name: null, create: true });
          const input = operation(env, dbi);
          await verify(env, () => {
            let finish!: (
              value: { error: Error | null; results?: BatchResult[] },
            ) => void;
            const completion = new Promise<{
              error: Error | null;
              results?: BatchResult[];
            }>((resolve) => finish = resolve);
            env.batchWrite(
              [input as BatchOperationInput],
              (error, results) => finish({ error, results }),
            );
            return completion;
          });
        },
        [
          () => {
            try {
              dbi?.close();
            } catch (error) {
              if (!(error instanceof Error) || !/closed/i.test(error.message)) {
                throw error;
              }
            }
          },
          () => {
            try {
              env.close();
            } catch (error) {
              if (!(error instanceof Error) || !/closed/i.test(error.message)) {
                throw error;
              }
            }
          },
        ],
      );
    };

    await run('undefined', (_env, dbi) =>
      Object.defineProperties({}, {
        db: { value: dbi },
        key: { value: 'key' },
        value: { value: new Uint8Array([1]) },
        ifValue: { value: undefined },
        ifExactMatch: {
          get: () => {
            throw new Error('ignored exact');
          },
        },
        ifDB: {
          get: () => {
            throw new Error('ignored db');
          },
        },
        ifKey: {
          get: () => {
            throw new Error('ignored key');
          },
        },
      }), async (_env, invoke) => {
      assertEquals(await invoke(), { error: null, results: [0] });
    });

    const nullObserved: string[] = [];
    await run('null', (_env, dbi) =>
      Object.defineProperties({}, {
        db: { value: dbi },
        key: { value: 'key' },
        value: { value: new Uint8Array([1]) },
        ifValue: { value: null },
        ifExactMatch: {
          get: () => {
            throw new Error('ignored exact');
          },
        },
        ifDB: {
          get: () => {
            nullObserved.push('ifDB');
            return undefined;
          },
        },
        ifKey: {
          get: () => {
            nullObserved.push('ifKey');
            return undefined;
          },
        },
      }), async (_env, invoke) => {
      assertEquals(await invoke(), { error: null, results: [0] });
      assertEquals(nullObserved, ['ifDB', 'ifKey']);
    });

    const binaryObserved: string[] = [];
    await run('binary', (_env, dbi) =>
      Object.defineProperties({}, {
        db: { value: dbi },
        key: { value: 'key' },
        value: { value: new Uint8Array([1]) },
        ifValue: { value: new Uint8Array([1]) },
        ifExactMatch: {
          get() {
            binaryObserved.push('ifExactMatch');
            return false;
          },
        },
        ifDB: {
          get: () => {
            binaryObserved.push('ifDB');
            return undefined;
          },
        },
        ifKey: {
          get: () => {
            binaryObserved.push('ifKey');
            return undefined;
          },
        },
      }), async (_env, invoke) => {
      assertEquals(await invoke(), { error: null, results: [1] });
      assertEquals(binaryObserved, ['ifExactMatch', 'ifDB', 'ifKey']);
    });

    let invalidConditionalReads = 0;
    await run('invalid', (_env, dbi) =>
      Object.defineProperties({}, {
        db: { value: dbi },
        key: { value: 'key' },
        value: { value: new Uint8Array([1]) },
        ifValue: { value: 1 },
        ifExactMatch: { get: () => invalidConditionalReads++ },
        ifDB: { get: () => invalidConditionalReads++ },
        ifKey: { get: () => invalidConditionalReads++ },
      }), (env, invoke) => {
      assertThrows(() => void invoke(), /ifValue.*Uint8Array/i);
      assertEquals(invalidConditionalReads, 0);
      const txn = env.beginTxn();
      txn.abort();
    });

    await run('null-reentrant', (env, dbi) =>
      Object.defineProperties({}, {
        db: { value: dbi },
        key: { value: 'key' },
        value: { value: new Uint8Array([1]) },
        ifValue: { value: null },
        ifExactMatch: {
          get: () => {
            throw new Error('ignored exact');
          },
        },
        ifDB: { get: () => env.close() },
        ifKey: { value: undefined },
      }), (_env, invoke) => {
      assertThrows(() => void invoke(), /closed|open/i);
    });

    await run('binary-reentrant', (env, dbi) =>
      Object.defineProperties({}, {
        db: { value: dbi },
        key: { value: 'key' },
        value: { value: new Uint8Array([1]) },
        ifValue: { value: new Uint8Array([1]) },
        ifExactMatch: { get: () => env.close() },
        ifDB: { value: undefined },
        ifKey: { value: undefined },
      }), (_env, invoke) => {
      assertThrows(() => void invoke(), /closed|open/i);
    });
  });
});

Deno.test('object puts and deletes and tuple conditional deletes preserve null semantics', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let seed: TxnContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        seed = env.beginTxn();
        seed.putBinary(dbi, 'object-delete', new Uint8Array([1]));
        seed.putBinary(dbi, 'tuple-delete', new Uint8Array([2, 3]));
        seed.putBinary(dbi, 'exists', new Uint8Array([4]));
        seed.commit();
        seed = undefined;

        const completed = new Promise<{
          error: Error | null;
          results?: BatchResult[];
        }>((resolve) => {
          env.batchWrite([
            { db: dbi!, key: 'object-put', value: new Uint8Array([9]) },
            { db: dbi!, key: 'object-delete', value: null },
            [dbi!, 'tuple-delete', null, new Uint8Array([2])],
            {
              db: dbi!,
              key: 'exists',
              value: new Uint8Array([8]),
              ifValue: null,
            },
          ], (error, results) => resolve({ error, results }));
        });
        assertEquals(
          await withDeadline(completed, 10_000, 'delete batch callback'),
          { error: null, results: [0, 0, 0, 1] },
        );
        read = env.beginTxn({ readOnly: true });
        assertEquals(read.getBinary(dbi, 'object-put'), new Uint8Array([9]));
        assertEquals(read.getBinary(dbi, 'object-delete'), null);
        assertEquals(read.getBinary(dbi, 'tuple-delete'), null);
        assertEquals(read.getBinary(dbi, 'exists'), new Uint8Array([4]));
        read.commit();
        read = undefined;
      },
      [
        () => read?.abort(),
        () => seed?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('noDupData, append, and appendDup preserve native atomic errors', async () => {
  const { Env } = await loadSubject();
  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let read: TxnContract | undefined;
    return withCleanup(
      async () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true, dupSort: true });
        const run = (operations: BatchOperationInput[], options: object) =>
          withDeadline(
            new Promise<{ error: Error | null; results?: BatchResult[] }>(
              (resolve) => {
                env.batchWrite(
                  operations,
                  options,
                  (error, results) => resolve({ error, results }),
                );
              },
            ),
            10_000,
            'flagged batch callback',
          );

        const duplicate = await run([
          [dbi, 'duplicate', new Uint8Array([1])],
          [dbi, 'duplicate', new Uint8Array([1])],
        ], { noDupData: true });
        assertEquals(duplicate.error instanceof Error, true);
        assertEquals(duplicate.results, undefined);

        const append = await run([
          [dbi, 'z', new Uint8Array([1])],
          [dbi, 'a', new Uint8Array([2])],
        ], { append: true });
        assertEquals(append.error instanceof Error, true);

        const appendDuplicate = await run([
          [dbi, 'same', new Uint8Array([2])],
          [dbi, 'same', new Uint8Array([1])],
        ], { appendDup: true });
        assertEquals(appendDuplicate.error instanceof Error, true);

        read = env.beginTxn({ readOnly: true });
        for (const key of ['duplicate', 'z', 'a', 'same']) {
          assertEquals(read.getBinary(dbi, key), null);
        }
        read.commit();
        read = undefined;
      },
      [() => read?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('batch rejects invalid condition DBIs, pending DBIs, and poisoned state', async () => {
  const { Env } = await loadSubject();
  const { poisonNativeEnvironment } = await import(
    '../src/internal/native_test_access.ts'
  );
  await withTempDir(async (root) => {
    Deno.mkdirSync(`${root}/first`);
    Deno.mkdirSync(`${root}/second`);
    const first = new Env();
    const second = new Env();
    let target: DbiContract | undefined;
    let closedCondition: DbiContract | undefined;
    let other: DbiContract | undefined;
    let pending: DbiContract | undefined;
    let opening: TxnContract | undefined;
    await withCleanup(
      () => {
        first.open({ path: `${root}/first`, maxDbs: 3, useWorker: false });
        second.open({ path: `${root}/second`, useWorker: false });
        target = first.openDbi({ name: 'target', create: true });
        closedCondition = first.openDbi({ name: 'target' });
        other = second.openDbi({ name: null, create: true });
        closedCondition.close();
        assertThrows(() =>
          first.batchWrite([{
            db: target!,
            key: 'key',
            value: new Uint8Array([1]),
            ifDB: closedCondition!,
            ifValue: null,
          }], () => {}), /closed/i);
        assertThrows(() =>
          first.batchWrite([{
            db: target!,
            key: 'key',
            value: new Uint8Array([1]),
            ifDB: other!,
            ifValue: null,
          }], () => {}), /different environment/i);

        opening = first.beginTxn();
        pending = first.openDbi({
          name: 'pending',
          create: true,
          txn: opening,
        });
        assertThrows(
          () =>
            first.batchWrite(
              [[pending!, 'key', new Uint8Array([1])]],
              () => {},
            ),
          /pending/i,
        );
        opening.abort();
        opening = undefined;

        poisonNativeEnvironment(first as object);
        assertThrows(
          () =>
            first.batchWrite(
              [[target!, 'key', new Uint8Array([1])]],
              () => {},
            ),
          /poison/i,
        );
      },
      [
        () => opening?.abort(),
        () => other?.close(),
        () => second.close(),
        () => first.close(),
      ],
    );
  });
});
