import lmdb from 'node-lmdb';
import { executeSemanticScenarios } from '../semantic_runner.mjs';

export async function observeSemantics(databasePath, scenarios) {
  return await executeSemanticScenarios(
    { Env: lmdb.Env, Cursor: lmdb.Cursor, bytes: fromHex },
    databasePath,
    scenarios,
  );
}

function fromHex(hex) {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new TypeError(`invalid lowercase hex: ${hex}`);
  }
  return Buffer.from(hex, 'hex');
}
