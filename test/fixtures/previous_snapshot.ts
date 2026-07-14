import { Env } from '../../mod.ts';
import type { Dbi } from '../../src/dbi.ts';
import { getNativeEnvironmentDetails } from '../../src/internal/native_test_access.ts';

interface Observation {
  readonly changed: string | null;
  readonly removed: string | null;
  readonly added: string | null;
}

function observe(env: Env, db: Dbi): Observation {
  const txn = env.beginTxn({ readOnly: true });
  try {
    return {
      changed: txn.getString(db, 'changed'),
      removed: txn.getString(db, 'removed'),
      added: txn.getString(db, 'added'),
    };
  } finally {
    txn.abort();
  }
}

function closeAfterFailedOpen(env: Env): void {
  try {
    env.close();
  } catch (error) {
    if (!(error instanceof Error) || !/already closed/i.test(error.message)) {
      throw error;
    }
  }
}

function seed(path: string): Observation {
  const env = new Env();
  let db: Dbi | undefined;
  let txn: ReturnType<Env['beginTxn']> | undefined;
  try {
    env.open({ path });
    db = env.openDbi({ name: null, create: true });

    txn = env.beginTxn();
    txn.putString(db, 'changed', 'first');
    txn.putString(db, 'removed', 'present-only-in-first');
    txn.commit();
    txn = undefined;

    txn = env.beginTxn();
    txn.putString(db, 'changed', 'second');
    txn.del(db, 'removed');
    txn.putString(db, 'added', 'present-only-in-second');
    txn.commit();
    txn = undefined;

    return observe(env, db);
  } finally {
    txn?.abort();
    db?.close();
    env.close();
  }
}

function read(path: string, previous: boolean): Observation {
  const env = new Env();
  let db: Dbi | undefined;
  try {
    env.open({ path, usePreviousSnapshot: previous });
    db = env.openDbi({ name: null, create: false });
    return observe(env, db);
  } finally {
    db?.close();
    env.close();
  }
}

function readSharedPrevious(path: string): {
  readonly sameAddress: boolean;
  readonly previous: Observation;
  readonly shared: Observation;
} {
  const previousEnv = new Env();
  const sharedEnv = new Env();
  let previousDb: Dbi | undefined;
  let sharedDb: Dbi | undefined;
  try {
    previousEnv.open({ path, usePreviousSnapshot: true });
    sharedEnv.open({ path: `${path}/.` });
    previousDb = previousEnv.openDbi({ name: null, create: false });
    sharedDb = sharedEnv.openDbi({ name: null, create: false });
    return {
      sameAddress: getNativeEnvironmentDetails(previousEnv).address ===
        getNativeEnvironmentDetails(sharedEnv).address,
      previous: observe(previousEnv, previousDb),
      shared: observe(sharedEnv, sharedDb),
    };
  } finally {
    sharedDb?.close();
    previousDb?.close();
    sharedEnv.close();
    previousEnv.close();
  }
}

function commitFromPrevious(path: string): boolean {
  const env = new Env();
  let db: Dbi | undefined;
  let txn: ReturnType<Env['beginTxn']> | undefined;
  try {
    env.open({ path, usePreviousSnapshot: true });
    db = env.openDbi({ name: null, create: false });
    txn = env.beginTxn();
    txn.putString(db, 'changed', 'third');
    txn.commit();
    txn = undefined;
    return (getNativeEnvironmentDetails(env).flags & 0x02000000) !== 0;
  } finally {
    txn?.abort();
    db?.close();
    env.close();
  }
}

function commitPrevious(path: string): Observation & {
  readonly previousSnapshotFlag: boolean;
} {
  const previousSnapshotFlag = commitFromPrevious(path);
  return {
    ...read(path, false),
    previousSnapshotFlag,
  };
}

function probeInvalid(path: string): {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
} {
  const env = new Env();
  try {
    env.open({ path, usePreviousSnapshot: true });
    throw new Error('Expected invalid LMDB environment to be rejected');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      name: error.name,
      message: error.message,
      code: (error as Error & { code?: unknown }).code,
    };
  } finally {
    closeAfterFailedOpen(env);
  }
}

const mode = Deno.args[0];
const path = Deno.args[1];
if (!path) throw new Error('usage: previous_snapshot.ts MODE PATH');

let result: unknown;
switch (mode) {
  case 'seed':
    result = seed(path);
    break;
  case 'read-latest':
    result = read(path, false);
    break;
  case 'read-previous':
    result = read(path, true);
    break;
  case 'shared-previous':
    result = readSharedPrevious(path);
    break;
  case 'commit-previous':
    result = commitPrevious(path);
    break;
  case 'invalid':
    result = probeInvalid(path);
    break;
  default:
    throw new Error(`unknown previous-snapshot fixture mode: ${mode}`);
}

console.log(JSON.stringify(result));
