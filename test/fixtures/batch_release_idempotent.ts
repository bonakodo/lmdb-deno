import {
  prepareBatch,
  releasePreparedBatch,
} from '../../src/batch/executor.ts';
import { Env } from '../../src/env.ts';
import { getNativeBindingCounts } from '../../src/internal/native_test_access.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected environment path');

const env = new Env();
env.open({ path, useWorker: false });
const dbi = env.openDbi({ name: null, create: true });
const baseline = getNativeBindingCounts(env).batchDbiLeases;
const prepared = prepareBatch(
  env,
  [[dbi, 'key', new Uint8Array([1])]],
  {},
);
if (getNativeBindingCounts(env).batchDbiLeases !== baseline + 1) {
  throw new Error('Batch lease was not acquired exactly once');
}

releasePreparedBatch(prepared);
if (getNativeBindingCounts(env).batchDbiLeases !== baseline) {
  throw new Error('Batch lease count did not return to baseline');
}
dbi.close();
env.close();

releasePreparedBatch(prepared);
releasePreparedBatch(prepared);
releasePreparedBatch(prepared);
console.log('batch-release-idempotent-ok');
