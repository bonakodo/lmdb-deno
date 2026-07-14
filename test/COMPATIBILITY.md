# Compatibility status

Verified on 2026-07-14 against the exact LMDB 1.0.0 runtime required by this
package. This is a GREEN compatibility record, not a historical RED baseline.

> **LMDB 0.9 databases are unsupported.** node-lmdb 0.10.1 uses LMDB 0.9 and
> its database files were never opened by the semantic comparison. LMDB 0.9
> and LMDB 1.0 files are mutually incompatible. Export existing data with the
> LMDB 0.9 `mdb_dump`, then import that dump with the LMDB 1.0 `mdb_load`. This
> package does not convert or migrate a 0.9 database in place.

## Verified environment

```text
macOS 26.5.2 (Darwin 25.5.0), arm64, 64-bit little-endian
Deno 2.9.2 (stable, release, aarch64-apple-darwin)
V8 14.9.207.2-rusty
TypeScript 6.0.3
Node.js 22.23.1 LTS
npm 11.17.0
LMDB 1.0.0: (June 30, 2026)
LMDB library: /private/tmp/deno-lmdb-final/liblmdb.dylib
LMDB library SHA-256: 2d438e32e1dc5e26aa6638eab0359830025925cae21c289de59960337a485377
```

The library was built outside the repository by
`test/_support/build_lmdb_1.sh`. The repository and published package contain
no LMDB implementation, source archive, static library, or shared library.
The verified upstream inputs are:

```text
LMDB_1.0.0 archive SHA-256:
a61ded12bd9c670038b77483dda13b50684a93a111e53421dfb979624ae9f72e

libraries/liblmdb/lmdb.h SHA-256:
b9267c09ade0147e224316d0195c8ee3e9b8cc130ba196fad020bccb7b1cd043
```

`LMDB_LIB_PATH` must name the user-supplied LMDB 1.0.0 shared library, or be
the literal `auto` to probe the fixed ordered candidates under `/usr/lib`.
The loader rejects every other native version, including LMDB 0.9.35.

## Verified test inventory

The commands below registered and passed:

- 190 self-contained core Deno tests;
- 6 compatibility oracle tests;
- 196 tests in the complete composed suite.

The core suite was run after deleting `compat/node/node_modules`, with `PATH`
restricted to a Deno symlink and system directories, and inside a macOS
sandbox that denied all network access. `command -v node` was empty, and the
suite passed 190 tests without a Node.js executable, npm packages, or network
access. The bootstrap then installed the lock-pinned Node oracle using Node.js
22.23.1 LTS; the focused compatibility suite passed six tests, and `test:all`
reproduced 190 core plus six compatibility passes. The public compile-only
contract is checked by `deno task check` and registers no runtime tests.

Exact commands used for this capture:

```sh
export LMDB_LIB_PATH=/private/tmp/deno-lmdb-final/liblmdb.dylib

NO_NODE_BIN=/private/tmp/deno-lmdb-no-node-bin
rm -rf "$NO_NODE_BIN"
mkdir -p "$NO_NODE_BIN"
ln -s /opt/homebrew/bin/deno "$NO_NODE_BIN/deno"
NO_NODE_PATH="$NO_NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
test -z "$(PATH="$NO_NODE_PATH" command -v node)"
rm -rf compat/node/node_modules
sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  env PATH="$NO_NODE_PATH" LMDB_LIB_PATH="$LMDB_LIB_PATH" \
  "$NO_NODE_BIN/deno" task test

export NODE_LTS_PREFIX=/private/tmp/deno-lmdb-node-22.23.1
rm -rf "$NODE_LTS_PREFIX"
npm install --prefix "$NODE_LTS_PREFIX" --no-save node@22.23.1
export NODE_LTS_BIN="$NODE_LTS_PREFIX/node_modules/node/bin/node"
export PATH="$NODE_LTS_PREFIX/node_modules/.bin:$PATH"
test "$("$NODE_LTS_BIN" --version)" = v22.23.1
"$NODE_LTS_BIN" --version
npm --version
deno --version

deno task compat:bootstrap
deno task test:compat
deno task test:all
deno task check
deno lint --rules-include=no-slow-types mod.ts src
deno task doc
deno task publish:dry
```

`compat:bootstrap` runs `npm ci` and requires exactly Node.js 22.23.1 LTS on
`PATH`. `test:compat` uses `NODE_LTS_BIN` for the oracle. `test:all` deliberately
does not bootstrap: CI and developers bootstrap once before running the
composed suite.

`deno task check` passed formatting for 97 files, lint for 81 files, and type
checking for its five explicit roots: `mod.ts`, the public type contract, the
compatibility test, and both Deno oracle modules. Separately,
`deno lint --rules-include=no-slow-types mod.ts src` checked 19 files.
`deno task doc` passed `deno doc --lint mod.ts`.

The plain `deno task publish:dry` succeeded from the clean tracked tree without
`--allow-dirty`. The payload is restricted by `deno.json` and contains no
vendored native headers or implementation, tests, compatibility fixtures,
lockfile, or scratch artifacts.

## Compatibility target and intentional boundaries

The JavaScript API authority is node-lmdb 0.10.1: public classes, methods,
overloads, option names, final callback results, value encodings,
cursor behavior, duplicate behavior, batch results, and observed error codes
are compatibility targets. The native ABI and file format are instead exactly
OpenLDAP LMDB 1.0.0. The intentional differences and platform requirements
are complete below:

- `Uint8Array` replaces Node.js `Buffer` in every public binary position.
- The user supplies exactly LMDB 1.0.0 through `LMDB_LIB_PATH`; no native
  runtime is vendored. `auto` probes only deterministic `/usr/lib` paths.
- LMDB 0.9 runtimes, LMDB 0.9 files, and node-lmdb-created files are rejected
  or outside the contract. Later LMDB versions, including later 1.0 patch
  releases, require a new ABI audit.
- Only the node-lmdb-relevant LMDB ABI plus `MDB_PREVSNAPSHOT` is exposed. LMDB
  1.0 cryptography, two-phase commit, and other unrelated native APIs are not
  added to the JavaScript surface.
- `EnvOptions.useWorker` is a Deno extension. It defaults to `true` and moves
  native `batchWrite` execution to one persistent package Worker per
  environment; `false` runs the same executor on the calling isolate.
- `sync` and `copy` have additive Promise forms while retaining callback forms.
  Declarations accept node-lmdb-shaped callbacks and null-correct callbacks;
  runtime success passes `null`, and error paths may omit batch results.
- Batch progress is best-effort and may run zero or more times. Progress and a
  successful final callback share the same parent-owned results array. Input
  validation errors are synchronous; Worker startup, dispatch, transactional,
  and hard-death failures arrive asynchronously through the one final
  callback.
- Batch values and conditions are binary-only at runtime (`Uint8Array`,
  `null`, or `undefined`) despite the broader node-lmdb-compatible declaration
  union.
- A hard batch Worker death poisons the shared native environment. Cooperative
  transaction errors leave it reusable.
- Same canonical paths share a reference-counted native environment within one
  isolate. The first wrapper selects native options; `useWorker` stays
  wrapper-local. Arbitrary user Workers cannot reopen or attach that shared
  environment; native descriptors are package-internal.
- Cursors in read-only transactions require explicit `close()`. Ending a write
  transaction closes its native cursors and makes their wrappers unusable.
- Safe binary getters copy. Unsafe binary getters return transaction-scoped
  LMDB-backed views. Unsafe string getters return copied strings because pure
  TypeScript cannot create V8 external two-byte strings.
- `detachBuffer` accepts the backing `ArrayBuffer`, not a `Uint8Array`, and
  intentionally performs no provenance check.
- Normal database operations require unrestricted `--allow-ffi`, even with an
  explicit library path. A path-scoped FFI grant is sufficient only for the
  isolated loader/version probe. Filesystem and `LMDB_LIB_PATH` environment
  permissions are also required as exercised by each command.
- The audited native layout requires a 64-bit, little-endian target. Unsupported
  pointer width or byte order fails before database work.
- LMDB 1.0 native errors retain native numbers unless a node-lmdb compatibility
  contract observes a translated code. Loader and Deno permission errors stay
  actionable Deno errors.

## What the semantic oracle proves

The oracle installs exactly `node-lmdb@0.10.1` from the committed npm lockfile
and runs the same scenario manifest under Node.js 22.23.1 LTS and Deno. Each
runtime creates and reads its own fresh temporary database. The harness
compares normalized returned values, key values, cursor and duplicate
ordering, atomic batch result codes, final callback success, and errors.

The cross-runtime oracle deliberately registers only the final callback and
does not register a node-lmdb progress callback because upstream node-lmdb
0.10.1 can crash while delivering progress. Deno batch progress ordering,
result-array ownership, and error behavior remain covered by the
self-contained Deno-native batch and Worker tests.

No database path or file crosses between Node and Deno. The six passing
compatibility-oracle tests therefore prove normalized JavaScript behavior
only. They do not prove ABI compatibility, file-format compatibility,
crash-recovery compatibility, or migration compatibility with node-lmdb.
