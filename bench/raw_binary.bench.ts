import {
  createDataset,
  openDenoLmdbStore,
  openLmdbJsStore,
  type RawBinaryStore,
} from './raw_binary_workloads.ts';

const MAP_SIZE = 64 * 1024 * 1024;
const RECORD_COUNT = 10_000;
const VALUE_SIZE = 256;
const READ_BATCH_SIZE = 1_024;
const WRITE_BATCH_SIZE = 1_000;

const initial = createDataset(RECORD_COUNT, VALUE_SIZE, 0);
const overwriteA = createDataset(WRITE_BATCH_SIZE, VALUE_SIZE, 1);
const overwriteB = createDataset(WRITE_BATCH_SIZE, VALUE_SIZE, 2);
const readKeys = Array.from(
  { length: READ_BATCH_SIZE },
  (_, index) => initial[(index * 7_919) % RECORD_COUNT].key,
);

const root = await Deno.makeTempDir({ prefix: 'deno-lmdb-bench-' });
const stores: RawBinaryStore[] = [];

const safeRead = {
  deno: prepare(openDenoLmdbStore, 'safe-read-deno'),
  lmdbJs: prepare(openLmdbJsStore, 'safe-read-lmdb-js'),
};
const unsafeRead = {
  deno: prepare(openDenoLmdbStore, 'unsafe-read-deno'),
  lmdbJs: prepare(openLmdbJsStore, 'unsafe-read-lmdb-js'),
};
const writes = {
  deno: prepare(openDenoLmdbStore, 'write-deno'),
  lmdbJs: prepare(openLmdbJsStore, 'write-lmdb-js'),
};
const scans = {
  deno: prepare(openDenoLmdbStore, 'scan-deno'),
  lmdbJs: prepare(openLmdbJsStore, 'scan-lmdb-js'),
};

let sink = 0;

Deno.bench({
  name: 'deno-lmdb safe reads',
  group: `safe binary point read x ${READ_BATCH_SIZE}`,
  baseline: true,
  fn() {
    sink ^= readSafeBatch(safeRead.deno, readKeys);
  },
});

Deno.bench({
  name: 'npm:lmdb safe reads',
  group: `safe binary point read x ${READ_BATCH_SIZE}`,
  fn() {
    sink ^= readSafeBatch(safeRead.lmdbJs, readKeys);
  },
});

Deno.bench({
  name: 'deno-lmdb zero-copy reads',
  group: `zero-copy binary point read x ${READ_BATCH_SIZE}`,
  baseline: true,
  fn() {
    sink ^= readUnsafeBatch(unsafeRead.deno, readKeys);
  },
});

Deno.bench({
  name: 'npm:lmdb fast reads',
  group: `zero-copy binary point read x ${READ_BATCH_SIZE}`,
  fn() {
    sink ^= readUnsafeBatch(unsafeRead.lmdbJs, readKeys);
  },
});

registerWriteBench('deno-lmdb transactional overwrites', writes.deno, true);
registerWriteBench('npm:lmdb transactional overwrites', writes.lmdbJs, false);

Deno.bench({
  name: 'deno-lmdb ordered scan',
  group: `ordered binary scan x ${RECORD_COUNT}`,
  baseline: true,
  n: 20,
  warmup: 3,
  fn() {
    const observation = scans.deno.scan();
    sink ^= observation.count ^ observation.checksum;
  },
});

Deno.bench({
  name: 'npm:lmdb ordered scan',
  group: `ordered binary scan x ${RECORD_COUNT}`,
  n: 20,
  warmup: 3,
  fn() {
    const observation = scans.lmdbJs.scan();
    sink ^= observation.count ^ observation.checksum;
  },
});

addEventListener('unload', () => {
  for (const store of stores.reverse()) {
    try {
      void store.close();
    } catch (error) {
      console.error('benchmark store cleanup failed', error);
    }
  }
  try {
    Deno.removeSync(root, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error('benchmark directory cleanup failed', error);
    }
  }
});

function prepare(
  opener: (path: string, mapSize: number) => RawBinaryStore,
  name: string,
): RawBinaryStore {
  const store = opener(`${root}/${name}`, MAP_SIZE);
  stores.push(store);
  store.writeBatch(initial);
  return store;
}

function readSafeBatch(
  store: RawBinaryStore,
  keys: readonly Uint8Array[],
): number {
  let checksum = 0;
  for (const key of keys) {
    const value = store.readSafe(key);
    if (value === null) throw new Error('safe benchmark read missed a key');
    checksum = Math.imul(checksum ^ value[0], 16777619) >>> 0;
  }
  return checksum;
}

function readUnsafeBatch(
  store: RawBinaryStore,
  keys: readonly Uint8Array[],
): number {
  let checksum = 0;
  for (const key of keys) {
    const value = store.readUnsafe(key);
    if (value === null) throw new Error('unsafe benchmark read missed a key');
    checksum = Math.imul(checksum ^ value[0], 16777619) >>> 0;
  }
  return checksum;
}

function registerWriteBench(
  name: string,
  store: RawBinaryStore,
  baseline: boolean,
): void {
  let sample = 0;
  Deno.bench({
    name,
    group: `transactional binary overwrite x ${WRITE_BATCH_SIZE}`,
    baseline,
    n: 10,
    warmup: 3,
    fn() {
      const records = sample++ % 2 === 0 ? overwriteA : overwriteB;
      store.writeBatch(records);
      sink ^= sample;
    },
  });
}
