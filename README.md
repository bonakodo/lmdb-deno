# @bonakodo/lmdb

[![JSR](https://jsr.io/badges/@bonakodo/lmdb)](https://jsr.io/@bonakodo/lmdb)
[![JSR Score](https://jsr.io/badges/@bonakodo/lmdb/score)](https://jsr.io/@bonakodo/lmdb)

Native Deno FFI bindings for the exact LMDB 1.0.0 ABI and file format, with the
public JavaScript behavior of node-lmdb 0.10.1. Every public binary key, value,
callback argument, and batch field uses `Uint8Array` instead of Node.js
`Buffer`.

The package contains TypeScript bindings, ships no LMDB binary, and downloads
nothing at runtime. You install and select the shared library; the loader
accepts exactly LMDB 1.0.0.

## Incompatible LMDB 0.9 files

> [!WARNING]
> LMDB 1.0 and LMDB 0.9 database files are mutually incompatible. Do not open
> a 0.9 or node-lmdb-created environment with this package. Dump the old
> environment with the LMDB 0.9 `mdb_dump`, create a fresh LMDB 1.0
> environment, and load the dump with the LMDB 1.0 `mdb_load`. There is no
> in-place migration.

Use distinct executable paths so the export and import cannot accidentally run
the same installed LMDB version:

```sh
/opt/lmdb-0.9/bin/mdb_dump -a /path/to/old-environment > lmdb.dump
mkdir /path/to/new-environment
/opt/lmdb-1.0/bin/mdb_load -f lmdb.dump /path/to/new-environment
```

## Install

Add the package from JSR:

```sh
deno add jsr:@bonakodo/lmdb
```

Then import the default entrypoint:

```ts
import { Cursor, Env } from '@bonakodo/lmdb';
```

Without an import-map entry, use
`import { Env } from 'jsr:@bonakodo/lmdb@^0.1.0'`.

### Install LMDB 1.0.0

Build and install the signed OpenLDAP `LMDB_1.0.0` release under a dedicated
prefix, or use a system package only if it reports exactly 1.0.0. For example,
select a user-supplied exact-1.0.0 installation explicitly on macOS:

```sh
export LMDB_LIB_PATH=/opt/lmdb-1.0/lib/liblmdb.dylib
```

On Linux, select the exact shared library instead:

```sh
export LMDB_LIB_PATH=/opt/lmdb-1.0/lib/liblmdb.so.1.0
```

The package verifies `mdb_version` during import and rejects any shared library
that reports a version other than 1.0.0. LMDB remains a user-supplied system
dependency: this package downloads nothing at runtime and ships no source
archive, static library, or shared library.

The exported `version.major`, `minor`, and `patch` values come from that native
probe. `versionString` is the canonical string pinned from the audited 1.0.0
header because Deno's path-scoped FFI permission cannot decode the native
string pointer returned by `mdb_version`.

`LMDB_LIB_PATH` is mandatory. It is either:

- an explicit path passed unchanged to `Deno.dlopen`, or
- `auto`, which probes only the following duplicate-free `/usr/lib` paths.

The common candidates come first:

```text
/usr/lib/liblmdb.so
/usr/lib/liblmdb.so.0
```

Then the current architecture is preferred over the other architecture:

```text
/usr/lib/x86_64-linux-gnu/liblmdb.so
/usr/lib/x86_64-linux-gnu/liblmdb.so.0
/usr/lib/aarch64-linux-gnu/liblmdb.so
/usr/lib/aarch64-linux-gnu/liblmdb.so.0
```

On AArch64, the two `aarch64-linux-gnu` entries precede the two
`x86_64-linux-gnu` entries. Finally, auto detection tries this macOS candidate:

```text
/usr/lib/liblmdb.dylib
```

Auto detection never searches Homebrew, `/usr/local`, the current directory,
or the network. Use an explicit path for those installations.

```sh
LMDB_LIB_PATH=auto deno run --allow-env=LMDB_LIB_PATH --allow-ffi app.ts
```

## Permissions

Normal database operations require unrestricted `--allow-ffi`. Deno's static
pointer construction and view APIs cannot be authorized using a dynamic
library path, even though `LMDB_LIB_PATH` still controls the only library this
package loads. Worker batches inherit the parent process permissions.

With the platform-specific `LMDB_LIB_PATH` exported above, an application that
creates and removes its database directory can run:

```sh
deno run --allow-env=LMDB_LIB_PATH --allow-ffi \
  --allow-read=/path/to/data --allow-write=/path/to/data app.ts
```

Grant read/write access for every Deno filesystem operation your application
performs, including temporary directories and copy destinations. Filesystem
access performed inside the native LMDB library is outside Deno's JavaScript
permission mediation, so do not treat Deno flags as an LMDB path sandbox.

A path-scoped FFI grant is enough only to import the module and inspect
`version`, because that isolated loader/version path calls `mdb_version`
without constructing or reading native pointers:

```sh
deno run --allow-env=LMDB_LIB_PATH --allow-ffi="$LMDB_LIB_PATH" - <<'TS'
import { version } from 'jsr:@bonakodo/lmdb@^0.1.0';
console.log(version);
TS
```

## Environment, transactions, and cursors

An `Env` wrapper is opened once and closed once. Database handles belong to the
environment; cursors belong to a transaction. Read-only cursors require an
explicit `close()`; ending a write transaction makes its cursor wrappers
unusable and lets LMDB close their native cursors automatically. Complete work
in this order:

```ts
import { Cursor, Env } from '@bonakodo/lmdb';

const path = await Deno.makeTempDir();
const env = new Env();
env.open({ path, mapSize: 64 * 1024 * 1024, maxDbs: 4 });

const records = env.openDbi({ name: 'records', create: true });

const write = env.beginTxn();
write.putString(records, 'name', 'Ada');
write.putNumber(records, 'score', 42);
write.putBoolean(records, 'active', true);
write.putBinary(records, 'bytes', new Uint8Array([1, 2, 3]));
write.commit();

const read = env.beginTxn({ readOnly: true });
console.log(read.getString(records, 'name')); // "Ada"
console.log(read.getBinary(records, 'bytes')); // Uint8Array [1, 2, 3]

const cursor = new Cursor(read, records);
for (let key = cursor.goToFirst(); key !== null; key = cursor.goToNext()) {
  console.log(key, cursor.getCurrentBinary());
}
cursor.close();
read.abort();

records.close();
env.close();
await Deno.remove(path, { recursive: true });
```

String keys and values use node-lmdb's zero-terminated UTF-16LE representation.
Numbers use native-endian IEEE-754 doubles as values and native unsigned 32-bit
integers as keys. Booleans use node-lmdb's one-byte representation. Binary
keys and values use `Uint8Array` exclusively:

```ts
const binary = env.openDbi({
  name: 'binary',
  create: true,
  keyIsBuffer: true,
});
const txn = env.beginTxn();
txn.putBinary(
  binary,
  new Uint8Array([0xca, 0xfe]),
  new Uint8Array([0xba, 0xbe]),
);
txn.commit();
```

### Duplicate-sorted databases

Set `dupSort` when creating a database, then navigate values with duplicate
cursor methods:

```ts
const tags = env.openDbi({ name: 'tags', create: true, dupSort: true });
const write = env.beginTxn();
write.putString(tags, 'language', 'Deno');
write.putString(tags, 'language', 'TypeScript');
write.commit();

const read = env.beginTxn({ readOnly: true });
const cursor = new Cursor(read, tags);
cursor.goToKey('language');
for (
  let key = cursor.goToFirstDup();
  key !== null;
  key = cursor.goToNextDup()
) {
  console.log(cursor.getCurrentString());
}
cursor.close();
read.abort();
```

## Sync and copy

The node-lmdb callback forms remain available. Callbacks run asynchronously
and exactly once:

```ts
env.sync((error) => {
  if (error) console.error(error);
});

env.copy('/backups/lmdb', true, (error) => {
  if (error) console.error(error);
});
```

Promise overloads are additive Deno conveniences:

```ts
await env.sync();
await env.copy('/backups/lmdb', true);
```

Both operations use nonblocking FFI. Keep the environment open until the
callback or Promise settles; `close()` rejects while one is pending.

## Atomic batch writes

`batchWrite` executes all operations in one native write transaction. Input
observation, validation, byte copying, normalization, and DBI retention happen
synchronously on the calling thread. By default, one lazily created,
persistent Web Worker then offloads the native transactional execution, which
keeps that portion of a large batch off the calling JavaScript thread:

```ts
env.batchWrite(
  [
    [records, 'a', new Uint8Array([1])],
    [records, 'b', new Uint8Array([2])],
    { db: records, key: 'c', value: new Uint8Array([3]) },
  ],
  {
    progress(results) {
      console.log('completed so far', results);
    },
  },
  (error, results) => {
    if (error) {
      console.error(error);
      return;
    }
    console.log('committed', results);
  },
);
```

Progress is best effort and may fire zero or more times. When it fires, it
receives the same parent-owned array later passed to a successful completion
callback; the array can still be sparse while work is in progress. The
operation list and byte inputs are snapshotted before `batchWrite` returns.

To use the same atomic executor on the calling thread:

```ts
const env = new Env();
env.open({ path: './data', useWorker: false });
```

Input observation, validation, and copying are synchronous. With the default
Worker mode, startup, dispatch, native execution, and Worker-death failures are
reported asynchronously through the final callback, which runs exactly once.
Runtime success passes `null` and the results array. At runtime, batch `value`
and `ifValue` fields are deliberately binary-only: pass `Uint8Array`, `null`,
or `undefined`. This matches node-lmdb's native batch behavior even though its
broad public type union is retained for declaration compatibility.

A cooperative Worker error aborts the transaction and leaves the environment
usable. If the Worker dies after entering native code, native transaction state
cannot be recovered safely from pure TypeScript. The shared environment is
therefore poisoned: queued callbacks fail, later operations reject, and callers
must close every same-path wrapper.

## Unsafe reads

Safe binary getters copy LMDB memory and survive transaction closure:

```ts
const read = env.beginTxn({ readOnly: true });
const durable = read.getBinary(records, 'bytes');
read.abort();
console.log(durable); // still valid
```

Unsafe binary getters return a zero-copy view backed by LMDB's memory map. It
can be invalidated by cursor movement, writes, transaction reset/renew,
commit/abort, or environment closure. Consume it immediately, copy with
`.slice()`, or detach its `ArrayBuffer` before ending the transaction:

```ts
const read = env.beginTxn({ readOnly: true });
const borrowed = read.getBinaryUnsafe(records, 'bytes');
if (borrowed) {
  const durable = borrowed.slice();
  env.detachBuffer(borrowed.buffer); // pass the ArrayBuffer, not the view
  console.log(durable);
}
read.abort();
```

`detachBuffer` intentionally performs no provenance check, matching node-lmdb.
Unsafe string getters return the same string value but necessarily copy it:
pure TypeScript cannot construct V8 external two-byte strings.

## Compatibility boundaries

The JavaScript behavioral authority is node-lmdb 0.10.1. The complete
intentional differences and environment constraints are:

- `Uint8Array` replaces `Buffer` in every public binary position.
- The native ABI and file format are exactly LMDB 1.0.0. Other native versions
  are rejected, and LMDB 0.9/node-lmdb database files must be migrated by dump
  and load rather than opened in place.
- `EnvOptions.useWorker` is a Deno extension, defaults to `true`, and affects
  only `batchWrite`.
- `usePreviousSnapshot: true` selects the immediately preceding committed
  snapshot. A successful write commit resets that native flag.
- `sync` and `copy` add Promise forms. Both node-lmdb-shaped and null-correct
  callback declarations are accepted; runtime success passes `null`.
- Batch progress may run zero or more times on the parent-owned results array.
  Validation is synchronous; default-Worker startup, dispatch, execution, and
  death failures are reported asynchronously through one final callback.
- Read-only cursors require explicit close. Write transaction termination
  auto-closes native cursors and invalidates their JavaScript wrappers.
- Safe binary getters return copies. Unsafe binary getters return
  transaction-scoped LMDB views. Unsafe string getters still copy.
- `detachBuffer` accepts a view's backing `ArrayBuffer`, not the `Uint8Array`,
  and intentionally performs no provenance check.
- Same canonical paths share the first reference-counted native environment
  within one isolate. The first wrapper's native options remain in effect;
  `useWorker` remains wrapper-local. Arbitrary user-created Workers cannot
  attach to that environment.
- Normal operations require unrestricted `--allow-ffi`, even with an explicit
  library path.
- Only 64-bit little-endian macOS and Linux targets are audited. Unsupported
  pointer widths, byte orders, operating systems, or architectures are outside
  the supported contract.
- A hard batch Worker death poisons the shared native environment.
- Batch values are binary-only at runtime despite node-lmdb's broader
  declaration union.

## Testing and semantic compatibility

With the platform-specific `LMDB_LIB_PATH` exported above, run the complete
native Deno suite:

```sh
deno task check
deno task test
```

The repository also compares normalized JavaScript semantics with node-lmdb
0.10.1 under Node.js 22.23.1 LTS. Each runtime creates a separate fresh
database; no database file crosses between LMDB versions:

```sh
deno task compat:bootstrap
NODE_LTS_BIN=/path/to/node-v22.23.1/bin/node deno task test:compat
```

The cross-runtime oracle compares atomic batch result codes and final callback
success. Batch progress remains covered by the Deno-native contract tests; it
is excluded from the Node oracle because node-lmdb 0.10.1 can crash while
delivering progress callbacks on the pinned runtime.

## Local benchmarks

The manual benchmark suite compares equivalent raw-binary operations with
`npm:lmdb@3.5.6` in the same Deno process. It covers safe and temporary-view
point reads, synchronous transactional overwrite batches, and ordered scans.
Each implementation uses a separate temporary database; their files are never
shared.

With the exact LMDB 1.0 library selected for this package, run:

```sh
LMDB_LIB_PATH=/absolute/path/to/liblmdb deno task bench
```

The benchmark is not run by the normal test tasks or CI. Treat its results as
directional: the packages use different wrapper designs, native builds, and
LMDB versions, and local storage and cache state affect results. Under Deno,
`npm:lmdb`'s `getBinaryFast` exposes its complete reusable buffer rather than
setting the view length to the logical value length. The fast-read benchmark
therefore consumes only the known value prefix and does not compare returned
view lengths.

## Security notes

FFI executes native code with the host process's authority. Select
`LMDB_LIB_PATH` from trusted configuration, pin the library deployment, and do
not accept a path from untrusted input. `auto` searches only fixed system
locations. LMDB itself is not a network service; protect database and backup
paths with operating-system ownership and permissions.

`unsafeNoLock`, write-map flags, unsafe views, append assertions, and manual
buffer detachment expose native invariants directly. Use them only when their
lifetime and synchronization requirements are understood.

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
