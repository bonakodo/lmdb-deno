import {
  deepStrictEqual as assertEquals,
  match as assertMatch,
  ok as assert,
} from 'node:assert/strict';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';

interface ProbeError {
  readonly name: string;
  readonly message: string;
  readonly cause?: ProbeError;
}

type ProbeResult =
  | {
    readonly ok: true;
    readonly candidates?: string[];
    readonly path?: string;
    readonly version?: {
      readonly versionString: string;
      readonly major: number;
      readonly minor: number;
      readonly patch: number;
    };
  }
  | { readonly ok: false; readonly error: ProbeError };

const VERSION_SYMBOLS = {
  mdb_version: {
    parameters: ['buffer', 'buffer', 'buffer'],
    result: 'pointer',
  },
} as const satisfies Deno.ForeignLibraryInterface;

const PROJECT_PATH = new URL('../', import.meta.url).pathname;
const PROBE_PATH = new URL('./fixtures/loader_probe.ts', import.meta.url)
  .pathname;
const NATIVE_FIXTURE_PATH = new URL('./fixtures/native/', import.meta.url)
  .pathname;

function installedLibraryPath(): string {
  const path = Deno.env.get('LMDB_LIB_PATH');
  if (!path) throw new Error('LMDB_LIB_PATH is required by loader tests');
  return path;
}

async function boundedCommand(
  command: string,
  options: Deno.CommandOptions,
  operation: string,
): Promise<Deno.CommandOutput> {
  const record = trackChild(new Deno.Command(command, options).spawn());
  return await withCleanup(
    () => withDeadline(record.output, 10_000, operation),
    [() => terminateChildren([record], 1_000, `${operation} shutdown`)],
  );
}

async function probe(options: {
  readonly args: string[];
  readonly env?: Record<string, string>;
  readonly allowEnv?: boolean;
  readonly allowFfi?: true | string;
}): Promise<ProbeResult> {
  const permissionArgs = [`--allow-read=${PROJECT_PATH}`];
  if (options.allowEnv) permissionArgs.push('--allow-env=LMDB_LIB_PATH');
  if (options.allowFfi === true) permissionArgs.push('--allow-ffi');
  else if (typeof options.allowFfi === 'string') {
    permissionArgs.push(`--allow-ffi=${options.allowFfi}`);
  }

  const operation = `loader probe ${options.args.join(' ')}`;
  const output = await boundedCommand(
    Deno.execPath(),
    {
      args: ['run', ...permissionArgs, PROBE_PATH, ...options.args],
      clearEnv: true,
      env: { NO_COLOR: '1', ...options.env },
      stdout: 'piped',
      stderr: 'piped',
    },
    operation,
  );
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  assertEquals(output.code, 0, `loader probe stderr:\n${stderr}`);
  assert(stdout.length > 0, `loader probe emitted no JSON; stderr:\n${stderr}`);
  assertEquals(stdout.split('\n').length, 1, 'probe must emit one JSON result');
  return JSON.parse(stdout) as ProbeResult;
}

function expectError(result: ProbeResult): ProbeError {
  assertEquals(result.ok, false);
  return result.error;
}

function errorText(error: ProbeError): string {
  const parts: string[] = [];
  let current: ProbeError | undefined = error;
  while (current) {
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return parts.join('\ncaused by ');
}

function errorChain(error: ProbeError): ProbeError[] {
  const chain: ProbeError[] = [];
  let current: ProbeError | undefined = error;
  while (current) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function hasErrorName(error: ProbeError, name: string): boolean {
  let current: ProbeError | undefined = error;
  while (current) {
    if (current.name === name) return true;
    current = current.cause;
  }
  return false;
}

async function compileFixture(
  sourceName: string,
  outputPath: string,
): Promise<void> {
  const sourcePath = `${NATIVE_FIXTURE_PATH}${sourceName}`;
  const args = Deno.build.os === 'darwin'
    ? ['-dynamiclib', sourcePath, '-o', outputPath]
    : ['-shared', '-fPIC', sourcePath, '-o', outputPath];
  const output = await boundedCommand(
    'cc',
    { args, stdout: 'piped', stderr: 'piped' },
    `compile ${sourceName}`,
  );
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, `failed to compile ${sourceName}:\n${stderr}`);
}

function expectedAutoCandidates(): string[] {
  const architecturePaths = Deno.build.arch === 'aarch64'
    ? [
      '/usr/lib/aarch64-linux-gnu/liblmdb.so',
      '/usr/lib/aarch64-linux-gnu/liblmdb.so.0',
      '/usr/lib/x86_64-linux-gnu/liblmdb.so',
      '/usr/lib/x86_64-linux-gnu/liblmdb.so.0',
    ]
    : [
      '/usr/lib/x86_64-linux-gnu/liblmdb.so',
      '/usr/lib/x86_64-linux-gnu/liblmdb.so.0',
      '/usr/lib/aarch64-linux-gnu/liblmdb.so',
      '/usr/lib/aarch64-linux-gnu/liblmdb.so.0',
    ];
  return [
    '/usr/lib/liblmdb.so',
    '/usr/lib/liblmdb.so.0',
    ...architecturePaths,
    '/usr/lib/liblmdb.dylib',
  ];
}

function findInstalledAutoCandidate(candidates: readonly string[]):
  | string
  | undefined {
  for (const candidate of candidates) {
    let library: Deno.DynamicLibrary<typeof VERSION_SYMBOLS> | undefined;
    try {
      library = Deno.dlopen(candidate, VERSION_SYMBOLS);
      const major = new Int32Array(1);
      const minor = new Int32Array(1);
      const patch = new Int32Array(1);
      library.symbols.mdb_version(major, minor, patch);
      if (major[0] === 1 && minor[0] === 0 && patch[0] === 0) {
        return candidate;
      }
    } catch {
      // Candidate validity is asserted through the isolated loader below.
    } finally {
      library?.close();
    }
  }
  return undefined;
}

function findExactPathAfter(
  diagnostics: string,
  candidate: string,
  previousIndex: number,
): number {
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`${escaped}(?![.\\w])`, 'g');
  matcher.lastIndex = previousIndex + 1;
  return matcher.exec(diagnostics)?.index ?? -1;
}

async function compileWrongArchitecture(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  let args: string[];
  if (Deno.build.os === 'darwin' && Deno.build.arch === 'aarch64') {
    args = ['-arch', 'x86_64', '-dynamiclib', sourcePath, '-o', outputPath];
  } else if (Deno.build.os === 'darwin' && Deno.build.arch === 'x86_64') {
    args = ['-arch', 'arm64', '-dynamiclib', sourcePath, '-o', outputPath];
  } else if (Deno.build.os === 'linux' && Deno.build.arch === 'x86_64') {
    args = [
      '--target=aarch64-linux-gnu',
      '-nostdlib',
      '-shared',
      '-fuse-ld=lld',
      sourcePath,
      '-o',
      outputPath,
    ];
  } else if (Deno.build.os === 'linux' && Deno.build.arch === 'aarch64') {
    args = [
      '--target=x86_64-linux-gnu',
      '-nostdlib',
      '-shared',
      '-fuse-ld=lld',
      sourcePath,
      '-o',
      outputPath,
    ];
  } else {
    throw new Error(
      `No wrong-architecture fixture recipe for ${Deno.build.os}/${Deno.build.arch}`,
    );
  }

  const output = await boundedCommand(
    'clang',
    {
      args,
      stdout: 'piped',
      stderr: 'piped',
    },
    `compile wrong-architecture fixture for ${Deno.build.os}/${Deno.build.arch}`,
  );
  const stderr = new TextDecoder().decode(output.stderr).trim();
  assertEquals(
    output.code,
    0,
    `wrong-architecture fixture compilation is required:\n${stderr}`,
  );
}

Deno.test('loader rejects an unset LMDB_LIB_PATH', async () => {
  const error = expectError(
    await probe({
      args: ['load-env'],
      allowEnv: true,
      allowFfi: true,
    }),
  );
  assertMatch(errorText(error), /LMDB_LIB_PATH/);
  assertMatch(errorText(error), /auto|path/i);
});

Deno.test('loader-only probing accepts path-scoped FFI permission', async () => {
  const path = installedLibraryPath();
  const result = await probe({
    args: ['load-env'],
    env: { LMDB_LIB_PATH: path },
    allowEnv: true,
    allowFfi: path,
  });

  assertEquals(result.ok, true);
  assertEquals(result.path, path);
  assertEquals(result.version, {
    versionString: 'LMDB 1.0.0: (June 30, 2026)',
    major: 1,
    minor: 0,
    patch: 0,
  });
});

Deno.test('normal Env construction explains unrestricted FFI permission', async () => {
  const path = installedLibraryPath();
  const error = expectError(
    await probe({
      args: ['construct-env'],
      env: { LMDB_LIB_PATH: path },
      allowEnv: true,
      allowFfi: path,
    }),
  );

  assertEquals(hasErrorName(error, 'NotCapable'), true);
  assertMatch(errorText(error), /requires ffi access/i);
  assertMatch(errorText(error), /--allow-ffi/);
});

Deno.test('auto detection returns the exact architecture-prioritized probes', async () => {
  const expected = expectedAutoCandidates();
  const result = await probe({ args: ['resolve', 'auto'] });
  assertEquals(result, { ok: true, candidates: expected });
});

Deno.test('auto detection consumes candidates and reports every attempted path', async () => {
  const candidates = expectedAutoCandidates();
  const installedCandidate = findInstalledAutoCandidate(candidates);
  const result = await probe({
    args: ['load-env'],
    env: { LMDB_LIB_PATH: 'auto' },
    allowEnv: true,
    allowFfi: true,
  });

  if (installedCandidate !== undefined) {
    assertEquals(result.ok, true);
    assertEquals(result.path, installedCandidate);
    assertEquals(result.version, {
      versionString: 'LMDB 1.0.0: (June 30, 2026)',
      major: 1,
      minor: 0,
      patch: 0,
    });
    return;
  }

  const error = expectError(result);
  const diagnostics = errorText(error);
  let previousIndex = -1;
  for (const candidate of candidates) {
    const index = findExactPathAfter(diagnostics, candidate, previousIndex);
    assert(
      index > previousIndex,
      `auto diagnostics omitted or reordered ${candidate}:\n${diagnostics}`,
    );
    previousIndex = index;
  }
});

Deno.test('loader preserves a missing environment permission error', async () => {
  const error = expectError(
    await probe({
      args: ['load-env'],
      allowFfi: true,
    }),
  );
  assertEquals(hasErrorName(error, 'NotCapable'), true);
  assertMatch(errorText(error), /LMDB_LIB_PATH/);
});

Deno.test('loader preserves a missing FFI permission error', async () => {
  const path = installedLibraryPath();
  const error = expectError(
    await probe({
      args: ['load-env'],
      env: { LMDB_LIB_PATH: path },
      allowEnv: true,
    }),
  );
  assertEquals(hasErrorName(error, 'NotCapable'), true);
  assertMatch(errorText(error), /ffi|dlopen/i);
  assertMatch(errorText(error), new RegExp(path.replaceAll('/', '\\/')));
});

Deno.test('loader reports an explicit nonexistent library path', async () => {
  await withTempDir(async (path) => {
    const missing = `${path}/missing-lmdb.dylib`;
    const error = expectError(
      await probe({
        args: ['load-env'],
        env: { LMDB_LIB_PATH: missing },
        allowEnv: true,
        allowFfi: missing,
      }),
    );
    assertMatch(errorText(error), /missing-lmdb\.dylib/);
    assertMatch(errorText(error), /not found|No such file/i);
  });
});

Deno.test('loader rejects a loadable library without mdb_version', async () => {
  await withTempDir(async (path) => {
    const fixture = `${path}/not-lmdb${
      Deno.build.os === 'darwin' ? '.dylib' : '.so'
    }`;
    await compileFixture('not_lmdb.c', fixture);
    const error = expectError(
      await probe({
        args: ['load-env'],
        env: { LMDB_LIB_PATH: fixture },
        allowEnv: true,
        allowFfi: fixture,
      }),
    );
    assertMatch(errorText(error), /not-lmdb/);
    assertMatch(errorText(error), /mdb_version/);
  });
});

Deno.test('loader rejects a library for the wrong architecture', async () => {
  await withTempDir(async (path) => {
    const source = `${NATIVE_FIXTURE_PATH}wrong_architecture.c`;
    const fixture = `${path}/wrong-architecture${
      Deno.build.os === 'darwin' ? '.dylib' : '.so'
    }`;
    await compileWrongArchitecture(source, fixture);
    assert(
      (await Deno.stat(fixture)).isFile,
      'wrong-architecture fixture is missing',
    );

    const error = expectError(
      await probe({
        args: ['load-env'],
        env: { LMDB_LIB_PATH: fixture },
        allowEnv: true,
        allowFfi: fixture,
      }),
    );
    const diagnostics = errorChain(error)
      .map(({ name, message }) =>
        `${name}: ${message.replaceAll(fixture, '<fixture>')}`
      )
      .join('\ncaused by ');
    if (Deno.build.os === 'darwin') {
      assertMatch(
        diagnostics,
        /bad cpu type|mach-o[^\n]*(?:incompatible|architecture)|incompatible[^\n]*architecture/i,
      );
    } else {
      assertMatch(
        diagnostics,
        /wrong elf|elfclass|elf[^\n]*machine|machine[^\n]*elf|cannot open shared object file/i,
      );
    }
  });
});

Deno.test('loader rejects LMDB 0.9.35 and names both versions', async () => {
  await withTempDir(async (path) => {
    const fixture = `${path}/wrong-version${
      Deno.build.os === 'darwin' ? '.dylib' : '.so'
    }`;
    await compileFixture('wrong_version.c', fixture);
    const error = expectError(
      await probe({
        args: ['load-env'],
        env: { LMDB_LIB_PATH: fixture },
        allowEnv: true,
        allowFfi: fixture,
      }),
    );
    const text = errorText(error);
    assert(text.includes(fixture), `diagnostic omitted ${fixture}:\n${text}`);
    assertMatch(text, /expected LMDB 1\.0\.0/i);
    assertMatch(text, /reports LMDB 0\.9\.35/i);
  });

  const legacy = '/opt/homebrew/opt/lmdb/lib/liblmdb.dylib';
  let legacyExists = false;
  try {
    legacyExists = (await Deno.stat(legacy)).isFile;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (Deno.build.os === 'darwin' && legacyExists) {
    const result = await probe({
      args: ['load-env'],
      env: { LMDB_LIB_PATH: legacy },
      allowEnv: true,
      allowFfi: legacy,
    });
    const diagnostics = errorText(expectError(result));
    assert(
      diagnostics.includes(legacy),
      `diagnostic omitted ${legacy}:\n${diagnostics}`,
    );
    assertMatch(diagnostics, /0\.9\.35.*expected LMDB 1\.0\.0/i);
  }
});
