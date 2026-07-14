import { Cursor, Env } from '../../mod.ts';
import { executeSemanticScenarios } from '../semantic_runner.mjs';

export interface SemanticObservation {
  schemaVersion: 2;
  values: {
    strings: string[];
    numbers: string[];
    booleans: boolean[];
    binaries: string[];
  };
  keyValues: {
    strings: Array<{ key: string; value: string }>;
    uint32: Array<{ key: number; value: string }>;
    binaries: Array<{ key: string; value: string }>;
  };
  cursor: {
    keys: Array<string | number>;
    duplicates: string[];
    duplicateNavigation: string[];
  };
  batch: {
    results: number[];
    callbackOrder: ['final'];
  };
  errors: Array<{ operation: string; name: string; code?: number }>;
}

export async function observeSemantics(
  databasePath: string,
  scenarios: unknown,
): Promise<SemanticObservation> {
  return await executeSemanticScenarios(
    { Env, Cursor, bytes: fromHex },
    databasePath,
    scenarios,
  ) as SemanticObservation;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new TypeError(`invalid lowercase hex: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
