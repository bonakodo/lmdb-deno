import {
  deepStrictEqual as assertEquals,
  strictEqual as assertStrictEquals,
} from 'node:assert/strict';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';
import { loadLibrary } from '../src/native/library.ts';
import { lmdbSymbols } from '../src/native/symbols.ts';

const PINNED_HEADER_SHA256 =
  'b9267c09ade0147e224316d0195c8ee3e9b8cc130ba196fad020bccb7b1cd043';
const PROJECT_PATH = new URL('../', import.meta.url).pathname;
const HEADER_PATH = new URL('../native/lmdb.h', import.meta.url).pathname;
const ORACLE_PATH = new URL(
  './fixtures/native/lmdb_abi.c',
  import.meta.url,
).pathname;

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

function toHex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

Deno.test('vendored ABI reference is the exact LMDB 1.0.0 header', async () => {
  const header = await Deno.readFile(HEADER_PATH);
  const digest = await crypto.subtle.digest('SHA-256', header);
  assertStrictEquals(toHex(digest), PINNED_HEADER_SHA256);
});

Deno.test('native ABI matches the audited LMDB 1.0.0 layout', async () => {
  await withTempDir(async (path) => {
    const executable = `${path}/lmdb-abi`;
    const compile = await boundedCommand(
      'cc',
      {
        args: [
          '-std=c11',
          '-I',
          `${PROJECT_PATH}native`,
          ORACLE_PATH,
          '-o',
          executable,
        ],
        stdout: 'piped',
        stderr: 'piped',
      },
      'compile LMDB ABI oracle',
    );
    const compileError = new TextDecoder().decode(compile.stderr);
    assertStrictEquals(
      compile.code,
      0,
      `LMDB ABI oracle compilation failed:\n${compileError}`,
    );

    const run = await boundedCommand(
      executable,
      { stdout: 'piped', stderr: 'piped' },
      'run LMDB ABI oracle',
    );
    const stderr = new TextDecoder().decode(run.stderr);
    assertStrictEquals(run.code, 0, `LMDB ABI oracle failed:\n${stderr}`);
    assertStrictEquals(stderr, '');
    const stdout = new TextDecoder().decode(run.stdout).trim();
    assertStrictEquals(stdout.split('\n').length, 1);

    assertEquals(JSON.parse(stdout), {
      pointer: 8,
      mdbSize: 8,
      dbi: 4,
      val: [16, 0, 8],
      stat: [40, 0, 4, 8, 16, 24, 32],
      envinfo: [40, 0, 8, 16, 24, 32, 36],
      prevSnapshot: 0x02000000,
      errors: [
        -30799,
        -30798,
        -30781,
        -30778,
        -30774,
        -30773,
        -30771,
        -30770,
        -30769,
      ],
    });
  });
});

Deno.test('LMDB 1.0.0 exports the complete imported common symbol subset', () => {
  const path = Deno.env.get('LMDB_LIB_PATH');
  if (!path) throw new Error('LMDB_LIB_PATH is required by ABI tests');
  const library = loadLibrary(path);
  try {
    assertEquals(
      Object.keys(library.handle.symbols).sort(),
      Object.keys(lmdbSymbols).sort(),
    );
  } finally {
    library.handle.close();
  }
});
