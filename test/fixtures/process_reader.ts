import { hex } from '../_support/bytes.ts';
import type { DbiContract, TxnContract } from '../_support/contract.ts';
import { withCleanup } from '../_support/lifecycle.ts';
import { loadSubject } from '../_support/subject.ts';

const [path, dbName, key, expectedHex] = Deno.args;
if (!path || !dbName || !key || !expectedHex) {
  throw new Error(
    'Usage: process_reader.ts <path> <db-name> <key> <expected-hex>',
  );
}

const { Env } = await loadSubject();
const env = new Env();
let dbi: DbiContract | undefined;
let txn: TxnContract | undefined;

await withCleanup(
  () => {
    env.open({
      path,
      maxDbs: 10,
      mapSize: 256 * 1024 * 1024,
      maxReaders: 126,
      readOnly: true,
    });
    dbi = env.openDbi({ name: dbName });
    txn = env.beginTxn({ readOnly: true });
    const value = txn.getBinary(dbi, key);
    if (value === null) throw new Error(`Missing value for ${key}`);

    const actualHex = hex(value);
    if (actualHex !== expectedHex) {
      throw new Error(`Expected ${expectedHex}, received ${actualHex}`);
    }
    console.log(actualHex);
  },
  [() => txn?.abort(), () => dbi?.close(), () => env.close()],
);
