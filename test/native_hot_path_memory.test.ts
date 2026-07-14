import { assertEquals, assertExists } from './_support/assertions.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';
import { loadSubject } from './_support/subject.ts';

interface MemoryDiagnostic {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

interface MemoryReport {
  readonly status: string;
  readonly tracked: number;
  readonly finalized: number;
  readonly collectionAttempts: number;
  readonly liveAfterCollection: number;
  readonly baselineCounts: Record<string, number>;
  readonly liveCounts: Record<string, number>;
  readonly closedCounts: Record<string, number>;
  readonly memory: {
    readonly beforeWarmup: MemoryDiagnostic;
    readonly afterWarmup: MemoryDiagnostic;
    readonly afterStress: MemoryDiagnostic;
    readonly afterCollection: MemoryDiagnostic;
  };
}

Deno.test('native hot paths release caller buffers and native bindings', async () => {
  await loadSubject();
  const libraryPath = Deno.env.get('LMDB_LIB_PATH');
  if (!libraryPath) throw new Error('LMDB_LIB_PATH is required');

  await withTempDir((path) => {
    const fixturePath = new URL(
      './fixtures/native_hot_path_memory.ts',
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
          'native hot-path memory subprocess',
        );
        const stderr = new TextDecoder().decode(output.stderr);
        if (output.code !== 0) {
          throw new Error(
            `Native hot-path memory subprocess exited with code ${output.code}:\n${stderr}`,
          );
        }

        assertEquals(stderr, '');
        const report = JSON.parse(
          new TextDecoder().decode(output.stdout),
        ) as MemoryReport;
        assertEquals(report.status, 'native-hot-path-memory-ok');
        assertEquals(report.tracked > 0, true);
        assertEquals(report.liveAfterCollection, 0);
        assertEquals(report.finalized, report.tracked);
        assertEquals(report.collectionAttempts >= 1, true);
        assertEquals(report.collectionAttempts <= 240, true);
        assertEquals(report.liveCounts.transactions, 2);
        assertEquals(report.liveCounts.cursors, 2);
        assertEquals(report.closedCounts, report.baselineCounts);

        // Allocator high-water marks are intentionally diagnostic only. Check
        // that the fixture emitted every snapshot without imposing a flaky
        // RSS or heap threshold.
        for (const diagnostic of Object.values(report.memory)) {
          assertExists(diagnostic);
          assertEquals(Number.isFinite(diagnostic.rss), true);
          assertEquals(Number.isFinite(diagnostic.heapUsed), true);
          assertEquals(Number.isFinite(diagnostic.heapTotal), true);
          assertEquals(Number.isFinite(diagnostic.external), true);
        }
      },
      [
        () =>
          terminateChildren(
            [record],
            1_000,
            'native hot-path memory subprocess shutdown',
          ),
      ],
    );
  });
});
