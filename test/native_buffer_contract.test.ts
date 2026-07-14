import { assertEquals } from './_support/assertions.ts';
import { lmdbSymbols } from '../src/native/symbols.ts';

Deno.test('native symbols use buffers for JavaScript-owned memory', () => {
  assertEquals(lmdbSymbols.mdb_cmp.parameters, [
    'pointer',
    'u32',
    'buffer',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_cursor_count.parameters, [
    'pointer',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_cursor_get.parameters, [
    'pointer',
    'buffer',
    'buffer',
    'u32',
  ]);
  assertEquals(lmdbSymbols.mdb_cursor_open.parameters, [
    'pointer',
    'u32',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_dbi_open.parameters, [
    'pointer',
    'buffer',
    'u32',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_del.parameters, [
    'pointer',
    'u32',
    'buffer',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_env_copy2.parameters, [
    'pointer',
    'buffer',
    'u32',
  ]);
  assertEquals(lmdbSymbols.mdb_env_create.parameters, ['buffer']);
  assertEquals(lmdbSymbols.mdb_env_get_flags.parameters, [
    'pointer',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_env_info.parameters, ['pointer', 'buffer']);
  assertEquals(lmdbSymbols.mdb_env_open.parameters, [
    'pointer',
    'buffer',
    'u32',
    'u32',
  ]);
  assertEquals(lmdbSymbols.mdb_env_stat.parameters, ['pointer', 'buffer']);
  assertEquals(lmdbSymbols.mdb_get.parameters, [
    'pointer',
    'u32',
    'buffer',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_put.parameters, [
    'pointer',
    'u32',
    'buffer',
    'buffer',
    'u32',
  ]);
  assertEquals(lmdbSymbols.mdb_stat.parameters, [
    'pointer',
    'u32',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_txn_begin.parameters, [
    'pointer',
    'pointer',
    'u32',
    'buffer',
  ]);
  assertEquals(lmdbSymbols.mdb_version.parameters, [
    'buffer',
    'buffer',
    'buffer',
  ]);
});
