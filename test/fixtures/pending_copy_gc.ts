import { strictEqual } from 'node:assert/strict';
import { Env } from '../../mod.ts';
import {
  findSharedEnvironment,
  getLiveGenerationCountForTest,
} from '../../src/internal/native_state.ts';

const rootPath = Deno.args[0];
if (!rootPath) throw new Error('Expected a temporary root path');

const exposedGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (typeof exposedGc !== 'function') throw new Error('gc is not exposed');
const forceGc: () => void = exposedGc;

const sourcePath = `${rootPath}/source`;
const backupPaths = Array.from(
  { length: 8 },
  (_, index) => `${rootPath}/backup-${index}`,
);
await Deno.mkdir(sourcePath);
for (const path of backupPaths) await Deno.mkdir(path);

const baselineGenerations = getLiveGenerationCountForTest();
const value = new Uint8Array(1024 * 1024);
for (let index = 0; index < value.length; index++) {
  value[index] = (index * 31 + 0xa5) & 0xff;
}
const canonicalPath = Deno.realPathSync(sourcePath);
let copiesSettled = false;
const started = startEnvironmentCopies();
const copies = started.copies.finally(() => {
  copiesSettled = true;
});

let observedPendingFinalizer = false;
for (let attempt = 0; attempt < 200; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  forceGc();
  const state = findSharedEnvironment(canonicalPath);
  if (
    started.reference.deref() === undefined &&
    state?.refCount === 0 &&
    state.activeAsyncOperations > 0
  ) {
    strictEqual(copiesSettled, false);
    strictEqual(getLiveGenerationCountForTest(), baselineGenerations + 1);
    observedPendingFinalizer = true;
    break;
  }
  if (copiesSettled) break;
}
if (!observedPendingFinalizer) {
  const state = findSharedEnvironment(canonicalPath);
  throw new Error(
    `Did not observe pending finalizer: weak=${
      started.reference.deref() !== undefined
    }, settled=${copiesSettled}, refCount=${state?.refCount}, active=${state?.activeAsyncOperations}`,
  );
}

await copies;
for (let attempt = 0; attempt < 200; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  forceGc();
  if (
    findSharedEnvironment(canonicalPath) === undefined &&
    getLiveGenerationCountForTest() === baselineGenerations
  ) break;
}
strictEqual(findSharedEnvironment(canonicalPath), undefined);
strictEqual(getLiveGenerationCountForTest(), baselineGenerations);

const backup = new Env();
backup.open({ path: backupPaths[0], maxDbs: 2, readOnly: true });
const backupDbi = backup.openDbi({ name: 'data', create: false });
const read = backup.beginTxn({ readOnly: true });
strictEqual(
  read.getBinary(backupDbi, 'page-127')?.byteLength,
  value.byteLength,
);
strictEqual(read.getBinary(backupDbi, 'page-127')?.[0], value[0]);
strictEqual(
  read.getBinary(backupDbi, 'page-127')?.[value.byteLength - 1],
  value[value.byteLength - 1],
);
read.abort();
backupDbi.close();
backup.close();

console.log('pending-copy-gc-ok');

function startEnvironmentCopies(): {
  readonly reference: WeakRef<Env>;
  readonly copies: Promise<void[]>;
} {
  const owner = new Env();
  owner.open({
    path: sourcePath,
    maxDbs: 2,
    mapSize: 192 * 1024 * 1024,
  });
  const dbi = owner.openDbi({ name: 'data', create: true });
  const write = owner.beginTxn();
  for (let index = 0; index < 128; index++) {
    write.putBinary(dbi, `page-${index}`, value);
  }
  write.commit();
  dbi.close();

  const copies: Promise<void>[] = [];
  for (const path of backupPaths) copies.push(owner.copy(path));
  return {
    reference: new WeakRef(owner),
    copies: Promise.all(copies),
  };
}
