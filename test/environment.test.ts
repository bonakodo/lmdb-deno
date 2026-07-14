import { assertEquals, assertThrows } from './_support/assertions.ts';
import type { DbiContract, TxnContract } from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';
import { loadSubject } from './_support/subject.ts';

const MAX_DB_SIZE = 256 * 1024 * 1024;
const EACCES = 13;
const MDB_NOTFOUND = -30798;
const MDB_BAD_VALSIZE = -30781;
const COPY_CALLBACK_DEADLINE_MS = 5_000;
const SUBPROCESS_DEADLINE_MS = 10_000;
const DEADLOCK_DEADLINE_MS = 2_000;
const SECOND_WRITE_TXN_ERROR =
  "You have already opened a write transaction in the current process, can't open a second one.";

interface NativeEnvironmentDetails {
  readonly address: bigint;
  readonly flags: number;
  readonly refCount: number;
}

interface NativeEnvironmentTestAccess {
  readonly getNativeEnvironmentDetails: (
    env: object,
  ) => NativeEnvironmentDetails;
  readonly hasNativeTransaction: (txn: object) => boolean;
  readonly hasNativeEnvironment: (env: object) => boolean;
  readonly poisonNativeEnvironment: (env: object) => void;
}

async function loadNativeEnvironmentTestAccess(): Promise<
  NativeEnvironmentTestAccess
> {
  const url = new URL(
    '../src/internal/native_test_access.ts',
    import.meta.url,
  ).href;
  return await import(url) as NativeEnvironmentTestAccess;
}

function captureError(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected callback to throw an Error');
}

function encodeUtf16LeWithTerminator(text: string): Uint8Array {
  const bytes = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < text.length; index++) {
    view.setUint16(index * 2, text.charCodeAt(index), true);
  }
  view.setUint16(text.length * 2, 0, true);

  return bytes;
}

async function runCallerOwnedTxnFixture(
  path: string,
  mode: 'abort' | 'continue',
): Promise<void> {
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');
  const fixturePath = new URL(
    './fixtures/caller_owned_txn_failure.ts',
    import.meta.url,
  ).pathname;
  const projectPath = new URL('../', import.meta.url).pathname;
  const record = trackChild(new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env=LMDB_LIB_PATH',
      '--allow-ffi',
      `--allow-read=${projectPath},${path}`,
      `--allow-write=${path}`,
      fixturePath,
      path,
      mode,
    ],
    env: { LMDB_LIB_PATH: libraryPath },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn());

  await withCleanup(
    async () => {
      const output = await withDeadline(
        record.output,
        SUBPROCESS_DEADLINE_MS,
        `caller-owned transaction ${mode} subprocess`,
      );
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(
        output.signal,
        null,
        `caller-owned transaction ${mode} subprocess received a signal:\n${stderr}`,
      );
      assertEquals(
        output.code,
        0,
        `caller-owned transaction ${mode} subprocess failed:\n${stderr}`,
      );
      assertEquals(new TextDecoder().decode(output.stdout), `${mode}-ok\n`);
      assertEquals(stderr, '');
    },
    [
      () =>
        terminateChildren(
          [record],
          1_000,
          `caller-owned transaction ${mode} subprocess shutdown`,
        ),
    ],
  );
}

async function runPoisonedEnvironmentFixture(path: string): Promise<void> {
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');
  const fixturePath = new URL(
    './fixtures/poisoned_environment_lifecycle.ts',
    import.meta.url,
  ).pathname;
  const projectPath = new URL('../', import.meta.url).pathname;
  const record = trackChild(new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env=LMDB_LIB_PATH',
      '--allow-ffi',
      `--allow-read=${projectPath},${path}`,
      `--allow-write=${path}`,
      fixturePath,
      path,
    ],
    env: { LMDB_LIB_PATH: libraryPath },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn());

  await withCleanup(
    async () => {
      const output = await withDeadline(
        record.output,
        SUBPROCESS_DEADLINE_MS,
        'poisoned environment lifecycle subprocess',
      );
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(
        output.signal,
        null,
        `poisoned environment subprocess received a signal:\n${stderr}`,
      );
      assertEquals(
        output.code,
        0,
        `poisoned environment subprocess failed:\n${stderr}`,
      );
      assertEquals(new TextDecoder().decode(output.stdout), 'poison-ok\n');
      assertEquals(stderr, '');
    },
    [
      () =>
        terminateChildren(
          [record],
          1_000,
          'poisoned environment subprocess shutdown',
        ),
    ],
  );
}

async function runNativeSafetyFixture(
  fixtureName: string,
  paths: string[],
  expectedOutput: string,
  deadlineMs = SUBPROCESS_DEADLINE_MS,
): Promise<void> {
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');
  const fixturePath = new URL(
    `./fixtures/${fixtureName}.ts`,
    import.meta.url,
  ).pathname;
  const projectPath = new URL('../', import.meta.url).pathname;
  const parentPaths = paths.map((path) => {
    const separator = path.lastIndexOf('/');
    return separator <= 0 ? '/' : path.slice(0, separator);
  });
  const allowedPaths = [projectPath, ...paths, ...parentPaths].join(',');
  const record = trackChild(new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env=LMDB_LIB_PATH',
      '--allow-ffi',
      `--allow-read=${allowedPaths}`,
      `--allow-write=${paths.join(',')}`,
      fixturePath,
      ...paths,
    ],
    env: { LMDB_LIB_PATH: libraryPath },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn());
  const operation = `${fixtureName} subprocess`;

  await withCleanup(
    async () => {
      const output = await withDeadline(record.output, deadlineMs, operation);
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(
        output.signal,
        null,
        `${operation} received a signal:\n${stderr}`,
      );
      assertEquals(output.code, 0, `${operation} failed:\n${stderr}`);
      assertEquals(new TextDecoder().decode(output.stdout), expectedOutput);
      assertEquals(stderr, '');
    },
    [() => terminateChildren([record], 1_000, `${operation} shutdown`)],
  );
}

Deno.test('environment exposes the node-lmdb methods', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let closed = false;
    return withCleanup(
      () => {
        assertEquals(typeof env.open, 'function');
        env.open({ path, maxDbs: 10 });
        assertEquals(typeof env.close, 'function');
        assertEquals(typeof env.beginTxn, 'function');
        assertEquals(typeof env.openDbi, 'function');
        assertEquals(typeof env.sync, 'function');
        assertEquals(typeof env.resize, 'function');
        assertEquals(typeof env.stat, 'function');
        assertEquals(typeof env.info, 'function');
        env.close();
        closed = true;
      },
      [() => {
        if (!closed) env.close();
      }],
    );
  });
});

Deno.test('environment preserves supported LMDB flags and always sets NOTLS', async () => {
  const { Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir((path) => {
    const env = new Env();
    return withCleanup(
      () => {
        env.open({
          path,
          useWritemap: true,
          noMemInit: true,
          noReadAhead: true,
          noMetaSync: true,
          noSync: true,
          mapAsync: true,
          unsafeNoLock: true,
        });

        const { flags } = native.getNativeEnvironmentDetails(env);
        const expected = 0x80000 | 0x1000000 | 0x800000 | 0x40000 |
          0x10000 | 0x100000 | 0x400000 | 0x200000;
        assertEquals(flags & expected, expected);
      },
      [() => env.close()],
    );
  });
});

Deno.test('environment forwards noSubdir and readOnly flags', async () => {
  const { Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir(async (path) => {
    const fileEnv = new Env();
    await withCleanup(
      () => {
        fileEnv.open({ path: `${path}/single.mdb`, noSubdir: true });
        assertEquals(
          native.getNativeEnvironmentDetails(fileEnv).flags & 0x204000,
          0x204000,
        );
      },
      [() => fileEnv.close()],
    );

    const directoryPath = `${path}/readonly`;
    await Deno.mkdir(directoryPath);
    const seedEnv = new Env();
    await withCleanup(
      () => seedEnv.open({ path: directoryPath }),
      [() => seedEnv.close()],
    );

    const readOnlyEnv = new Env();
    await withCleanup(
      () => {
        readOnlyEnv.open({ path: directoryPath, readOnly: true });
        assertEquals(
          native.getNativeEnvironmentDetails(readOnlyEnv).flags & 0x220000,
          0x220000,
        );
      },
      [() => readOnlyEnv.close()],
    );
  });
});

Deno.test('same canonical path reuses one native environment until final close', async () => {
  const { Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir((path) => {
    const first = new Env();
    const second = new Env();
    let firstClosed = false;
    let secondClosed = false;
    return withCleanup(
      () => {
        first.open({ path, maxDbs: 10 });
        second.open({ path: `${path}/.`, maxDbs: 10, useWorker: false });

        const firstDetails = native.getNativeEnvironmentDetails(first);
        const secondDetails = native.getNativeEnvironmentDetails(second);
        assertEquals(firstDetails.address, secondDetails.address);
        assertEquals(firstDetails.refCount, 2);
        assertEquals(secondDetails.refCount, 2);

        first.close();
        firstClosed = true;
        assertThrows(() => first.info(), /closed/i);
        assertEquals(second.info().mapSize > 0, true);
        assertEquals(native.getNativeEnvironmentDetails(second).refCount, 1);

        second.close();
        secondClosed = true;
        assertThrows(() => second.info(), /closed/i);
      },
      [
        () => firstClosed ? undefined : first.close(),
        () => secondClosed ? undefined : second.close(),
      ],
    );
  });
});

Deno.test('same-path wrappers reuse the first native open options', async () => {
  const { Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir((path) => {
    const first = new Env();
    const second = new Env();
    let firstDbi: DbiContract | undefined;
    let secondDbi: DbiContract | undefined;
    return withCleanup(
      () => {
        first.open({
          path,
          maxDbs: 10,
          maxReaders: 422,
          mapSize: MAX_DB_SIZE,
          noSync: true,
        });
        second.open({
          path: `${path}/.`,
          maxDbs: 1,
          maxReaders: 11,
          mapSize: MAX_DB_SIZE * 2,
          useWorker: false,
        });

        assertEquals(second.info().mapSize, MAX_DB_SIZE);
        assertEquals(second.info().maxReaders, 422);
        assertEquals(
          native.getNativeEnvironmentDetails(second).flags & 0x210000,
          0x210000,
        );
        assertEquals(native.getNativeEnvironmentDetails(second).refCount, 2);
        firstDbi = second.openDbi({ name: 'first-options-a', create: true });
        secondDbi = second.openDbi({ name: 'first-options-b', create: true });
      },
      [
        () => secondDbi?.close(),
        () => firstDbi?.close(),
        () => second.close(),
        () => first.close(),
      ],
    );
  });
});

Deno.test('resize rejects transactions owned by another same-path wrapper', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const first = new Env();
    const second = new Env();
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        first.open({ path, mapSize: MAX_DB_SIZE });
        second.open({ path, mapSize: MAX_DB_SIZE });
        txn = second.beginTxn({ readOnly: true });

        assertThrows(
          () => first.resize(MAX_DB_SIZE * 2),
          /active transaction/i,
        );
        assertEquals(first.info().mapSize, MAX_DB_SIZE);

        txn.abort();
        txn = undefined;
        first.resize(MAX_DB_SIZE * 2);
        assertEquals(second.info().mapSize, MAX_DB_SIZE * 2);
      },
      [() => txn?.abort(), () => second.close(), () => first.close()],
    );
  });
});

Deno.test('poisoned shared state denies every native-backed child operation', async () => {
  await loadSubject();
  await withTempDir(runPoisonedEnvironmentFixture);
});

Deno.test('same-path wrappers reject a second writer without blocking', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'shared_writer_rejection',
      [path],
      'writer-ok\n',
      DEADLOCK_DEADLINE_MS,
    )
  );
});

Deno.test('native open failure closes and retires only the failed wrapper', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'native_open_failure',
      [path],
      'open-failure-ok\n',
    )
  );
});

Deno.test('mixed environment handles are rejected before native calls', async () => {
  await loadSubject();
  await withTempDir(async (path) => {
    const firstPath = `${path}/first`;
    const secondPath = `${path}/second`;
    await Deno.mkdir(firstPath);
    await Deno.mkdir(secondPath);
    await runNativeSafetyFixture(
      'cross_environment_ownership',
      [firstPath, secondPath],
      'ownership-ok\n',
    );
  });
});

Deno.test('failed internal drop releases its writer and preserves caller ownership', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'dbi_drop_failure',
      [path],
      'drop-failure-ok\n',
      DEADLOCK_DEADLINE_MS,
    )
  );
});

Deno.test('aborted caller DBIs cannot alias reused native slots', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'pending_dbi_slot_reuse',
      [path],
      'pending-slot-ok\n',
    )
  );
});

Deno.test('DBI aliases close and drop without stale slot reuse', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'dbi_alias_lifecycle',
      [path],
      'alias-lifecycle-ok\n',
    )
  );
});

Deno.test('internal DBI writers reject an active public writer', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'internal_writer_reservation',
      [path],
      'writer-reservation-ok\n',
      DEADLOCK_DEADLINE_MS,
    )
  );
});

Deno.test('DBIs outlive a non-final creator environment wrapper', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const creator = new Env();
    const survivor = new Env();
    let useDbi: DbiContract | undefined;
    let closeDbi: DbiContract | undefined;
    let dropDbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    let creatorClosed = false;
    return withCleanup(
      () => {
        creator.open({ path, maxDbs: 10 });
        survivor.open({ path, maxDbs: 10 });
        useDbi = creator.openDbi({ name: 'surviving-use', create: true });
        closeDbi = creator.openDbi({ name: 'surviving-close', create: true });
        dropDbi = creator.openDbi({ name: 'surviving-drop', create: true });

        creator.close();
        creatorClosed = true;

        txn = survivor.beginTxn();
        txn.putString(useDbi, 'key', 'value');
        assertEquals(txn.getString(useDbi, 'key'), 'value');
        txn.commit();
        txn = undefined;
        closeDbi.close();
        closeDbi = undefined;
        dropDbi.drop();
        dropDbi = undefined;
      },
      [
        () => txn?.abort(),
        () => dropDbi?.close(),
        () => closeDbi?.close(),
        () => useDbi?.close(),
        () => creatorClosed ? undefined : creator.close(),
        () => survivor.close(),
      ],
    );
  });
});

Deno.test('poisoned same-path open retires its unopened native handle', async () => {
  const { Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir((path) => {
    const first = new Env();
    const rejected = new Env();
    first.open({ path });
    native.poisonNativeEnvironment(first);
    assertEquals(native.hasNativeEnvironment(rejected), true);
    assertThrows(() => rejected.open({ path }), /poisoned/i);
    assertEquals(native.hasNativeEnvironment(rejected), false);
    assertThrows(() => rejected.close(), /already closed/i);
    first.close();
  });
});

Deno.test('environment files use node-lmdb creation mode 0664', async () => {
  await loadSubject();
  await withTempDir((path) =>
    runNativeSafetyFixture(
      'environment_mode',
      [`${path}/mode.mdb`],
      'mode-ok\n',
    )
  );
});

Deno.test('environment flags require literal true boolean values', async () => {
  const { Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir(async (path) => {
    const cases: Record<string, unknown>[] = [
      {
        noSubdir: false,
        readOnly: false,
        useWritemap: false,
        usePreviousSnapshot: false,
        noMemInit: false,
        noReadAhead: false,
        noMetaSync: false,
        noSync: false,
        mapAsync: false,
        unsafeNoLock: false,
      },
      {
        noSubdir: 'false',
        readOnly: 1,
        useWritemap: 'false',
        usePreviousSnapshot: 'false',
        noMemInit: 1,
        noReadAhead: 'false',
        noMetaSync: 1,
        noSync: 'false',
        mapAsync: 1,
        unsafeNoLock: 'false',
      },
      {
        noSubdir: null,
        readOnly: null,
        useWritemap: null,
        usePreviousSnapshot: null,
        noMemInit: null,
        noReadAhead: null,
        noMetaSync: null,
        noSync: null,
        mapAsync: null,
        unsafeNoLock: null,
      },
    ];

    for (let index = 0; index < cases.length; index++) {
      const env = new Env();
      const directoryPath = `${path}/case-${index}`;
      await Deno.mkdir(directoryPath);
      await withCleanup(
        () => {
          env.open({ path: directoryPath, ...cases[index] } as never);
          assertEquals(native.getNativeEnvironmentDetails(env).flags, 0x200000);
        },
        [() => env.close()],
      );
    }
  });
});

Deno.test('closing a wrapper aborts its active transactions', async () => {
  const { Cursor, Env } = await loadSubject();
  const native = await loadNativeEnvironmentTestAccess();

  await withTempDir((path) => {
    const env = new Env();
    env.open({ path });
    const dbi = env.openDbi({ name: null, create: true });
    const txn = env.beginTxn();
    const cursor = new Cursor(txn, dbi);
    assertEquals(native.hasNativeTransaction(txn), true);

    env.close();

    assertEquals(native.hasNativeTransaction(txn), false);
    assertThrows(() => txn.abort(), /closed/i);
    assertThrows(() => dbi.close(), /closed/i);
    assertThrows(() => cursor.close(), /closed/i);
  });
});

Deno.test('a second write transaction is rejected', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let firstTxn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        firstTxn = env.beginTxn();

        const error = captureError(() => env.beginTxn());
        assertEquals(error.message, SECOND_WRITE_TXN_ERROR);
      },
      [() => firstTxn?.abort(), () => env.close()],
    );
  });
});

Deno.test('string data can be written, read, and deleted', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'mydb1', create: true });
        txn = env.beginTxn();

        assertEquals(txn.getString(dbi, 'hello'), null);
        txn.putString(dbi, 'hello', 'Hello world!');
        assertEquals(txn.getString(dbi, 'hello'), 'Hello world!');
        txn.del(dbi, 'hello');
        assertEquals(txn.getString(dbi, 'hello'), null);
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('openDbi rejects undefined, null, and numeric parameters', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });

        assertThrows(() => env.openDbi(undefined as never));
        assertThrows(() => env.openDbi(null as never));
        assertThrows(() => env.openDbi(1 as never));
      },
      [() => env.close()],
    );
  });
});

Deno.test('database flags require literal true boolean values', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let duplicateDbi: DbiContract | undefined;
    let keyDbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        duplicateDbi = env.openDbi({
          name: 'strict-duplicate-flag',
          create: true,
          dupSort: 'yes' as never,
        });
        keyDbi = env.openDbi({
          name: 'strict-key-flag',
          create: true,
          keyIsUint32: 1 as never,
        });
        txn = env.beginTxn();
        txn.putString(duplicateDbi, 'same', 'first');
        txn.putString(duplicateDbi, 'same', 'second');
        txn.putString(keyDbi, 'string-key', 'value');
        assertEquals(txn.getString(duplicateDbi, 'same'), 'second');
        assertEquals(txn.getString(keyDbi, 'string-key'), 'value');
        assertEquals(duplicateDbi.stat(txn).entryCount, 1);
        txn.commit();
        txn = undefined;
      },
      [
        () => txn?.abort(),
        () => keyDbi?.close(),
        () => duplicateDbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('an empty database name never aliases the unnamed database', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let unnamed: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        unnamed = env.openDbi({ name: null, create: true });
        txn = env.beginTxn();
        txn.putString(unnamed, 'key', 'unnamed-value');
        txn.commit();
        txn = undefined;

        const error = captureError(() =>
          env.openDbi({ name: '', create: true })
        );
        assertEquals(error.name, 'Error');
        assertEquals(
          (error as Error & { code?: unknown }).code,
          MDB_BAD_VALSIZE,
        );
        assertEquals(error.message.includes('MDB_BAD_VALSIZE'), true);

        txn = env.beginTxn();
        assertEquals(txn.getString(unnamed, 'key'), 'unnamed-value');
        txn.abort();
        txn = undefined;
      },
      [() => txn?.abort(), () => unnamed?.close(), () => env.close()],
    );
  });
});

Deno.test('read-only database creation reports node-lmdb EACCES', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const writable = new Env();
    writable.open({ path, maxDbs: 4 });
    writable.close();

    const readOnly = new Env();
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        readOnly.open({ path, maxDbs: 4, readOnly: true });

        const beginError = captureError(() => readOnly.beginTxn());
        assertEquals(beginError.name, 'Error');
        assertEquals(beginError.message.includes('Permission denied'), true);
        assertEquals(
          (beginError as Error & { code?: unknown }).code,
          EACCES,
        );

        txn = readOnly.beginTxn({ readOnly: true });
        const openError = captureError(() =>
          readOnly.openDbi({ name: 'missing', create: true, txn })
        );
        assertEquals(openError.name, 'Error');
        assertEquals(openError.message.includes('Permission denied'), true);
        assertEquals(
          (openError as Error & { code?: unknown }).code,
          EACCES,
        );
        txn.abort();
        txn = undefined;
      },
      [() => txn?.abort(), () => readOnly.close()],
    );
  });
});

Deno.test('drop with justFreePages empties without closing the database', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'mydb1', create: true });

        txn = env.beginTxn();
        txn.putString(dbi, 'hello', 'world');
        txn.commit();
        txn = undefined;

        dbi.drop({ justFreePages: true });

        txn = env.beginTxn({ readOnly: true });
        assertEquals(txn.getString(dbi, 'hello'), null);
        txn.abort();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('strings containing embedded NUL characters round-trip', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let readTxn: TxnContract | undefined;
    let writeTxn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'mydb1x', create: true });

        readTxn = env.beginTxn({ readOnly: true });
        assertEquals(readTxn.getString(dbi, 'hello'), null);
        readTxn.reset();

        writeTxn = env.beginTxn();
        writeTxn.putString(dbi, 'hello', 'Hello \0 world!');
        assertEquals(writeTxn.getString(dbi, 'hello'), 'Hello \0 world!');
        writeTxn.del(dbi, 'hello');
        assertEquals(writeTxn.getString(dbi, 'hello'), null);
        writeTxn.commit();
        writeTxn = undefined;
      },
      [
        () => writeTxn?.abort(),
        () => readTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});

Deno.test('manually encoded UTF-16LE bytes can be read as a string', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        const expectedString = 'Hello \0 world!';
        const encoded = encodeUtf16LeWithTerminator(expectedString);
        const key = 'hello';

        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'mydb1xx', create: true });
        txn = env.beginTxn();

        assertEquals(txn.getBinary(dbi, key), null);
        txn.putBinary(dbi, key, encoded);
        assertEquals(txn.getBinary(dbi, key), encoded);
        assertEquals(txn.getString(dbi, key), expectedString);

        txn.del(dbi, key);
        txn.putBinary(dbi, key, new TextEncoder().encode(expectedString));
        const error = captureError(() => txn?.getString(dbi!, key));
        assertEquals(error.message, 'Invalid zero-terminated UTF-16 string');

        txn.del(dbi, key);
        assertEquals(txn.getBinary(dbi, key), null);
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('opening a missing named database throws an Error', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });

        const error = captureError(
          () => env.openDbi({ name: 'does-not-exist', create: false }),
        );
        const code = (error as { code?: unknown }).code;
        assertEquals(typeof code, 'number');
        assertEquals(code, MDB_NOTFOUND);
      },
      [() => env.close()],
    );
  });
});

Deno.test('environment info has node-lmdb number fields and options', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    return withCleanup(
      () => {
        env.open({
          path,
          maxDbs: 10,
          maxReaders: 422,
          mapSize: MAX_DB_SIZE,
        });

        const info = env.info();
        assertEquals(typeof info.mapAddress, 'number');
        assertEquals(typeof info.mapSize, 'number');
        assertEquals(typeof info.lastPageNumber, 'number');
        assertEquals(typeof info.lastTxnId, 'number');
        assertEquals(typeof info.maxReaders, 'number');
        assertEquals(typeof info.numReaders, 'number');
        assertEquals(info.mapSize, MAX_DB_SIZE);
        assertEquals(info.maxReaders, 422);
      },
      [() => env.close()],
    );
  });
});

Deno.test('resize rejects active write and read transactions', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({ name: 'mydb1', create: true });
        let info = env.info();
        assertEquals(info.mapSize, MAX_DB_SIZE);

        txn = env.beginTxn();
        assertThrows(() => env.resize(info.mapSize * 2), Error);
        txn.abort();
        txn = undefined;
        info = env.info();
        assertEquals(info.mapSize, MAX_DB_SIZE);

        txn = env.beginTxn({ readOnly: true });
        assertThrows(() => env.resize(info.mapSize * 2), Error);
        txn.abort();
        txn = undefined;
        assertEquals(env.info().mapSize, MAX_DB_SIZE);
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('resize changes the environment map size', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10, mapSize: MAX_DB_SIZE });
        dbi = env.openDbi({ name: 'mydb1', create: true });

        assertEquals(env.info().mapSize, MAX_DB_SIZE);
        env.resize(MAX_DB_SIZE * 2);
        assertEquals(env.info().mapSize, MAX_DB_SIZE * 2);
      },
      [() => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('environment statistics have valid node-lmdb fields', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });

        const stat = env.stat();
        assertEquals(typeof stat.pageSize, 'number');
        assertEquals(typeof stat.treeDepth, 'number');
        assertEquals(typeof stat.treeBranchPageCount, 'number');
        assertEquals(typeof stat.treeLeafPageCount, 'number');
        assertEquals(typeof stat.entryCount, 'number');
        assertEquals(typeof stat.overflowPages, 'number');
        assertEquals(stat.pageSize >= 1024, true);
        assertEquals((stat.pageSize & (stat.pageSize - 1)) === 0, true);
        assertEquals(stat.treeDepth >= 0 && stat.treeDepth < 100, true);
      },
      [() => env.close()],
    );
  });
});

Deno.test('database statistics have node-lmdb fields', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        dbi = env.openDbi({ name: 'mydb2', create: true });
        txn = env.beginTxn();

        const stat = dbi.stat(txn);
        assertEquals(typeof stat.pageSize, 'number');
        assertEquals(typeof stat.treeDepth, 'number');
        assertEquals(typeof stat.treeBranchPageCount, 'number');
        assertEquals(typeof stat.treeLeafPageCount, 'number');
        assertEquals(typeof stat.entryCount, 'number');
        assertEquals(typeof stat.overflowPages, 'number');
        assertEquals(stat.pageSize >= 1024, true);
        assertEquals(stat.treeDepth >= 0 && stat.treeDepth < 100, true);
        txn.abort();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('openDbi accepts a caller-supplied transaction', async () => {
  const { Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 10 });
        txn = env.beginTxn();
        dbi = env.openDbi({
          name: 'dbUsingUserSuppliedTxn',
          create: true,
          txn,
        });
        txn.putString(dbi, 'hello', 'world');
        txn.commit();
        txn = undefined;

        txn = env.beginTxn({ readOnly: true });
        assertEquals(txn.getString(dbi, 'hello'), 'world');
        txn.abort();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});

Deno.test('failed openDbi preserves a caller-supplied transaction', async () => {
  await loadSubject();

  await withTempDir(async (path) => {
    for (const mode of ['continue', 'abort'] as const) {
      const fixturePath = `${path}/${mode}`;
      await Deno.mkdir(fixturePath);
      await runCallerOwnedTxnFixture(fixturePath, mode);
    }
  });
});

Deno.test('copy callback creates a readable backup', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const sourcePath = `${path}/source`;
    const backupPath = `${path}/backup`;
    await Deno.mkdir(sourcePath);
    await Deno.mkdir(backupPath);

    const env = new Env();
    let dbi: DbiContract | undefined;
    let txn: TxnContract | undefined;
    await withCleanup(
      async () => {
        env.open({ path: sourcePath, maxDbs: 10 });
        txn = env.beginTxn();
        dbi = env.openDbi({ name: 'backup', create: true, txn });
        txn.putString(dbi, 'hello', 'world');
        txn.commit();
        txn = undefined;

        const callback = new Promise<void>((resolve, reject) => {
          env.copy(backupPath, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        await withDeadline(
          callback,
          COPY_CALLBACK_DEADLINE_MS,
          'env.copy callback',
        );

        const backupEnv = new Env();
        let backupDbi: DbiContract | undefined;
        let backupTxn: TxnContract | undefined;
        await withCleanup(
          () => {
            backupEnv.open({ path: backupPath, maxDbs: 10 });
            backupDbi = backupEnv.openDbi({
              name: 'backup',
              create: false,
            });
            backupTxn = backupEnv.beginTxn({ readOnly: true });
            assertEquals(backupTxn.getString(backupDbi, 'hello'), 'world');
            backupTxn.abort();
            backupTxn = undefined;
          },
          [
            () => backupTxn?.abort(),
            () => backupDbi?.close(),
            () => backupEnv.close(),
          ],
        );
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});
