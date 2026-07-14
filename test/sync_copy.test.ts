import { assertEquals, assertExists } from './_support/assertions.ts';
import type { EnvContract } from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';
import { loadSubject } from './_support/subject.ts';

const ASYNC_OPERATION_DEADLINE_MS = 5_000;

Deno.test('sync and copy use Deno nonblocking FFI symbols', async () => {
  await loadSubject();
  const { lmdbSymbols } = await import('../src/native/symbols.ts');

  assertEquals(
    (lmdbSymbols.mdb_env_sync as { nonblocking?: boolean }).nonblocking,
    true,
  );
  assertEquals(
    (lmdbSymbols.mdb_env_copy2 as { nonblocking?: boolean }).nonblocking,
    true,
  );
});

Deno.test('sync supports callback and Promise completion asynchronously', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const env = new Env();
    await withCleanup(
      async () => {
        env.open({ path });

        const events: string[] = [];
        let callbackCount = 0;
        const callbackDone = new Promise<void>((resolve, reject) => {
          const result = env.sync((error) => {
            callbackCount++;
            events.push('callback');
            try {
              assertEquals(error, null);
              resolve();
            } catch (caught) {
              reject(caught);
            }
          });
          assertEquals(result, undefined);
        });
        queueMicrotask(() => events.push('microtask'));
        await withDeadline(
          callbackDone,
          ASYNC_OPERATION_DEADLINE_MS,
          'sync callback',
        );
        assertEquals(events, ['microtask', 'callback']);
        assertEquals(callbackCount, 1);

        const syncPromise = env.sync();
        assertEquals(syncPromise instanceof Promise, true);
        await withDeadline(
          syncPromise,
          ASYNC_OPERATION_DEADLINE_MS,
          'sync Promise',
        );
      },
      [() => env.close()],
    );
  });
});

Deno.test('read-only sync reports exact LmdbError in Promise and callback APIs', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const writable = new Env();
    writable.open({ path });
    writable.close();

    const readOnly = new Env();
    await withCleanup(
      async () => {
        readOnly.open({ path, readOnly: true });

        let promiseError: unknown;
        try {
          await readOnly.sync();
        } catch (error) {
          promiseError = error;
        }
        assertExactLmdbError(promiseError, 13);

        let callbackCount = 0;
        const callbackError = await new Promise<Error>((resolve, reject) => {
          const result = readOnly.sync((error) => {
            callbackCount++;
            if (error) resolve(error);
            else reject(new Error('read-only sync unexpectedly succeeded'));
          });
          assertEquals(result, undefined);
        });
        assertExactLmdbError(callbackError, 13);
        assertEquals(callbackCount, 1);
      },
      [() => readOnly.close()],
    );
  });
});

Deno.test('callback exceptions surface after the active lease is released', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const env = new Env();
    const sentinel = new Error('sync callback sentinel');
    let listener: ((event: ErrorEvent) => void) | undefined;
    await withCleanup(
      async () => {
        env.open({ path });
        const reported = new Promise<{
          reason: unknown;
          closeError: unknown;
        }>((resolve) => {
          listener = (event) => {
            if (event.error !== sentinel) return;
            event.preventDefault();
            let closeError: unknown;
            try {
              env.close();
            } catch (error) {
              closeError = error;
            }
            resolve({ reason: event.error, closeError });
          };
          addEventListener('error', listener);
        });

        const result = env.sync(() => {
          throw sentinel;
        });
        assertEquals(result, undefined);
        const report = await withDeadline(
          reported,
          ASYNC_OPERATION_DEADLINE_MS,
          'thrown sync callback',
        );
        assertEquals(report.reason, sentinel);
        assertEquals(report.closeError, undefined);
      },
      [
        () => {
          if (listener !== undefined) {
            removeEventListener('error', listener);
          }
        },
        () => closeIfOpen(env),
      ],
    );
  });
});

Deno.test('close rejects without detaching while sync is active', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const first = new Env();
    const second = new Env();
    await withCleanup(
      async () => {
        first.open({ path });
        second.open({ path });

        const syncing = first.sync();
        let closeError: unknown;
        try {
          second.close();
        } catch (error) {
          closeError = error;
        }
        await withDeadline(
          syncing.catch(() => undefined),
          ASYNC_OPERATION_DEADLINE_MS,
          'active sync',
        );
        assertEquals(closeError instanceof Error, true);
        if (!(closeError instanceof Error)) return;
        assertEquals(
          closeError.message.includes('sync or copy operation is still active'),
          true,
        );
        assertEquals(second.stat().pageSize > 0, true);

        second.close();
      },
      [() => closeIfOpen(second), () => closeIfOpen(first)],
    );
  });
});

Deno.test('multiple async operations keep every same-path wrapper open', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const sourcePath = `${path}/source`;
    const firstCopyPath = `${path}/copy-one`;
    const secondCopyPath = `${path}/copy-two`;
    await Deno.mkdir(sourcePath);
    await Deno.mkdir(firstCopyPath);
    await Deno.mkdir(secondCopyPath);

    const first = new Env();
    const second = new Env();
    await withCleanup(
      async () => {
        first.open({ path: sourcePath });
        second.open({ path: sourcePath });

        const operations = [
          first.sync(),
          second.copy(firstCopyPath),
          first.copy(secondCopyPath, true),
        ];
        let closeError: unknown;
        try {
          first.close();
        } catch (error) {
          closeError = error;
        }

        const settlements = await withDeadline(
          Promise.allSettled(operations),
          ASYNC_OPERATION_DEADLINE_MS,
          'concurrent sync and copies',
        );
        assertEquals(closeError instanceof Error, true);
        if (!(closeError instanceof Error)) return;
        assertEquals(
          closeError.message.includes('sync or copy operation is still active'),
          true,
        );
        for (const settlement of settlements) {
          if (settlement.status === 'rejected') throw settlement.reason;
        }
        first.close();
        assertEquals(second.stat().pageSize > 0, true);
      },
      [() => closeIfOpen(second), () => closeIfOpen(first)],
    );
  });
});

Deno.test('large copy is nonblocking and compact copy reclaims free pages', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const sourcePath = `${path}/source`;
    const regularPath = `${path}/regular`;
    const callbackPath = `${path}/callback`;
    const compactPath = `${path}/compact`;
    await Deno.mkdir(sourcePath);
    await Deno.mkdir(regularPath);
    await Deno.mkdir(callbackPath);
    await Deno.mkdir(compactPath);

    const env = new Env();
    await withCleanup(
      async () => {
        env.open({ path: sourcePath, maxDbs: 2, mapSize: 96 * 1024 * 1024 });
        const dbi = env.openDbi({ name: 'data', create: true });
        try {
          const value = new Uint8Array(1024 * 1024);
          value.fill(0x5a);
          let txn = env.beginTxn();
          for (let index = 0; index < 48; index++) {
            txn.putBinary(dbi, `page-${index}`, value);
          }
          txn.commit();

          txn = env.beginTxn();
          for (let index = 0; index < 40; index++) {
            txn.del(dbi, `page-${index}`);
          }
          txn.commit();
        } finally {
          dbi.close();
        }

        const events: string[] = [];
        let promiseSettled = false;
        let callbackSettled = false;
        let callbackCount = 0;
        let bothCopiesWerePendingAtTimer = false;
        const regularCopy = env.copy(regularPath).then(() => {
          promiseSettled = true;
          events.push('promise');
        });
        const callbackCopy = new Promise<void>((resolve, reject) => {
          const result = env.copy(callbackPath, undefined, (error) => {
            callbackCount++;
            events.push('callback');
            callbackSettled = true;
            try {
              assertEquals(error, null);
              resolve();
            } catch (caught) {
              reject(caught);
            }
          });
          assertEquals(result, undefined);
        });
        const independentTimer = new Promise<void>((resolve) => {
          setTimeout(() => {
            bothCopiesWerePendingAtTimer = !promiseSettled &&
              !callbackSettled;
            events.push('timer');
            resolve();
          }, 0);
        });
        await withDeadline(
          Promise.all([regularCopy, callbackCopy, independentTimer]),
          ASYNC_OPERATION_DEADLINE_MS,
          'large nonblocking copy',
        );
        assertEquals(bothCopiesWerePendingAtTimer, true);
        assertEquals(events[0], 'timer');
        assertEquals(events.includes('promise'), true);
        assertEquals(events.includes('callback'), true);
        assertEquals(callbackCount, 1);

        await withDeadline(
          env.copy(compactPath, true),
          ASYNC_OPERATION_DEADLINE_MS,
          'compact copy',
        );
        await assertReadableBackup(regularPath, 'page-47', 1024 * 1024);
        await assertReadableBackup(compactPath, 'page-47', 1024 * 1024);

        const regularLogicalSize = (await Deno.stat(
          `${regularPath}/data.mdb`,
        )).size;
        const compactLogicalSize = (await Deno.stat(
          `${compactPath}/data.mdb`,
        )).size;
        assertEquals(
          regularLogicalSize - compactLogicalSize > 24 * 1024 * 1024,
          true,
          `expected compact copy to reclaim at least 24 MiB; regular=${regularLogicalSize}, compact=${compactLogicalSize}`,
        );
        assertEquals(
          compactLogicalSize < regularLogicalSize / 2,
          true,
          `expected compact copy below half the regular logical size; regular=${regularLogicalSize}, compact=${compactLogicalSize}`,
        );
      },
      [() => env.close()],
    );
  });
});

Deno.test('copy reports native failures as LmdbError in both APIs', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const env = new Env();
    await withCleanup(
      async () => {
        env.open({ path });
        const invalidPath = `${path}/missing/backup`;

        let promiseError: unknown;
        let closeError: unknown;
        const failingCopy = env.copy(invalidPath);
        try {
          env.close();
        } catch (error) {
          closeError = error;
        }
        try {
          await failingCopy;
        } catch (error) {
          promiseError = error;
        }
        assertEquals(closeError instanceof Error, true);
        if (closeError instanceof Error) {
          assertEquals(
            closeError.message.includes(
              'sync or copy operation is still active',
            ),
            true,
          );
        }
        assertLmdbError(promiseError);

        let callbackCount = 0;
        const callbackError = await new Promise<Error>((resolve, reject) => {
          env.copy(invalidPath, (error) => {
            callbackCount++;
            if (error) resolve(error);
            else reject(new Error('copy unexpectedly succeeded'));
          });
        });
        assertLmdbError(callbackError);
        assertEquals(callbackCount, 1);
      },
      [() => env.close()],
    );
  });
});

Deno.test('copy error callback throws only after releasing its active lease', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const env = new Env();
    const sentinel = new Error('copy error callback sentinel');
    let listener: ((event: ErrorEvent) => void) | undefined;
    await withCleanup(
      async () => {
        env.open({ path });
        const reported = new Promise<{
          reason: unknown;
          closeError: unknown;
        }>((resolve) => {
          listener = (event) => {
            if (event.error !== sentinel) return;
            event.preventDefault();
            let closeError: unknown;
            try {
              env.close();
            } catch (error) {
              closeError = error;
            }
            resolve({ reason: event.error, closeError });
          };
          addEventListener('error', listener);
        });

        const result = env.copy(`${path}/missing/backup`, (error) => {
          assertExactLmdbError(error, 2);
          throw sentinel;
        });
        assertEquals(result, undefined);
        const report = await withDeadline(
          reported,
          ASYNC_OPERATION_DEADLINE_MS,
          'thrown copy error callback',
        );
        assertEquals(report.reason, sentinel);
        assertEquals(report.closeError, undefined);
      },
      [
        () => {
          if (listener !== undefined) removeEventListener('error', listener);
        },
        () => closeIfOpen(env),
      ],
    );
  });
});

Deno.test('pending copy survives Env finalization and closes after settlement', async () => {
  await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir((path) => {
    const fixturePath = new URL(
      './fixtures/pending_copy_gc.ts',
      import.meta.url,
    ).pathname;
    const projectPath = new URL('../', import.meta.url).pathname;
    const record = trackChild(new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--v8-flags=--expose-gc',
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

    return withCleanup(
      async () => {
        const output = await withDeadline(
          record.output,
          30_000,
          'pending-copy GC subprocess',
        );
        const stderr = new TextDecoder().decode(output.stderr);
        assertEquals(output.code, 0, stderr);
        assertEquals(output.signal, null, stderr);
        assertEquals(
          new TextDecoder().decode(output.stdout),
          'pending-copy-gc-ok\n',
        );
        assertEquals(stderr, '');
      },
      [
        () =>
          terminateChildren(
            [record],
            1_000,
            'pending-copy GC subprocess shutdown',
          ),
      ],
    );
  });
});

Deno.test('copy validates overload arguments before starting native work', async () => {
  const { Env } = await loadSubject();

  await withTempDir(async (path) => {
    const env = new Env();
    await withCleanup(
      async () => {
        env.open({ path });
        const unsafeCopy = env.copy.bind(env) as unknown as (
          ...args: unknown[]
        ) => unknown;
        const unsafeSync = env.sync.bind(env) as unknown as (
          ...args: unknown[]
        ) => unknown;

        await assertSynchronousTypeError(() => unsafeCopy(42));
        await assertSynchronousTypeError(() => unsafeCopy(path, 'compact'));
        await assertSynchronousTypeError(
          () => unsafeCopy(path, false, 'callback'),
        );
        await assertSynchronousTypeError(() => unsafeSync('callback'));

        // Validation failures must not leave the environment artificially busy.
        env.close();
      },
      [() => closeIfOpen(env)],
    );
  });
});

async function assertReadableBackup(
  path: string,
  key: string,
  expectedLength: number,
): Promise<void> {
  const { Env } = await loadSubject();
  const env = new Env();
  let dbi: ReturnType<EnvContract['openDbi']> | undefined;
  let txn: ReturnType<EnvContract['beginTxn']> | undefined;
  await withCleanup(
    () => {
      env.open({ path, maxDbs: 2, readOnly: true });
      dbi = env.openDbi({ name: 'data', create: false });
      txn = env.beginTxn({ readOnly: true });
      const value = txn.getBinary(dbi, key);
      assertEquals(value?.byteLength, expectedLength);
      assertEquals(value?.[0], 0x5a);
      assertEquals(value?.[expectedLength - 1], 0x5a);
      txn.abort();
      txn = undefined;
    },
    [() => txn?.abort(), () => dbi?.close(), () => env.close()],
  );
}

function assertLmdbError(
  error: unknown,
): asserts error is Error & { code: number } {
  assertExists(error);
  assertEquals(error instanceof Error, true);
  if (!(error instanceof Error)) return;
  assertEquals(error.name, 'Error');
  assertEquals(typeof (error as Error & { code?: unknown }).code, 'number');
}

function assertExactLmdbError(
  error: unknown,
  code: number,
): asserts error is Error & { code: number } {
  assertLmdbError(error);
  assertEquals(error.code, code);
}

async function assertSynchronousTypeError(
  operation: () => unknown,
): Promise<void> {
  let result: unknown;
  let error: unknown;
  try {
    result = operation();
  } catch (caught) {
    error = caught;
  }
  if (result instanceof Promise) await result.catch(() => undefined);
  assertEquals(error instanceof TypeError, true);
}

function closeIfOpen(env: EnvContract): void {
  try {
    env.close();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (!error.message.includes('already closed') &&
        !error.message.includes('still active'))
    ) {
      throw error;
    }
  }
}
