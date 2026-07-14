import {
  deepStrictEqual as assertEquals,
  throws as assertThrows,
} from 'node:assert/strict';
import { decodeString, encodeString } from '../src/encoding.ts';
import { withTempDir } from './_support/fixtures.ts';
import { withCleanup } from './_support/lifecycle.ts';
import { loadSubject } from './_support/subject.ts';

function assertExactStringRoundTrip(value: string): void {
  const encoded = encodeString(value);
  assertEquals(encoded.byteLength, (value.length + 1) * 2);
  assertEquals(encoded.at(-2), 0);
  assertEquals(encoded.at(-1), 0);
  assertEquals(decodeString(encoded), value);
}

Deno.test('UTF-16LE strings preserve a leading BOM code unit', () => {
  assertExactStringRoundTrip('\uFEFFleading BOM');
});

Deno.test('UTF-16LE strings preserve valid surrogate pairs', () => {
  assertExactStringRoundTrip('astral \u{1F680} value');
});

Deno.test('UTF-16LE strings preserve lone high surrogates', () => {
  assertExactStringRoundTrip('high \uD800 surrogate');
});

Deno.test('UTF-16LE strings preserve lone low surrogates', () => {
  assertExactStringRoundTrip('low \uDC00 surrogate');
});

Deno.test('UTF-16LE strings preserve embedded NUL code units', () => {
  assertExactStringRoundTrip('embedded\0NUL');
});

Deno.test('UTF-16LE decoding removes exactly one trailing terminator', () => {
  assertExactStringRoundTrip('trailing NUL\0');
  assertEquals(decodeString(new Uint8Array([0, 0])), '');
  assertThrows(
    () => decodeString(new Uint8Array([0x41, 0, 0])),
    /Invalid zero-terminated UTF-16 string/,
  );
  assertThrows(
    () => decodeString(new Uint8Array([0x41, 0])),
    /Invalid zero-terminated UTF-16 string/,
  );
});

Deno.test('public string operations preserve exact UTF-16 code units', async () => {
  const { Env } = await loadSubject();
  const values = [
    '\uFEFFleading BOM',
    'astral \u{1F680} value',
    'high \uD800 surrogate',
    'low \uDC00 surrogate',
    'embedded\0NUL',
    'trailing NUL\0',
  ];

  await withTempDir((path) => {
    const env = new Env();
    let dbi: ReturnType<typeof env.openDbi> | undefined;
    let txn: ReturnType<typeof env.beginTxn> | undefined;
    return withCleanup(
      () => {
        env.open({ path, maxDbs: 1 });
        dbi = env.openDbi({ name: null, create: true });
        txn = env.beginTxn();
        values.forEach((value, index) => {
          const key = `value-${index}`;
          txn?.putString(dbi!, key, value);
          assertEquals(txn?.getString(dbi!, key), value);
        });
        txn.commit();
        txn = undefined;
      },
      [() => txn?.abort(), () => dbi?.close(), () => env.close()],
    );
  });
});
