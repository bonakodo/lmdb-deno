import { assertEquals } from './_support/assertions.ts';
import { bytes } from './_support/bytes.ts';
import type {
  CursorContract,
  DbiContract,
  TxnContract,
} from './_support/contract.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

const EXPECTED_KEY = bytes('822285ee315d2b04');
const EXPECTED_VALUE = bytes(
  'ec65d632d9168c33350ed31a30848d01e95172931e90984c218ef6b08c1fa90a',
);

Deno.test('cursor keys can be converted to Uint8Array', async () => {
  const { Cursor, Env } = await loadSubject();

  await withTempDir((path) => {
    const env = new Env();
    let dbi: DbiContract | undefined;
    let setupTxn: TxnContract | undefined;
    let readTxn: TxnContract | undefined;
    let cursor: CursorContract<Uint8Array> | undefined;
    let callbackCount = 0;

    return withCleanup(
      () => {
        env.open({ path, maxDbs: 12, mapSize: 256 * 1024 * 1024 });
        dbi = env.openDbi({
          name: 'testkeys',
          create: true,
          keyIsBuffer: true,
        });
        setupTxn = env.beginTxn();
        setupTxn.putBinary(dbi, EXPECTED_KEY, EXPECTED_VALUE);
        setupTxn.commit();
        setupTxn = undefined;

        readTxn = env.beginTxn();
        cursor = new Cursor<Uint8Array>(readTxn, dbi);
        assertEquals(cursor.goToFirst(), EXPECTED_KEY);
        const result = cursor.getCurrentBinary((key, value) => {
          callbackCount++;
          if (!(key instanceof Uint8Array)) {
            throw new TypeError('Expected a Uint8Array key');
          }
          const keyBytes = new Uint8Array(key);
          assertEquals(keyBytes, EXPECTED_KEY);
          assertEquals(value, EXPECTED_VALUE);
        });
        assertEquals(callbackCount, 1);
        assertEquals(result, EXPECTED_VALUE);
      },
      [
        () => cursor?.close(),
        () => readTxn?.abort(),
        () => setupTxn?.abort(),
        () => dbi?.close(),
        () => env.close(),
      ],
    );
  });
});
