import { type LmdbSymbols, lmdbSymbols } from './symbols.ts';
import type { Version } from '../types.ts';

const EXPECTED_VERSION = Object.freeze({
  versionString: 'LMDB 1.0.0: (June 30, 2026)',
  major: 1,
  minor: 0,
  patch: 0,
});

const versionSymbols = {
  mdb_version: {
    parameters: ['buffer', 'buffer', 'buffer'],
    result: 'pointer',
  },
} as const satisfies Deno.ForeignLibraryInterface;

/** A validated LMDB dynamic library and its resolved path. */
export interface LoadedLibrary {
  readonly path: string;
  readonly handle: Deno.DynamicLibrary<LmdbSymbols>;
  readonly version: Version;
}

interface CandidateFailure {
  readonly path: string;
  readonly error: Error;
}

/**
 * Resolves an explicit library setting to the paths that may be probed.
 *
 * `auto` is deliberately restricted to deterministic paths below `/usr/lib`.
 * An explicit path is returned unchanged.
 */
export function resolveLibraryCandidates(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      'LMDB_LIB_PATH must be an explicit LMDB library path or the literal "auto".',
    );
  }

  if (value !== 'auto') return [value];

  const architectureCandidates = Deno.build.arch === 'aarch64'
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
    ...architectureCandidates,
    '/usr/lib/liblmdb.dylib',
  ];
}

/**
 * Loads and validates LMDB 1.0.0 from an explicit path or `LMDB_LIB_PATH`.
 *
 * A lightweight `mdb_version` probe is closed before the complete symbol table
 * is opened. The caller owns the returned handle and must eventually close it.
 */
export function loadLibrary(value?: string): LoadedLibrary {
  const configuredValue = value === undefined
    ? Deno.env.get('LMDB_LIB_PATH')
    : value;
  const candidates = resolveLibraryCandidates(configuredValue);
  const failures: CandidateFailure[] = [];

  for (const path of candidates) {
    try {
      const version = probeVersion(path);
      const handle = Deno.dlopen(path, lmdbSymbols);
      return { path, handle, version };
    } catch (error) {
      failures.push({ path, error: asError(error) });
    }
  }

  const diagnostics = failures
    .map(({ path, error }) => `- ${path}: ${error.name}: ${error.message}`)
    .join('\n');
  throw new Error(
    `Unable to load LMDB 1.0.0. Attempted paths:\n${diagnostics}`,
    { cause: failures[0]?.error },
  );
}

function probeVersion(path: string): Version {
  let probe: Deno.DynamicLibrary<typeof versionSymbols> | undefined;
  try {
    probe = Deno.dlopen(path, versionSymbols);
    const major = new Int32Array(1);
    const minor = new Int32Array(1);
    const patch = new Int32Array(1);
    probe.symbols.mdb_version(major, minor, patch);

    // Reading the returned pointer through UnsafePointerView requires
    // unrestricted FFI permission in Deno. The exact string is pinned from the
    // checksum-verified LMDB 1.0.0 header so path-scoped permissions remain
    // useful.
    const versionString = EXPECTED_VERSION.versionString;
    const version = {
      versionString,
      major: major[0],
      minor: minor[0],
      patch: patch[0],
    } as const;

    if (
      version.major !== EXPECTED_VERSION.major ||
      version.minor !== EXPECTED_VERSION.minor ||
      version.patch !== EXPECTED_VERSION.patch
    ) {
      throw new Error(
        `${path} reports LMDB ${version.major}.${version.minor}.${version.patch}; expected LMDB 1.0.0.`,
      );
    }

    return version;
  } finally {
    probe?.close();
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
