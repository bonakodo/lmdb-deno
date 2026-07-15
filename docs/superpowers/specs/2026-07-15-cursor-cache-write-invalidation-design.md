# Cursor Cache Write Invalidation Design

## Problem

Cursor navigation caches LMDB-backed key and value views so current-record
getters can avoid a second native call. LMDB invalidates those views after any
later update operation in the same transaction. Transaction writes currently
leave the caches intact, allowing a safe getter to copy stale or invalid native
memory.

## Design

The transaction binding remains the ownership boundary for invalidation because
it already tracks every cursor opened by that transaction. Before any native
write-like call, the binding will clear the current-record cache of every owned
cursor while preserving permission to recover the cursor's native current
position.

After an ordinary write, the next current-record getter will lazily call
`MDB_GET_CURRENT`, copy or decode the refreshed value as requested, and cache
the refreshed native views. Callers that do not read a cursor after a write
incur no additional native call. Emptying a DBI leaves its cursors without a
recoverable current position, so their current-record getters return `null`
without making that native call.

Invalidation will run immediately before:

- the shared implementation behind every `Txn.put*` method;
- `Txn.del()`;
- transactional DBI creation through `openDbi({ create: true, txn })`;
- `Cursor.del()`, affecting all sibling cursors in the transaction; and
- `Dbi.drop()` when it uses a caller-supplied transaction, including
  `justFreePages: true`.

Cursor deletion will retain its existing behavior for the deleting cursor:
after the native delete completes, that cursor has no readable current record
until it is navigated again. Sibling cursors remain eligible for lazy
`MDB_GET_CURRENT` recovery.

Lifecycle invalidation remains terminal. Closing a cursor or DBI, ending or
resetting a transaction, and closing an environment must not enable lazy
recovery.

## Failure Behavior

Caches are invalidated before entering LMDB, even if the native update later
fails. This is conservative and ensures JavaScript never reuses a view across
an attempted update operation. Existing validation that fails before the
native call does not invalidate cursor caches.

## Tests

Regression tests will first demonstrate the stale cache, then cover:

- replacing the current value through the transaction write path and observing
  the refreshed value from every cursor positioned on it;
- deletion through `Txn.del()` without exposing the deleted cached value;
- emptying a DBI through `drop({ txn, justFreePages: true })` without exposing a
  cached record;
- deletion through one cursor invalidating sibling cursor caches; and
- preservation of existing terminal lifecycle and durable-copy behavior.

Verification will run the focused cursor-cache tests followed by the repository
check and complete test tasks.
