import { assertEquals } from './_support/assertions.ts';
import { bytes, hex } from './_support/bytes.ts';
import type {
  DbiContract,
  EnvContract,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import {
  type ChildRecord,
  terminateChildren,
  trackChild,
} from './_support/process.ts';
import { loadSubject } from './_support/subject.ts';

const MAX_DB_SIZE = 256 * 1024 * 1024;
const DEADLINE_MS = 10_000;
const READER_COUNT = Math.min(
  Math.max(globalThis.navigator.hardwareConcurrency, 1) * 2,
  20,
);
const VALUE = bytes('48656c6c6f2c20776f726c6421');

interface WorkerEnvironmentDescriptor {
  libraryPath: string;
  envAddress: bigint;
  generation: number;
  capability: 'read' | 'batch';
}

interface WorkerReply {
  ok: boolean;
  hex?: string;
  error?: string;
  cleanupComplete?: boolean;
}

interface EnvironmentProtocol {
  getEnvironmentDescriptor(
    env: EnvContract,
    capability: 'read' | 'batch',
  ): WorkerEnvironmentDescriptor;
  validateEnvironmentDescriptor(
    descriptor: WorkerEnvironmentDescriptor,
    capability: 'read' | 'batch',
  ): void;
  getIssuedDescriptorCountForTest(): number;
  getLiveGenerationCountForTest(): number;
}

function spawnReader(
  libraryPath: string,
  path: string,
  dbName: string,
  key: string,
): ChildRecord {
  const fixturePath = new URL('./fixtures/process_reader.ts', import.meta.url)
    .pathname;
  const projectPath = new URL('../', import.meta.url).pathname;
  return trackChild(new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env=LMDB_LIB_PATH',
      '--allow-ffi',
      `--allow-read=${projectPath},${path}`,
      `--allow-write=${path}`,
      fixturePath,
      path,
      dbName,
      key,
      hex(VALUE),
    ],
    env: { LMDB_LIB_PATH: libraryPath },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn());
}

function readFromWorker(
  worker: Worker,
  request: {
    descriptor: WorkerEnvironmentDescriptor;
    dbName: string;
    key: string;
    expectedHex: string;
  },
): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new Error(event.message));
    };
    worker.postMessage(request);
  });
}

function expectDescriptorRejected(
  protocol: EnvironmentProtocol,
  descriptor: WorkerEnvironmentDescriptor,
  capability: 'read' | 'batch',
): void {
  let validationError: unknown;
  try {
    protocol.validateEnvironmentDescriptor(descriptor, capability);
  } catch (error) {
    validationError = error;
  }
  if (!(validationError instanceof Error)) {
    throw new Error('Expected environment descriptor validation to fail');
  }
}

function spawnForeignDescriptorValidator(
  descriptor: WorkerEnvironmentDescriptor,
  projectPath: string,
): ChildRecord {
  const fixturePath = new URL(
    './fixtures/descriptor_validate_probe.ts',
    import.meta.url,
  ).pathname;
  return trackChild(new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env=LMDB_LIB_PATH',
      '--allow-ffi',
      `--allow-read=${projectPath}`,
      fixturePath,
      descriptor.libraryPath,
      descriptor.envAddress.toString(),
      descriptor.generation.toString(),
      descriptor.capability,
    ],
    env: { LMDB_LIB_PATH: descriptor.libraryPath },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn());
}

Deno.test('process readers observe committed binary values', async () => {
  const { Env } = await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let setupTxn: TxnContract | undefined;
    const children: ChildRecord[] = [];

    return withCleanup(
      async () => {
        env.open({
          path,
          maxDbs: 10,
          mapSize: MAX_DB_SIZE,
          maxReaders: 126,
        });
        dbi = env.openDbi({ name: 'cluster', create: true });
        setupTxn = env.beginTxn();
        for (let index = 0; index < READER_COUNT; index++) {
          setupTxn.putBinary(dbi, `key${index}`, VALUE);
        }
        setupTxn.commit();
        setupTxn = undefined;

        for (let index = 0; index < READER_COUNT; index++) {
          children.push(
            spawnReader(libraryPath, path, 'cluster', `key${index}`),
          );
        }
        const outputs = await withDeadline(
          Promise.all(children.map((record) => record.output)),
          DEADLINE_MS,
          'process readers',
        );
        assertEquals(outputs.length, READER_COUNT);
        for (const output of outputs) {
          assertEquals(output.code, 0);
          assertEquals(new TextDecoder().decode(output.stderr), '');
          assertEquals(
            new TextDecoder().decode(output.stdout),
            `${hex(VALUE)}\n`,
          );
        }
      },
      [
        () => terminateChildren(children, 1_000, 'reader process shutdown'),
        () => setupTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('module workers observe committed binary values', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let setupTxn: TxnContract | undefined;
    const workers: Worker[] = [];

    return withCleanup(
      async () => {
        env.open({
          path,
          maxDbs: 10,
          mapSize: MAX_DB_SIZE,
          maxReaders: 126,
        });
        dbi = env.openDbi({ name: 'threads', create: true });
        setupTxn = env.beginTxn();
        for (let index = 0; index < READER_COUNT; index++) {
          setupTxn.putBinary(dbi, `key${index}`, VALUE);
        }
        setupTxn.commit();
        setupTxn = undefined;

        const protocolUrl = new URL(
          '../src/batch/protocol.ts',
          import.meta.url,
        ).href;
        const protocol = await import(protocolUrl) as EnvironmentProtocol;
        const replies: Promise<WorkerReply>[] = [];
        for (let index = 0; index < READER_COUNT; index++) {
          const descriptor = protocol.getEnvironmentDescriptor(env, 'read');
          assertEquals(descriptor.capability, 'read');
          protocol.validateEnvironmentDescriptor(descriptor, 'read');
          const worker = new Worker(
            new URL('./fixtures/worker_reader.ts', import.meta.url).href,
            { type: 'module' },
          );
          workers.push(worker);
          replies.push(
            readFromWorker(worker, {
              descriptor,
              dbName: 'threads',
              key: `key${index}`,
              expectedHex: hex(VALUE),
            }),
          );
        }

        const results = await withDeadline(
          Promise.all(replies),
          DEADLINE_MS,
          'worker readers',
        );
        assertEquals(results.length, READER_COUNT);
        for (const result of results) {
          assertEquals(result, {
            ok: true,
            hex: hex(VALUE),
            cleanupComplete: true,
          });
        }
      },
      [
        () => {
          for (const worker of workers) worker.terminate();
        },
        () => setupTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('descriptor validation authenticates every field and capability', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    return withCleanup(
      async () => {
        env.open({ path });
        const protocol = await import(
          new URL('../src/batch/protocol.ts', import.meta.url).href
        ) as EnvironmentProtocol;
        const registryBaseline = protocol.getIssuedDescriptorCountForTest();
        const descriptor = protocol.getEnvironmentDescriptor(env, 'read');
        assertEquals(Object.keys(descriptor).sort(), [
          'capability',
          'envAddress',
          'generation',
          'libraryPath',
        ]);
        assertEquals(Number.isSafeInteger(descriptor.generation), true);
        assertEquals(descriptor.generation > 0, true);
        protocol.validateEnvironmentDescriptor(descriptor, 'read');
        expectDescriptorRejected(protocol, descriptor, 'read');

        const first = protocol.getEnvironmentDescriptor(env, 'read');
        const second = protocol.getEnvironmentDescriptor(env, 'read');
        expectDescriptorRejected(protocol, { ...first }, 'read');
        expectDescriptorRejected(protocol, {
          ...first,
          libraryPath: `${first.libraryPath}.tampered`,
        }, 'read');
        expectDescriptorRejected(protocol, {
          ...first,
          envAddress: first.envAddress + 1n,
        }, 'read');
        expectDescriptorRejected(protocol, {
          ...first,
          generation: 0,
        }, 'read');
        expectDescriptorRejected(protocol, {
          ...first,
          generation: 'not-a-generation' as never,
        }, 'read');
        expectDescriptorRejected(protocol, {
          ...first,
          generation: Number.NaN,
        }, 'read');
        const { generation: _generation, ...withoutGeneration } = first;
        expectDescriptorRejected(
          protocol,
          withoutGeneration as WorkerEnvironmentDescriptor,
          'read',
        );
        expectDescriptorRejected(protocol, {
          ...first,
          capability: 'batch',
        }, 'batch');
        protocol.validateEnvironmentDescriptor(first, 'read');
        protocol.validateEnvironmentDescriptor(second, 'read');

        const unrelated = protocol.getEnvironmentDescriptor(env, 'read');
        const mutatedOriginal = protocol.getEnvironmentDescriptor(env, 'read');
        (mutatedOriginal as { libraryPath: string }).libraryPath += '.tampered';
        expectDescriptorRejected(protocol, mutatedOriginal, 'read');
        expectDescriptorRejected(protocol, mutatedOriginal, 'read');
        protocol.validateEnvironmentDescriptor(unrelated, 'read');

        const mismatchedOriginal = protocol.getEnvironmentDescriptor(
          env,
          'read',
        );
        expectDescriptorRejected(protocol, mismatchedOriginal, 'batch');
        expectDescriptorRejected(protocol, mismatchedOriginal, 'read');

        const native = await import(
          new URL('../src/internal/native_test_access.ts', import.meta.url).href
        ) as { poisonNativeEnvironment(env: object): void };
        const liveBeforePoison = protocol.getLiveGenerationCountForTest();
        const revokedByPoison = protocol.getEnvironmentDescriptor(env, 'read');
        native.poisonNativeEnvironment(env);
        assertEquals(
          protocol.getIssuedDescriptorCountForTest(),
          registryBaseline,
        );
        assertEquals(
          protocol.getLiveGenerationCountForTest(),
          liveBeforePoison,
        );
        expectDescriptorRejected(protocol, revokedByPoison, 'read');
      },
      [() => env.close()],
    );
  });
});

Deno.test('forged cross-environment clones preserve both authorities', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const sourcePath = `${path}/source`;
    const targetPath = `${path}/target`;
    await Deno.mkdir(sourcePath);
    await Deno.mkdir(targetPath);
    const sourceEnv = new Env();
    const targetEnv = new Env();
    return withCleanup(
      async () => {
        sourceEnv.open({ path: sourcePath });
        targetEnv.open({ path: targetPath });
        const protocol = await import(
          new URL('../src/batch/protocol.ts', import.meta.url).href
        ) as EnvironmentProtocol;
        const source = protocol.getEnvironmentDescriptor(sourceEnv, 'read');
        const target = protocol.getEnvironmentDescriptor(targetEnv, 'read');

        expectDescriptorRejected(protocol, {
          ...source,
          envAddress: target.envAddress,
          generation: target.generation,
        }, 'read');
        protocol.validateEnvironmentDescriptor(source, 'read');
        protocol.validateEnvironmentDescriptor(target, 'read');
      },
      [() => targetEnv.close(), () => sourceEnv.close()],
    );
  });
});

Deno.test('poisoned final close releases its current generation token', async () => {
  const { Env } = await loadSubject();
  const protocol = await import(
    new URL('../src/batch/protocol.ts', import.meta.url).href
  ) as EnvironmentProtocol;
  const native = await import(
    new URL('../src/internal/native_test_access.ts', import.meta.url).href
  ) as { poisonNativeEnvironment(env: object): void };
  const issuedBaseline = protocol.getIssuedDescriptorCountForTest();
  const liveBaseline = protocol.getLiveGenerationCountForTest();

  await withTempDir(async (path) => {
    for (let index = 0; index < 8; index++) {
      const environmentPath = `${path}/poison-${index}`;
      await Deno.mkdir(environmentPath);
      const env = new Env();
      let closed = false;
      try {
        env.open({ path: environmentPath });
        const descriptor = protocol.getEnvironmentDescriptor(env, 'read');
        native.poisonNativeEnvironment(env);
        assertEquals(
          protocol.getIssuedDescriptorCountForTest(),
          issuedBaseline,
        );
        assertEquals(
          protocol.getLiveGenerationCountForTest(),
          liveBaseline + 1,
        );
        env.close();
        closed = true;
        assertEquals(
          protocol.getLiveGenerationCountForTest(),
          liveBaseline,
        );
        expectDescriptorRejected(protocol, descriptor, 'read');
      } finally {
        if (!closed) env.close();
      }
    }
  });
});

Deno.test('consumed descriptor state remains bounded under stress', async () => {
  const { Env } = await loadSubject();
  const protocol = await import(
    new URL('../src/batch/protocol.ts', import.meta.url).href
  ) as EnvironmentProtocol;
  const issuedBaseline = protocol.getIssuedDescriptorCountForTest();
  const liveBaseline = protocol.getLiveGenerationCountForTest();

  await withTempDir((path) => {
    const env = new Env();
    let closed = false;
    return withCleanup(
      () => {
        env.open({ path });
        assertEquals(
          protocol.getLiveGenerationCountForTest(),
          liveBaseline + 1,
        );
        for (let index = 0; index < 2_048; index++) {
          const capability = index % 2 === 0 ? 'read' : 'batch';
          const descriptor = protocol.getEnvironmentDescriptor(
            env,
            capability,
          );
          protocol.validateEnvironmentDescriptor(descriptor, capability);
        }
        assertEquals(
          protocol.getIssuedDescriptorCountForTest(),
          issuedBaseline,
        );
        assertEquals(
          protocol.getLiveGenerationCountForTest(),
          liveBaseline + 1,
        );
        env.close();
        closed = true;
        assertEquals(
          protocol.getLiveGenerationCountForTest(),
          liveBaseline,
        );
      },
      [() => closed ? undefined : env.close()],
    );
  });
});

Deno.test('unused descriptor records are revoked with their environment', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let closed = false;
    return withCleanup(
      async () => {
        env.open({ path });
        const protocol = await import(
          new URL('../src/batch/protocol.ts', import.meta.url).href
        ) as EnvironmentProtocol;
        const baseline = protocol.getIssuedDescriptorCountForTest();
        const read = protocol.getEnvironmentDescriptor(env, 'read');
        const batch = protocol.getEnvironmentDescriptor(env, 'batch');
        assertEquals(protocol.getIssuedDescriptorCountForTest(), baseline + 2);

        env.close();
        closed = true;
        assertEquals(protocol.getIssuedDescriptorCountForTest(), baseline);
        expectDescriptorRejected(protocol, read, 'read');
        expectDescriptorRejected(protocol, batch, 'batch');
      },
      [() => closed ? undefined : env.close()],
    );
  });
});

Deno.test('descriptors are isolate-local authorities', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    const children: ChildRecord[] = [];
    return withCleanup(
      async () => {
        env.open({ path });
        const protocol = await import(
          new URL('../src/batch/protocol.ts', import.meta.url).href
        ) as EnvironmentProtocol;
        const descriptor = protocol.getEnvironmentDescriptor(env, 'read');
        const projectPath = new URL('../', import.meta.url).pathname;
        children.push(spawnForeignDescriptorValidator(descriptor, projectPath));
        const output = await withDeadline(
          children[0].output,
          DEADLINE_MS,
          'foreign descriptor validation',
        );
        assertEquals(output.code, 0);
        assertEquals(new TextDecoder().decode(output.stderr), '');
        assertEquals(
          new TextDecoder().decode(output.stdout),
          'foreign-descriptor-rejected\n',
        );
      },
      [
        () => terminateChildren(children, 1_000, 'descriptor probe shutdown'),
        () => env.close(),
      ],
    );
  });
});

Deno.test('Worker read errors release native resources before later reads', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    const workers: Worker[] = [];
    return withCleanup(
      async () => {
        env.open({ path, maxDbs: 4 });
        dbi = env.openDbi({ name: 'worker-recovery', create: true });
        txn = env.beginTxn();
        txn.putBinary(dbi, 'key', VALUE);
        txn.commit();
        txn = undefined;

        const protocol = await import(
          new URL('../src/batch/protocol.ts', import.meta.url).href
        ) as EnvironmentProtocol;
        const workerUrl =
          new URL('./fixtures/worker_reader.ts', import.meta.url)
            .href;

        const failedDescriptor = protocol.getEnvironmentDescriptor(env, 'read');
        protocol.validateEnvironmentDescriptor(failedDescriptor, 'read');
        const failedWorker = new Worker(workerUrl, { type: 'module' });
        workers.push(failedWorker);
        const failed = await withDeadline(
          readFromWorker(failedWorker, {
            descriptor: failedDescriptor,
            dbName: 'missing-worker-database',
            key: 'key',
            expectedHex: hex(VALUE),
          }),
          DEADLINE_MS,
          'failing Worker read',
        );
        assertEquals(failed.ok, false);
        assertEquals(failed.cleanupComplete, true);
        assertEquals(/not found|-30798/i.test(failed.error ?? ''), true);

        const successfulDescriptor = protocol.getEnvironmentDescriptor(
          env,
          'read',
        );
        protocol.validateEnvironmentDescriptor(successfulDescriptor, 'read');
        const successfulWorker = new Worker(workerUrl, { type: 'module' });
        workers.push(successfulWorker);
        assertEquals(
          await withDeadline(
            readFromWorker(successfulWorker, {
              descriptor: successfulDescriptor,
              dbName: 'worker-recovery',
              key: 'key',
              expectedHex: hex(VALUE),
            }),
            DEADLINE_MS,
            'recovery Worker read',
          ),
          { ok: true, hex: hex(VALUE), cleanupComplete: true },
        );

        txn = env.beginTxn({ readOnly: true });
        assertEquals(txn.getBinary(dbi, 'key'), VALUE);
        txn.abort();
        txn = undefined;
      },
      [
        () => {
          for (const worker of workers) worker.terminate();
        },
        () => txn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('closed environment descriptors are rejected before native access', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    const reopened = new Env();
    let envClosed = false;
    let reopenedClosed = false;
    return withCleanup(
      async () => {
        env.open({ path });
        const protocolUrl = new URL(
          '../src/batch/protocol.ts',
          import.meta.url,
        ).href;
        const protocol = await import(protocolUrl) as EnvironmentProtocol;
        const descriptor = protocol.getEnvironmentDescriptor(env, 'read');
        env.close();
        envClosed = true;
        reopened.open({ path });
        const fresh = protocol.getEnvironmentDescriptor(reopened, 'read');

        expectDescriptorRejected(protocol, descriptor, 'read');
        assertEquals(fresh.generation === descriptor.generation, false);
        protocol.validateEnvironmentDescriptor(fresh, 'read');
        reopened.close();
        reopenedClosed = true;
      },
      [
        () => envClosed ? undefined : env.close(),
        () => reopenedClosed ? undefined : reopened.close(),
      ],
    );
  });
});
