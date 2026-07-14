import { dirname, join } from 'node:path';
import {
  deepStrictEqual,
  match,
  notStrictEqual,
  ok,
  strictEqual,
} from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  type BatchCallback,
  type BatchOperationInput,
  Cursor,
  Env,
} from '../mod.ts';
import { fromHex, type SemanticObservation } from '../compat/deno/common.ts';
import { executeSemanticScenarios } from '../compat/semantic_runner.mjs';
import { withCleanup, withDeadline } from './_support/lifecycle.ts';
import { terminateChildren, trackChild } from './_support/process.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPAT_DIR = join(ROOT, 'compat');
const NODE_DIR = join(COMPAT_DIR, 'node');
const SCENARIOS_PATH = join(COMPAT_DIR, 'scenarios.json');
const NODE_ORACLE = join(NODE_DIR, 'oracle.mjs');
const DENO_ORACLE = join(COMPAT_DIR, 'deno', 'oracle.ts');
const TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const NODE_LTS_VERSION = '22.23.1';

interface SemanticScenarios {
  schemaVersion: 2;
  environment: { mapSize: number; maxDbs: number };
  values: {
    strings: Array<{ key: string; value: string }>;
    numbers: Array<{ key: string; value: string }>;
    booleans: Array<{ key: string; value: boolean }>;
    binaries: Array<{ key: string; value: string }>;
  };
  keyModes: {
    strings: Array<{ key: string; value: string }>;
    uint32: Array<{ key: number; value: string }>;
    binaries: Array<{ key: string; value: string }>;
  };
  duplicates: {
    key: string;
    values: string[];
    fixedKey: string;
    fixedValues: string[];
  };
  batch: {
    expectedResults: number[];
    seed: Array<{ key: string; value: string }>;
    operations: Array<Record<string, unknown>>;
  };
  errors: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

Deno.test('Node oracle is Node 22.23.1 LTS and lock-pinned to node-lmdb 0.10.1', async () => {
  const node = await requireNodeLts();
  const version = await runCommand(node, ['--version'], ROOT, 'Node version');
  strictEqual(version.code, 0);
  strictEqual(version.stdout.trim(), `v${NODE_LTS_VERSION}`);

  const packageJson = JSON.parse(
    await Deno.readTextFile(join(NODE_DIR, 'package.json')),
  );
  deepStrictEqual(packageJson, {
    private: true,
    type: 'module',
    engines: { node: NODE_LTS_VERSION },
    dependencies: { 'node-lmdb': '0.10.1' },
  });

  const lock = JSON.parse(
    await Deno.readTextFile(join(NODE_DIR, 'package-lock.json')),
  );
  strictEqual(lock.lockfileVersion, 3);
  deepStrictEqual(lock.packages[''].dependencies, { 'node-lmdb': '0.10.1' });
  strictEqual(lock.packages[''].engines.node, NODE_LTS_VERSION);
  const lmdb = lock.packages['node_modules/node-lmdb'];
  strictEqual(lmdb.version, '0.10.1');
  strictEqual(
    lmdb.resolved,
    'https://registry.npmjs.org/node-lmdb/-/node-lmdb-0.10.1.tgz',
  );
  strictEqual(
    lmdb.integrity,
    'sha512-hrao55cGl/gp0ybJa0bH8P28DeDoi2V1gWvwXcdPClO1YFymnqIOL3qmDqIjbVQViE7c5XwGHb4/sacmYZMK0A==',
  );

  for (
    const [path, entry] of Object.entries<Record<string, unknown>>(
      lock.packages,
    )
  ) {
    strictEqual('link' in entry, false, `${path || '<root>'} is linked`);
    const resolved = 'resolved' in entry ? String(entry.resolved) : '';
    ok(!/^(?:file:|link:)|(?:^|\/)\.\.\//.test(resolved));
  }
});

Deno.test('semantic scenario manifest covers values cursors duplicates batches and errors', async () => {
  const scenarios = await readScenarios();
  strictEqual(scenarios.schemaVersion, 2);
  deepStrictEqual(scenarios.environment, {
    mapSize: 16 * 1024 * 1024,
    maxDbs: 10,
  });
  deepStrictEqual(
    scenarios.values.numbers.map(({ value }) => value),
    ['0', '-0', '-12345.625', 'NaN', 'Infinity', '-Infinity'],
  );
  ok(scenarios.values.strings.some(({ value }) => value.includes('\0')));
  deepStrictEqual(
    scenarios.values.booleans.map(({ value }) => value),
    [true, false],
  );
  deepStrictEqual(
    scenarios.values.binaries.map(({ value }) => value),
    ['', '00', '0001ff'],
  );
  deepStrictEqual(scenarios.keyModes, {
    strings: [
      { key: 'alpha', value: 'string key alpha' },
      { key: 'omega', value: 'string key omega' },
    ],
    uint32: [
      { key: 0, value: 'uint32 zero' },
      { key: 42, value: 'uint32 forty-two' },
      { key: 0xFFFF_FFFF, value: 'uint32 max' },
    ],
    binaries: [
      { key: '00', value: 'binary key zero' },
      { key: '0001ff', value: 'binary key bytes' },
    ],
  });
  ok(scenarios.duplicates.values.length >= 3);
  ok(scenarios.duplicates.fixedValues.length >= 3);
  ok(
    scenarios.duplicates.fixedValues.every((value) =>
      value.length === scenarios.duplicates.fixedValues[0].length
    ),
  );
  ok(scenarios.batch.seed.length > 0);
  ok(scenarios.batch.operations.length >= 3);
  deepStrictEqual(scenarios.batch.expectedResults, [0, 1, 2, 0]);
  deepStrictEqual(scenarios.errors, [
    'missing-database',
    'read-only-write',
    'duplicate-key',
  ]);
});

Deno.test('semantic runner invokes batchWrite with only a final callback', async () => {
  class FinalOnlyBatchEnv extends Env {
    override batchWrite(...args: unknown[]): void {
      strictEqual(args.length, 2);
      const [operations, finalCallback] = args;
      ok(Array.isArray(operations));
      strictEqual(typeof finalCallback, 'function');
      super.batchWrite(
        operations as BatchOperationInput[],
        finalCallback as BatchCallback,
      );
    }
  }

  const databasePath = await Deno.makeTempDir({
    prefix: 'deno-lmdb-semantic-final-only-',
  });
  await withCleanup(
    async () => {
      const observation = await executeSemanticScenarios(
        { Env: FinalOnlyBatchEnv, Cursor, bytes: fromHex },
        databasePath,
        await readScenarios(),
      ) as SemanticObservation;
      deepStrictEqual(observation.batch, {
        results: [0, 1, 2, 0],
        callbackOrder: ['final'],
      });
    },
    [() => Deno.remove(databasePath, { recursive: true })],
  );
});

Deno.test('Node and Deno emit identical normalized API observations', async () => {
  const node = await requireNodeLts();
  await requireInstalledOracle();
  const nodeDatabase = await Deno.makeTempDir({
    prefix: 'deno-lmdb-semantic-node-',
  });
  let denoDatabase: string;
  try {
    denoDatabase = await Deno.makeTempDir({
      prefix: 'deno-lmdb-semantic-deno-',
    });
  } catch (error) {
    await Deno.remove(nodeDatabase, { recursive: true });
    throw error;
  }
  notStrictEqual(nodeDatabase, denoDatabase);

  await withCleanup(
    async () => {
      const nodeObservation = await runOracle(
        node,
        nodeOracleArguments(nodeDatabase),
        NODE_DIR,
        'Node semantic oracle',
      );
      const denoObservation = await runOracle(
        Deno.execPath(),
        denoOracleArguments(denoDatabase),
        ROOT,
        'Deno semantic oracle',
      );
      deepStrictEqual(nodeObservation.errors, [
        { operation: 'missing-database', name: 'Error', code: -30798 },
        { operation: 'read-only-write', name: 'Error', code: 13 },
        { operation: 'duplicate-key', name: 'Error', code: -30799 },
      ]);
      deepStrictEqual(nodeObservation.batch, {
        results: [0, 1, 2, 0],
        callbackOrder: ['final'],
      });
      deepStrictEqual(nodeObservation.keyValues, {
        strings: [
          { key: 'alpha', value: utf16LeHex('string key alpha') },
          { key: 'omega', value: utf16LeHex('string key omega') },
        ],
        uint32: [
          { key: 0, value: utf16LeHex('uint32 zero') },
          { key: 42, value: utf16LeHex('uint32 forty-two') },
          { key: 0xFFFF_FFFF, value: utf16LeHex('uint32 max') },
        ],
        binaries: [
          { key: '00', value: utf16LeHex('binary key zero') },
          { key: '0001ff', value: utf16LeHex('binary key bytes') },
        ],
      });
      deepStrictEqual(denoObservation, nodeObservation);
    },
    [
      () => Deno.remove(nodeDatabase, { recursive: true }),
      () => Deno.remove(denoDatabase, { recursive: true }),
    ],
  );
});

Deno.test('semantic oracle uses distinct database paths and makes no file-format claim', async () => {
  const nodeDatabase = '/node-runtime-own-database';
  const denoDatabase = '/deno-runtime-own-database';
  const nodeArgs = nodeOracleArguments(nodeDatabase);
  const denoArgs = denoOracleArguments(denoDatabase);

  deepStrictEqual(nodeArgs, [NODE_ORACLE, nodeDatabase, SCENARIOS_PATH]);
  ok(!nodeArgs.includes(denoDatabase));
  ok(denoArgs.includes(DENO_ORACLE));
  ok(denoArgs.includes(denoDatabase));
  ok(!denoArgs.includes(nodeDatabase));

  for (
    const path of [
      NODE_ORACLE,
      join(NODE_DIR, 'common.mjs'),
      DENO_ORACLE,
      join(COMPAT_DIR, 'deno', 'common.ts'),
      join(COMPAT_DIR, 'semantic_runner.mjs'),
    ]
  ) {
    const source = await Deno.readTextFile(path);
    match(source, /scenario(?:s|Path)/);
    ok(
      !/(?:read|write)\.(?:mjs|ts)|data\.mdb|lock\.mdb|readDatabase|writeDatabase/
        .test(
          source,
        ),
    );
    ok(!/(?:node|deno|other)Database/.test(source));
    ok(!/file[- ]format|cross[- ]open|handoff/i.test(source));
  }
  match(await Deno.readTextFile(NODE_ORACLE), /databasePath/);
  match(await Deno.readTextFile(DENO_ORACLE), /databasePath/);
  for (
    const removed of [
      join(COMPAT_DIR, 'node', 'read.mjs'),
      join(COMPAT_DIR, 'node', 'write.mjs'),
      join(COMPAT_DIR, 'deno', 'read.ts'),
      join(COMPAT_DIR, 'deno', 'write.ts'),
    ]
  ) {
    await assertNotFound(removed);
  }
});

Deno.test('compatibility oracle exposes only compat names', async () => {
  const config = JSON.parse(await Deno.readTextFile(join(ROOT, 'deno.json')));
  ok('compat:bootstrap' in config.tasks);
  ok('test:compat' in config.tasks);
  strictEqual('interop:bootstrap' in config.tasks, false);
  strictEqual('test:interop' in config.tasks, false);
  await Deno.stat(join(ROOT, 'compat', 'scenarios.json'));
  await assertNotFound(join(ROOT, 'interop'));
});

async function readScenarios(): Promise<SemanticScenarios> {
  return JSON.parse(await Deno.readTextFile(SCENARIOS_PATH));
}

async function requireInstalledOracle(): Promise<void> {
  try {
    await Deno.stat(
      join(NODE_DIR, 'node_modules', 'node-lmdb', 'package.json'),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      'node-lmdb oracle is not installed; run `deno task compat:bootstrap` with Node.js 22.23.1 LTS first',
    );
  }
}

function requireNodeLts(): string {
  const node = Deno.env.get('NODE_LTS_BIN');
  if (node === undefined || node.length === 0) {
    throw new Error(
      'NODE_LTS_BIN must name a Node.js 22.23.1 LTS executable',
    );
  }
  return node;
}

function nodeOracleArguments(databasePath: string): string[] {
  return [NODE_ORACLE, databasePath, SCENARIOS_PATH];
}

function denoOracleArguments(databasePath: string): string[] {
  return [
    'run',
    '--quiet',
    '--allow-env=LMDB_LIB_PATH',
    '--allow-ffi',
    '--allow-read',
    '--allow-write',
    DENO_ORACLE,
    databasePath,
    SCENARIOS_PATH,
  ];
}

async function runOracle(
  command: string,
  args: string[],
  cwd: string,
  operation: string,
): Promise<SemanticObservation> {
  const result = await runCommand(command, args, cwd, operation);
  strictEqual(
    result.code,
    0,
    `${operation} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  strictEqual(result.stderr, '', `${operation} wrote to stderr`);
  const lines = result.stdout.trim().split('\n');
  strictEqual(lines.length, 1, `${operation} must emit exactly one JSON line`);
  const observation: SemanticObservation = JSON.parse(lines[0]);
  strictEqual(observation.schemaVersion, 2);
  return observation;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  operation: string,
): Promise<CommandResult> {
  const record = trackChild(
    new Deno.Command(command, {
      args,
      cwd,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn(),
  );
  const output = await withCleanup(
    () => withDeadline(record.output, TIMEOUT_MS, operation),
    [
      () =>
        terminateChildren(
          [record],
          CLEANUP_TIMEOUT_MS,
          `${operation} cleanup`,
        ),
    ],
  );
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function assertNotFound(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`${path} must not exist`);
}

function utf16LeHex(value: string): string {
  const hex: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    hex.push(
      (codeUnit & 0xFF).toString(16).padStart(2, '0'),
      (codeUnit >>> 8).toString(16).padStart(2, '0'),
    );
  }
  return `${hex.join('')}0000`;
}
