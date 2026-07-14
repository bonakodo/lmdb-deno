import { Env } from '../../mod.ts';

const MDB_NOTFOUND = -30798;
const [path, mode] = Deno.args;

if (!path || (mode !== 'abort' && mode !== 'continue')) {
  throw new Error('Expected a path and an abort or continue mode');
}

const env = new Env();
let dbi: ReturnType<Env['openDbi']> | undefined;
let txn: ReturnType<Env['beginTxn']> | undefined;

try {
  env.open({ path, maxDbs: 10 });
  txn = env.beginTxn();

  let openError: unknown;
  try {
    env.openDbi({ name: 'missing', txn });
  } catch (error) {
    openError = error;
  }
  if (!(openError instanceof Error)) {
    throw new Error('Expected opening a missing database to fail');
  }
  if ((openError as Error & { code?: number }).code !== MDB_NOTFOUND) {
    throw openError;
  }

  if (mode === 'continue') {
    dbi = env.openDbi({ name: 'created-after-failure', create: true, txn });
    txn.putString(dbi, 'key', 'value');
    txn.commit();
    txn = undefined;

    txn = env.beginTxn({ readOnly: true });
    if (txn.getString(dbi, 'key') !== 'value') {
      throw new Error('Caller-owned transaction did not remain usable');
    }
  }

  txn.abort();
  txn = undefined;
  console.log(`${mode}-ok`);
} finally {
  txn?.abort();
  dbi?.close();
  env.close();
}
