# FFI Pointer Boundary Cleanup

## Goal

Reduce direct `Deno.UnsafePointer` use to the places where LMDB's ABI genuinely
requires an opaque or nested native pointer. Keep the package's direct
`liblmdb` design, public API, native LMDB version contract, and safe/unsafe read
semantics unchanged.

## Chosen approach

Use Deno FFI `buffer` parameters for JavaScript-owned memory and retain
`pointer` parameters for opaque LMDB handles and native return values. This
keeps the binding thin and lets Deno pass typed arrays through its optimized
buffer path.

The rejected alternatives are:

- A C or Rust shim could hide all pointer manipulation from TypeScript, but it
  would add a custom native build and distribution surface while only moving
  the unsafe boundary.
- WebAssembly or a subprocess would provide a stronger isolation boundary, but
  would substantially change LMDB's memory-mapped operation, deployment model,
  and performance characteristics.

## Native boundary

FFI parameters that point to JavaScript-owned typed-array storage will be
declared as `buffer`. This includes C strings, scalar output slots, pointer
output slots, `MDB_stat`, `MDB_envinfo`, and the outer `MDB_val` structures.
Their call sites will pass the owning typed arrays directly instead of first
converting them with `Deno.UnsafePointer.of()`.

Opaque `MDB_env *`, `MDB_txn *`, and `MDB_cursor *` handles remain `pointer`
values. LMDB returns these through `T **` output slots, so the numeric address
written into a JavaScript-owned buffer still must be converted into a Deno
pointer object. Worker transport also retains address conversion because Deno
pointer objects are not transferable between isolates.

`MDB_val` contains a nested data pointer. Creating input values therefore still
requires `Deno.UnsafePointer.of()` and `Deno.UnsafePointer.value()` for the input
byte array. Reading an LMDB result still requires converting the returned
address to a pointer object. These operations remain confined to the native
memory module.

## Read behavior

Safe binary reads will allocate a destination `Uint8Array` and copy native
bytes into it with `Deno.UnsafePointerView.copyInto()`. They will not construct
an external `ArrayBuffer`, even temporarily. The returned bytes remain durable
after writes or transaction closure.

Explicit unsafe binary reads will continue to use
`UnsafePointerView.getArrayBuffer()` to return a zero-copy, transaction-scoped
view. Existing lifetime documentation and `detachBuffer` behavior remain in
force. String getters continue to return copies.

## Error handling and ownership

Existing null-pointer, maximum JavaScript length, supported-ABI, and LMDB error
checks remain unchanged. Every typed array passed as a buffer must remain
strongly referenced for the full native call; nonblocking calls retain their
current explicit lifetime guards. Scratch `MDB_val` storage remains reusable
and clears references after every operation.

No pointer, native handle, or new unsafe capability will be exposed through the
public API.

## Testing

Implementation will follow red-green-refactor:

1. Add a symbol-contract test that fails until JavaScript-owned parameters use
   `buffer` while opaque handles remain `pointer`.
2. Add or adapt a memory test that fails until safe copying uses `copyInto()`
   and produces a durable independent result.
3. Update native scratch tests to exercise typed-array outer structures while
   preserving nested pointer layout, scratch reuse, and cleanup.
4. Run focused tests after each change, then `deno task check`, `deno task test`,
   `deno task test:compat`, `deno task doc`, and `deno task publish:dry`.

The change is complete when all gates pass, safe and unsafe read semantics are
unchanged, eligible production call sites no longer call
`Deno.UnsafePointer.of()` merely to pass JavaScript-owned storage, and the git
worktree is clean after the implementation commit.
