/**
 * Native Deno FFI bindings for the exact LMDB 1.0.0 ABI and file format, with
 * the public JavaScript behavior of node-lmdb 0.10.1. `Uint8Array` replaces
 * Node.js `Buffer` in every public binary position.
 *
 * This package ships no LMDB binary and downloads nothing at runtime. Install
 * exactly LMDB 1.0.0 and set `LMDB_LIB_PATH` before importing: use an explicit
 * user-supplied shared-library path, or `auto` for deterministic probing under
 * `/usr/lib`. Importing validates the native version and rejects every other
 * ABI.
 *
 * LMDB 1.0 and LMDB 0.9 database files are mutually incompatible. Never open
 * a 0.9 or node-lmdb-created environment with this package. Export it with an
 * LMDB 0.9 `mdb_dump`, create a fresh environment, then import with the LMDB
 * 1.0 `mdb_load`; there is no in-place migration.
 *
 * Normal operations, including Worker batches, require unrestricted
 * `--allow-ffi` because Deno's pointer APIs cannot be authorized by a dynamic
 * library path. Also grant `--allow-env=LMDB_LIB_PATH` and the filesystem
 * permissions required by your environment and copy paths. A path-scoped FFI
 * grant is sufficient only for the isolated library/version probe.
 *
 * Create an {@link Env}, open one or more {@link Dbi} handles, and perform
 * reads and writes inside {@link Txn} objects. Read-only cursors require an
 * explicit {@link Cursor.close}; write transaction termination auto-closes
 * native cursors and invalidates their wrappers. Safe binary getters copy,
 * unsafe binary getters return transaction-scoped LMDB views, and unsafe
 * string getters return copies. {@link Env.detachBuffer} accepts a view's
 * backing `ArrayBuffer` without checking its provenance.
 *
 * {@link EnvOptions.usePreviousSnapshot} selects the immediately preceding
 * commit and resets after a successful write commit. {@link Env.batchWrite}
 * uses a persistent Web Worker by default; `useWorker` is a Deno extension
 * defaulting to `true`. Batch values are binary-only at runtime despite the
 * broad node-lmdb-compatible declarations. Input validation is synchronous;
 * Worker startup, dispatch, execution, and death failures reach the one final
 * callback asynchronously. Progress may run zero or more times with the
 * parent-owned results array. Hard Worker death poisons the shared native
 * environment.
 *
 * Promise forms of {@link Env.sync} and {@link Env.copy} are additive Deno
 * conveniences. Their node-lmdb-shaped and null-correct callback declaration
 * views are both accepted; runtime success passes `null`.
 *
 * Same canonical paths share the first native environment within one isolate;
 * arbitrary user-created Workers cannot attach to it. Only 64-bit
 * little-endian macOS and Linux targets have been audited.
 *
 * @example Store and read one binary value.
 * ```ts
 * import { Env } from '@bonakodo/lmdb';
 *
 * // Run with LMDB_LIB_PATH set before import, for example:
 * // LMDB_LIB_PATH=/usr/lib/liblmdb.so deno run --allow-env=LMDB_LIB_PATH \
 * //   --allow-ffi --allow-read --allow-write example.ts
 * const path = await Deno.makeTempDir();
 * const env = new Env();
 * env.open({ path, mapSize: 16 * 1024 * 1024, maxDbs: 1 });
 * const db = env.openDbi({ name: null, create: true });
 *
 * const write = env.beginTxn();
 * write.putBinary(db, 'answer', new Uint8Array([4, 2]));
 * write.commit();
 *
 * const read = env.beginTxn({ readOnly: true });
 * console.log(read.getBinary(db, 'answer')); // Uint8Array(2) [4, 2]
 * read.abort();
 *
 * db.close();
 * env.close();
 * await Deno.remove(path, { recursive: true });
 * ```
 *
 * @module
 */

export * from './src/lib.ts';
