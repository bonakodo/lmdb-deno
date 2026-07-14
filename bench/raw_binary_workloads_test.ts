import { assertEquals } from '../test/_support/assertions.ts';
import { withTempDir } from '../test/_support/fixtures.ts';
import { withCleanup } from '../test/_support/lifecycle.ts';
import {
  createDataset,
  expectedScan,
  openDenoLmdbStore,
  openLmdbJsStore,
  type RawBinaryStore,
} from './raw_binary_workloads.ts';

const MAP_SIZE = 16 * 1024 * 1024;

Deno.test('raw binary benchmark stores execute equivalent workloads', async () => {
  await withTempDir(async (root) => {
    const initial = createDataset(8, 32, 0);
    const replacement = createDataset(8, 32, 1);
    const stores: RawBinaryStore[] = [];

    await withCleanup(
      () => {
        stores.push(
          openDenoLmdbStore(`${root}/deno-lmdb`, MAP_SIZE),
          openLmdbJsStore(`${root}/lmdb-js`, MAP_SIZE),
        );

        for (const store of stores) {
          store.writeBatch(initial);
          assertBytes(store.readSafe(initial[3].key), initial[3].value);
          assertBytes(
            store.readUnsafe(initial[5].key),
            initial[5].value,
            false,
          );
          assertEquals(store.scan(), expectedScan(initial));

          store.writeBatch(replacement);
          assertBytes(
            store.readSafe(replacement[3].key),
            replacement[3].value,
          );
          assertEquals(store.scan(), expectedScan(replacement));
        }
      },
      [async () => {
        for (const store of stores.reverse()) await store.close();
      }],
    );
  });
});

function assertBytes(
  actual: Uint8Array | null,
  expected: Uint8Array,
  exactLength = true,
): void {
  if (actual === null) throw new Error('expected binary value');
  if (
    exactLength
      ? actual.byteLength !== expected.byteLength
      : actual.byteLength < expected.byteLength
  ) {
    throw new Error(
      `unexpected binary length ${actual.byteLength} for ${expected.byteLength} bytes`,
    );
  }
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `binary byte ${index} was ${actual[index]}, expected ${
          expected[index]
        }`,
      );
    }
  }
}
