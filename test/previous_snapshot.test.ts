import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';

interface Observation {
  readonly changed: string | null;
  readonly removed: string | null;
  readonly added: string | null;
}

const LATEST: Observation = {
  changed: 'second',
  removed: null,
  added: 'present-only-in-second',
};
const PREVIOUS: Observation = {
  changed: 'first',
  removed: 'present-only-in-first',
  added: null,
};
const PROJECT_PATH = new URL('../', import.meta.url).pathname;
const FIXTURE_PATH = new URL(
  './fixtures/previous_snapshot.ts',
  import.meta.url,
).pathname;

async function runFixture(mode: string, path: string): Promise<unknown> {
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');
  const record = trackChild(new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env=LMDB_LIB_PATH',
      '--allow-ffi',
      `--allow-read=${PROJECT_PATH},${path}`,
      `--allow-write=${path}`,
      FIXTURE_PATH,
      mode,
      path,
    ],
    env: { LMDB_LIB_PATH: libraryPath },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn());
  const operation = `previous snapshot ${mode} fixture`;
  return await withCleanup(
    async () => {
      const output = await withDeadline(record.output, 10_000, operation);
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(output.signal, null, `${operation} received a signal`);
      assertEquals(output.code, 0, `${operation} failed:\n${stderr}`);
      assertEquals(stderr, '');
      const stdout = new TextDecoder().decode(output.stdout).trim();
      assertEquals(stdout.split('\n').length, 1);
      return JSON.parse(stdout) as unknown;
    },
    [() => terminateChildren([record], 1_000, `${operation} shutdown`)],
  );
}

Deno.test('previous snapshot reads the commit before the latest snapshot', async () => {
  await withTempDir(async (path) => {
    assertEquals(await runFixture('seed', path), LATEST);
    assertEquals(await runFixture('read-latest', path), LATEST);
    assertEquals(await runFixture('read-previous', path), PREVIOUS);
  });
});

Deno.test('first previous-snapshot open governs same-path wrappers', async () => {
  await withTempDir(async (path) => {
    await runFixture('seed', path);
    assertEquals(await runFixture('shared-previous', path), {
      sameAddress: true,
      previous: PREVIOUS,
      shared: PREVIOUS,
    });
  });
});

Deno.test('committing from a previous snapshot clears the environment flag', async () => {
  await withTempDir(async (path) => {
    await runFixture('seed', path);
    assertEquals(await runFixture('commit-previous', path), {
      changed: 'third',
      removed: 'present-only-in-first',
      added: null,
      previousSnapshotFlag: false,
    });
  });
});

Deno.test('previous snapshot preserves MDB_INVALID for an invalid environment', async () => {
  await withTempDir(async (path) => {
    await Deno.writeFile(`${path}/data.mdb`, new Uint8Array(8));
    const result = await runFixture('invalid', path) as {
      readonly name: string;
      readonly code?: unknown;
    };
    assertEquals(result.name, 'Error');
    assertEquals(result.code, -30793);
  });
});
