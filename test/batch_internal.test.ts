import {
  deepStrictEqual as assertEquals,
  throws as assertThrows,
} from 'node:assert/strict';
import {
  executeBatch,
  prepareBatch,
  releasePreparedBatch,
} from '../src/batch/executor.ts';
import type { NormalizedBatchRequest } from '../src/batch/protocol.ts';
import { Env } from '../src/env.ts';
import { getNativeBindingCounts } from '../src/internal/native_test_access.ts';
import type { NativeApi } from '../src/native/api.ts';
import { LmdbError } from '../src/native/errors.ts';
import { BatchResult } from '../src/types.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';

const pointer = (address: bigint): Deno.PointerObject => {
  const value = Deno.UnsafePointer.create(address);
  if (value === null) throw new Error('Expected a non-null test pointer');
  return value;
};

Deno.test('normalization is cloneable and detached from every caller array', async () => {
  await withTempDir((path) => {
    const env = new Env();
    let dbi: ReturnType<Env['openDbi']> | undefined;
    let prepared: ReturnType<typeof prepareBatch> | undefined;
    return withCleanup(
      () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true, keyIsBuffer: true });
        const key = new Uint8Array([1]);
        const value = new Uint8Array([2]);
        const conditionKey = new Uint8Array([3]);
        const conditionValue = new Uint8Array([4]);
        prepared = prepareBatch(env, [{
          db: dbi,
          key,
          value,
          ifKey: conditionKey,
          ifValue: conditionValue,
        }], { keyIsBuffer: true });

        const cloned = structuredClone(prepared.request);
        key[0] = 9;
        value[0] = 9;
        conditionKey[0] = 9;
        conditionValue[0] = 9;
        assertEquals(cloned.operations[0], {
          dbi: cloned.operations[0].dbi,
          key: new Uint8Array([1]),
          value: new Uint8Array([2]),
          condition: {
            dbi: cloned.operations[0].dbi,
            key: new Uint8Array([3]),
            value: new Uint8Array([4]),
            exact: false,
          },
        });
        const observed: Uint8Array[] = [];
        const transaction = pointer(2n);
        const api = {
          txnBegin: () => transaction,
          get(
            _txn: Deno.PointerObject,
            _dbi: number,
            condition: Uint8Array,
          ) {
            observed.push(new Uint8Array(condition));
            return new Uint8Array([4]);
          },
          put(
            _txn: Deno.PointerObject,
            _dbi: number,
            normalizedKey: Uint8Array,
            normalizedValue: Uint8Array,
          ) {
            observed.push(
              new Uint8Array(normalizedKey),
              new Uint8Array(normalizedValue),
            );
          },
          txnCommit() {},
          txnAbort() {},
        } as unknown as NativeApi;
        const results = new Array<BatchResult>(1);
        executeBatch(pointer(1n), cloned, results, api);
        assertEquals(observed, [
          new Uint8Array([3]),
          new Uint8Array([1]),
          new Uint8Array([2]),
        ]);
        assertEquals(results, [BatchResult.SUCCESS]);
      },
      [
        () => prepared && releasePreparedBatch(prepared),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('normalization retains one shared record for aliased DBI wrappers', async () => {
  await withTempDir((path) => {
    const env = new Env();
    let first: ReturnType<Env['openDbi']> | undefined;
    let second: ReturnType<Env['openDbi']> | undefined;
    let prepared: ReturnType<typeof prepareBatch> | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 2, useWorker: false });
        first = env.openDbi({ name: 'shared', create: true });
        second = env.openDbi({ name: 'shared', keyIsBuffer: true });
        prepared = prepareBatch(env, [
          [first, 'one', new Uint8Array([1])],
          [second, 'two', new Uint8Array([2])],
        ], {});
        assertEquals(prepared.leases.length, 1);
        assertEquals(prepared.owners.length, 2);
        assertEquals(prepared.request.operations[0].key.byteLength > 3, true);
        assertEquals(prepared.request.operations[1].key.byteLength > 3, true);
        const counts = getNativeBindingCounts(env) as unknown as {
          batchDbiLeases: number;
        };
        assertEquals(counts.batchDbiLeases, 1);
        releasePreparedBatch(prepared);
        prepared = undefined;
        const released = getNativeBindingCounts(env) as unknown as {
          batchDbiLeases: number;
        };
        assertEquals(released.batchDbiLeases, 0);
      },
      [
        () => prepared && releasePreparedBatch(prepared),
        () => second?.close(),
        () => first?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('environment close rejects while a normalized DBI lease is retained', async () => {
  await withTempDir((path) => {
    const env = new Env();
    let dbi: ReturnType<Env['openDbi']> | undefined;
    let prepared: ReturnType<typeof prepareBatch> | undefined;
    return withCleanup(
      () => {
        env.open({ path, useWorker: false });
        dbi = env.openDbi({ name: null, create: true });
        prepared = prepareBatch(
          env,
          [[dbi, 'key', new Uint8Array([1])]],
          {},
        );
        assertThrows(() => env.close(), /batch|retained|active|pending/i);
        releasePreparedBatch(prepared);
        prepared = undefined;
      },
      [
        () => prepared && releasePreparedBatch(prepared),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('prepared batch release is aggregate-idempotent after native close', async () => {
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');
  await withTempDir((path) => {
    const fixture = new URL(
      './fixtures/batch_release_idempotent.ts',
      import.meta.url,
    ).pathname;
    const project = new URL('../', import.meta.url).pathname;
    const record = trackChild(new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-env=LMDB_LIB_PATH',
        '--allow-ffi',
        `--allow-read=${project},${path}`,
        `--allow-write=${path}`,
        fixture,
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
          10_000,
          'idempotent batch release subprocess',
        );
        const stderr = new TextDecoder().decode(output.stderr);
        assertEquals(output.code, 0, stderr);
        assertEquals(
          new TextDecoder().decode(output.stdout),
          'batch-release-idempotent-ok\n',
        );
        assertEquals(stderr, '');
      },
      [
        () =>
          terminateChildren(
            [record],
            1_000,
            'idempotent batch release subprocess shutdown',
          ),
      ],
    );
  });
});

Deno.test('executor uses one transaction and preserves exact operation order', () => {
  const events: string[] = [];
  const txn = pointer(2n);
  const api = {
    txnBegin() {
      events.push('begin');
      return txn;
    },
    get() {
      events.push('get');
      return new Uint8Array([7, 8]);
    },
    put(_txn: Deno.PointerObject, _dbi: number, key: Uint8Array) {
      events.push(`put:${key[0]}`);
      if (key[0] === 3) throw new LmdbError(-30781, 'bad size');
    },
    del(_txn: Deno.PointerObject, _dbi: number, key: Uint8Array) {
      events.push(`del:${key[0]}`);
      if (key[0] === 2) throw new LmdbError(-30798, 'missing');
    },
    txnCommit() {
      events.push('commit');
    },
    txnAbort() {
      events.push('abort');
    },
  } as unknown as NativeApi;
  const request: NormalizedBatchRequest = {
    putFlags: 0x20,
    operations: [
      {
        dbi: 1,
        key: new Uint8Array([1]),
        value: new Uint8Array([9]),
        condition: {
          dbi: 1,
          key: new Uint8Array([8]),
          value: new Uint8Array([7]),
          exact: false,
        },
      },
      { dbi: 1, key: new Uint8Array([2]), value: null },
      { dbi: 1, key: new Uint8Array([3]), value: new Uint8Array([9]) },
      { dbi: 1, key: new Uint8Array([4]), value: null },
    ],
  };
  const results = new Array<BatchResult>(request.operations.length);
  executeBatch(pointer(1n), request, results, api);
  assertEquals(events, [
    'begin',
    'get',
    'put:1',
    'del:2',
    'put:3',
    'del:4',
    'commit',
  ]);
  assertEquals(results, [0, 2, 3, 0]);
});

Deno.test('executor aborts true errors and treats commit failure as terminal', () => {
  const request: NormalizedBatchRequest = {
    putFlags: 0,
    operations: [{
      dbi: 1,
      key: new Uint8Array([1]),
      value: new Uint8Array([2]),
    }],
  };
  const transaction = pointer(2n);
  const executionEvents: string[] = [];
  const executionErrorApi = {
    txnBegin() {
      executionEvents.push('begin');
      return transaction;
    },
    put() {
      executionEvents.push('put');
      throw new LmdbError(-30799, 'exists');
    },
    txnAbort() {
      executionEvents.push('abort');
    },
  } as unknown as NativeApi;
  const executionResults = new Array<BatchResult>(request.operations.length);
  assertThrows(
    () =>
      executeBatch(pointer(1n), request, executionResults, executionErrorApi),
    (error) => error instanceof LmdbError && error.code === -30799,
  );
  assertEquals(executionEvents, ['begin', 'put', 'abort']);
  assertEquals(executionResults.length, 1);
  assertEquals(0 in executionResults, false);

  const commitEvents: string[] = [];
  const commitErrorApi = {
    txnBegin() {
      commitEvents.push('begin');
      return transaction;
    },
    put() {
      commitEvents.push('put');
    },
    txnCommit() {
      commitEvents.push('commit');
      throw new LmdbError(5, 'commit failed');
    },
    txnAbort() {
      commitEvents.push('abort');
    },
  } as unknown as NativeApi;
  const commitResults = new Array<BatchResult>(request.operations.length);
  assertThrows(
    () => executeBatch(pointer(1n), request, commitResults, commitErrorApi),
    (error) => error instanceof LmdbError && error.code === 5,
  );
  assertEquals(commitEvents, ['begin', 'put', 'commit']);
  assertEquals(commitResults, [BatchResult.SUCCESS]);
});
