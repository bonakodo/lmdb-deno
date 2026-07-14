import { match as assertMatch } from 'node:assert/strict';
import { Cursor, Env } from '../../mod.ts';
import {
  hasSharedActiveWriter,
  poisonNativeEnvironment,
} from '../../src/internal/native_test_access.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected an environment path');

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected operation to throw');
}

const first = new Env();
const second = new Env();
let firstClosed = false;
let secondClosed = false;

try {
  first.open({ path });
  second.open({ path });
  const dbi = first.openDbi({ name: null, create: true });
  const txn = first.beginTxn();
  const cursor = new Cursor(txn, dbi);
  if (!hasSharedActiveWriter(second)) {
    throw new Error('Expected the shared writer to be tracked');
  }

  poisonNativeEnvironment(second);

  for (
    const operation of [
      () => first.info(),
      () => second.stat(),
      () => first.beginTxn(),
      () => second.openDbi({ name: null }),
      () => txn.getBinary(dbi, 'key'),
      () => dbi.stat(txn),
      () => cursor.goToFirst(),
    ]
  ) {
    const error = captureError(operation);
    assertMatch(error.message, /poison/i);
  }

  first.close();
  firstClosed = true;
  if (hasSharedActiveWriter(second)) {
    throw new Error('Terminal invalidation retained the shared writer');
  }
  second.close();
  secondClosed = true;

  for (
    const operation of [
      () => txn.abort(),
      () => dbi.close(),
      () => cursor.close(),
    ]
  ) {
    const error = captureError(operation);
    assertMatch(error.message, /closed/i);
  }

  for (const alias of [path, `${path}/.`]) {
    const reopened = new Env();
    try {
      const error = captureError(() => reopened.open({ path: alias }));
      assertMatch(error.message, /poison/i);
    } finally {
      const closeError = captureError(() => reopened.close());
      assertMatch(closeError.message, /already closed/i);
    }
  }

  console.log('poison-ok');
} finally {
  if (!firstClosed) {
    try {
      first.close();
    } catch {
      // The primary assertion remains authoritative in this isolated process.
    }
  }
  if (!secondClosed) {
    try {
      second.close();
    } catch {
      // The primary assertion remains authoritative in this isolated process.
    }
  }
}
