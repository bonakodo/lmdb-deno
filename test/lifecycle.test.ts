import { assertEquals } from './_support/assertions.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';
import { loadSubject } from './_support/subject.ts';

Deno.test('garbage collection does not cause a segmentation fault', async () => {
  await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir((path) => {
    const fixturePath = new URL('./fixtures/gc_reader.ts', import.meta.url)
      .pathname;
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
          10_000,
          'GC subprocess',
        );
        const stderr = new TextDecoder().decode(output.stderr);
        if (output.code !== 0) {
          throw new Error(
            `GC subprocess exited with code ${output.code}:\n${stderr}`,
          );
        }
        assertEquals(output.code, 0);
        assertEquals(new TextDecoder().decode(output.stdout), 'gc-ok\n');
        assertEquals(stderr, '');
      },
      [
        () => terminateChildren([record], 1_000, 'GC subprocess shutdown'),
      ],
    );
  });
});

Deno.test('garbage collection releases native handle ownership', async () => {
  await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir((path) => {
    const fixturePath = new URL(
      './fixtures/gc_handle_ownership.ts',
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
          15_000,
          'GC ownership subprocess',
        );
        const stderr = new TextDecoder().decode(output.stderr);
        if (output.code !== 0) {
          throw new Error(
            `GC ownership subprocess exited with code ${output.code}:\n${stderr}`,
          );
        }
        assertEquals(
          new TextDecoder().decode(output.stdout),
          'gc-ownership-ok\n',
        );
        assertEquals(stderr, '');
      },
      [
        () =>
          terminateChildren(
            [record],
            1_000,
            'GC ownership subprocess shutdown',
          ),
      ],
    );
  });
});

for (const mode of ['abort', 'commit', 'reset', 'write'] as const) {
  Deno.test(`cursor terminal lifecycle is safe after ${mode}`, async () => {
    await loadSubject();
    const libraryPath = Deno.env.get('LMDB_LIB_PATH');
    if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

    await withTempDir((path) => {
      const fixturePath = new URL(
        './fixtures/cursor_terminal_lifecycle.ts',
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

      return withCleanup(
        async () => {
          const output = await withDeadline(
            record.output,
            10_000,
            `cursor ${mode} lifecycle subprocess`,
          );
          const stderr = new TextDecoder().decode(output.stderr);
          if (output.code !== 0) {
            throw new Error(
              `Cursor ${mode} subprocess exited with code ${output.code}:\n${stderr}`,
            );
          }
          assertEquals(
            new TextDecoder().decode(output.stdout),
            `cursor-${mode}-ok\n`,
          );
          assertEquals(stderr, '');
        },
        [
          () =>
            terminateChildren(
              [record],
              1_000,
              `cursor ${mode} subprocess shutdown`,
            ),
        ],
      );
    });
  });
}
