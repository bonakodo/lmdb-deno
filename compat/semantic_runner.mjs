/**
 * Executes the same public API sequence in Node and Deno. Runtime adapters are
 * deliberately limited to constructors and lowercase-hex byte allocation so
 * observation and normalization logic cannot drift between the two oracles.
 */
export async function executeSemanticScenarios(
  runtime,
  databasePath,
  scenarios,
) {
  validateScenarios(scenarios);
  const env = new runtime.Env();
  const opened = [];
  let primaryError;
  let result;

  try {
    env.open({
      path: databasePath,
      mapSize: scenarios.environment.mapSize,
      maxDbs: scenarios.environment.maxDbs,
    });
    const databases = openDatabases(env, opened);
    seedDatabase(env, databases, runtime.bytes, scenarios);

    const errors = observePublicErrors(env, databases, scenarios);
    const values = observeValues(env, databases, scenarios);
    const keyValues = observeKeyValues(
      env,
      databases,
      runtime.bytes,
      scenarios,
    );
    const cursor = observeCursors(
      runtime.Cursor,
      env,
      databases,
      runtime.bytes,
      scenarios,
    );
    const batch = await observeBatch(
      env,
      databases.batch,
      runtime.bytes,
      scenarios.batch,
    );
    assertBatchCommitted(env, databases.batch, runtime.bytes);

    result = {
      schemaVersion: 2,
      values,
      keyValues,
      cursor,
      batch,
      errors,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  for (const database of opened.reverse()) {
    try {
      database.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    env.close();
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}

function openDatabases(env, opened) {
  const open = (options) => {
    const database = env.openDbi(options);
    opened.push(database);
    return database;
  };
  return {
    strings: open({ name: null, create: true }),
    numbers: open({ name: 'numbers', create: true }),
    booleans: open({ name: 'booleans', create: true }),
    binaries: open({ name: 'binaries', create: true }),
    stringKeys: open({ name: 'string-keys', create: true }),
    uint32Keys: open({
      name: 'uint32-keys',
      create: true,
      keyIsUint32: true,
    }),
    binaryKeys: open({
      name: 'binary-keys',
      create: true,
      keyIsBuffer: true,
    }),
    duplicates: open({ name: 'duplicates', create: true, dupSort: true }),
    dupfixed: open({
      name: 'dupfixed',
      create: true,
      dupSort: true,
      dupFixed: true,
    }),
    batch: open({ name: 'batch', create: true }),
  };
}

function seedDatabase(env, databases, bytes, scenarios) {
  withWriteTransaction(env, (txn) => {
    for (const entry of scenarios.values.strings) {
      txn.putString(databases.strings, entry.key, entry.value);
    }
    for (const entry of scenarios.values.numbers) {
      txn.putNumber(databases.numbers, entry.key, parseNumber(entry.value));
    }
    for (const entry of scenarios.values.booleans) {
      txn.putBoolean(databases.booleans, entry.key, entry.value);
    }
    for (const entry of scenarios.values.binaries) {
      txn.putBinary(databases.binaries, entry.key, bytes(entry.value));
    }
    for (const entry of scenarios.keyModes.strings) {
      txn.putString(databases.stringKeys, entry.key, entry.value);
    }
    for (const entry of scenarios.keyModes.uint32) {
      txn.putString(databases.uint32Keys, entry.key, entry.value);
    }
    for (const entry of scenarios.keyModes.binaries) {
      txn.putString(databases.binaryKeys, bytes(entry.key), entry.value);
    }
    for (const value of scenarios.duplicates.values) {
      txn.putBinary(
        databases.duplicates,
        scenarios.duplicates.key,
        bytes(value),
      );
    }
    for (const value of scenarios.duplicates.fixedValues) {
      txn.putBinary(
        databases.dupfixed,
        scenarios.duplicates.fixedKey,
        bytes(value),
      );
    }
    for (const entry of scenarios.batch.seed) {
      txn.putBinary(databases.batch, entry.key, bytes(entry.value));
    }
  });
}

function observeValues(env, databases, scenarios) {
  return withReadTransaction(env, (txn) => ({
    strings: scenarios.values.strings.map((entry) =>
      requirePresent(txn.getString(databases.strings, entry.key), entry.key)
    ),
    numbers: scenarios.values.numbers.map((entry) =>
      normalizeNumber(
        requirePresent(txn.getNumber(databases.numbers, entry.key), entry.key),
      )
    ),
    booleans: scenarios.values.booleans.map((entry) =>
      requirePresent(txn.getBoolean(databases.booleans, entry.key), entry.key)
    ),
    binaries: scenarios.values.binaries.map((entry) =>
      toHex(
        requirePresent(txn.getBinary(databases.binaries, entry.key), entry.key),
      )
    ),
  }));
}

function observeKeyValues(env, databases, bytes, scenarios) {
  return withReadTransaction(env, (txn) => ({
    strings: scenarios.keyModes.strings.map((entry) =>
      observeStringPayload(
        txn,
        databases.stringKeys,
        entry.key,
        entry.key,
        entry.value,
      )
    ),
    uint32: scenarios.keyModes.uint32.map((entry) =>
      observeStringPayload(
        txn,
        databases.uint32Keys,
        entry.key,
        entry.key,
        entry.value,
      )
    ),
    binaries: scenarios.keyModes.binaries.map((entry) =>
      observeStringPayload(
        txn,
        databases.binaryKeys,
        bytes(entry.key),
        entry.key,
        entry.value,
      )
    ),
  }));
}

function observeStringPayload(txn, database, lookupKey, outputKey, expected) {
  const value = toHex(
    requirePresent(txn.getBinary(database, lookupKey), String(outputKey)),
  );
  invariant(
    value === encodeStringHex(expected),
    `key-mode payload ${outputKey} changed`,
  );
  return { key: outputKey, value };
}

function observeCursors(Cursor, env, databases, bytes, scenarios) {
  return withReadTransaction(env, (txn) => {
    const stringKeys = collectKeys(
      new Cursor(txn, databases.stringKeys),
      scenarios.keyModes.strings.length,
      (key) => requireType(key, 'string'),
    );
    const uint32Keys = collectKeys(
      new Cursor(txn, databases.uint32Keys),
      scenarios.keyModes.uint32.length,
      (key) => requireType(key, 'number'),
    );
    const binaryKeys = collectKeys(
      new Cursor(txn, databases.binaryKeys),
      scenarios.keyModes.binaries.length,
      (key) => `hex:${toHex(key)}`,
    );
    const duplicates = collectDuplicateValues(
      Cursor,
      txn,
      databases.duplicates,
      scenarios.duplicates.key,
      scenarios.duplicates.values.length,
    );
    const fixed = collectDuplicateValues(
      Cursor,
      txn,
      databases.dupfixed,
      scenarios.duplicates.fixedKey,
      scenarios.duplicates.fixedValues.length,
    );
    const duplicateNavigation = observeDuplicateNavigation(
      Cursor,
      txn,
      databases.duplicates,
      bytes,
      scenarios.duplicates,
    );
    return {
      keys: [...stringKeys, ...uint32Keys, ...binaryKeys],
      duplicates: [...duplicates, ...fixed],
      duplicateNavigation,
    };
  });
}

function collectKeys(cursor, expectedCount, normalize) {
  try {
    const keys = [];
    let key = cursor.goToFirst();
    while (key !== null && keys.length <= expectedCount) {
      keys.push(normalize(key));
      key = cursor.goToNext();
    }
    invariant(key === null, 'cursor traversal exceeded its scenario bound');
    invariant(keys.length === expectedCount, 'cursor key count changed');
    return keys;
  } finally {
    cursor.close();
  }
}

function collectDuplicateValues(Cursor, txn, database, key, expectedCount) {
  const cursor = new Cursor(txn, database);
  try {
    const values = [];
    let found = cursor.goToKey(key);
    while (found !== null && values.length <= expectedCount) {
      values.push(toHex(cursor.getCurrentBinary()));
      found = cursor.goToNextDup();
    }
    invariant(
      found === null,
      'duplicate traversal exceeded its scenario bound',
    );
    invariant(values.length === expectedCount, 'duplicate count changed');
    return values;
  } finally {
    cursor.close();
  }
}

function observeDuplicateNavigation(
  Cursor,
  txn,
  database,
  bytes,
  duplicates,
) {
  const cursor = new Cursor(txn, database);
  try {
    invariant(cursor.goToKey(duplicates.key) !== null, 'duplicate key missing');
    const atKey = toHex(cursor.getCurrentBinary());
    invariant(cursor.goToFirstDup() !== null, 'first duplicate missing');
    const first = toHex(cursor.getCurrentBinary());
    invariant(cursor.goToLastDup() !== null, 'last duplicate missing');
    const last = toHex(cursor.getCurrentBinary());
    const exactValue = duplicates.values[1];
    invariant(
      cursor.goToDup(duplicates.key, bytes(exactValue)) !== null,
      'exact duplicate missing',
    );
    return [atKey, first, last, toHex(cursor.getCurrentBinary())];
  } finally {
    cursor.close();
  }
}

async function observeBatch(env, database, bytes, batchScenario) {
  const operations = batchScenario.operations.map((operation) => ({
    db: database,
    key: operation.key,
    value: operation.kind === 'delete' ? null : bytes(operation.value),
    ...(operation.ifKey === undefined ? {} : {
      ifDB: database,
      ifKey: operation.ifKey,
      ifValue: bytes(operation.ifValue),
      ifExactMatch: operation.ifExactMatch,
    }),
  }));
  const completion = await new Promise((resolve) => {
    env.batchWrite(
      operations,
      (error, results) => {
        resolve({ error, results });
      },
    );
  });
  if (completion.error !== null) throw completion.error;
  invariant(
    Array.isArray(completion.results),
    'batch final callback did not return a result array',
  );
  invariant(
    completion.results.length === batchScenario.expectedResults.length &&
      completion.results.every(
        (result, index) => result === batchScenario.expectedResults[index],
      ),
    'batch result codes or order changed',
  );
  return {
    results: Array.from(completion.results),
    callbackOrder: ['final'],
  };
}

function assertBatchCommitted(env, database, bytes) {
  withReadTransaction(env, (txn) => {
    invariant(
      toHex(txn.getBinary(database, 'created')) === 'aa',
      'batch put missing',
    );
    invariant(
      txn.getBinary(database, 'condition-failed') === null,
      'failed conditional batch operation was applied',
    );
    invariant(
      toHex(txn.getBinary(database, 'condition-prefix')) === 'cc',
      'prefix conditional batch operation missing',
    );
    invariant(toHex(bytes('aa')) === 'aa', 'runtime byte adapter changed data');
  });
}

function observePublicErrors(env, databases, scenarios) {
  const errors = [];
  invariant(scenarios.errors[0] === 'missing-database', 'error order changed');
  errors.push(captureError('missing-database', () => {
    env.openDbi({ name: 'semantic-missing-database' });
  }));

  invariant(scenarios.errors[1] === 'read-only-write', 'error order changed');
  const readonly = env.beginTxn({ readOnly: true });
  try {
    errors.push(captureError('read-only-write', () => {
      readonly.putString(databases.strings, 'readonly', 'rejected');
    }));
  } finally {
    readonly.abort();
  }

  invariant(scenarios.errors[2] === 'duplicate-key', 'error order changed');
  const duplicate = env.beginTxn();
  try {
    errors.push(captureError('duplicate-key', () => {
      duplicate.putString(
        databases.strings,
        scenarios.values.strings[0].key,
        'rejected',
        { noOverwrite: true },
      );
    }));
  } finally {
    duplicate.abort();
  }
  return errors;
}

function captureError(operation, body) {
  try {
    body();
  } catch (error) {
    const normalized = {
      operation,
      name: error instanceof Error ? error.name : 'Error',
    };
    if (typeof error?.code === 'number') normalized.code = error.code;
    return normalized;
  }
  throw new Error(`${operation} did not throw`);
}

function withWriteTransaction(env, body) {
  let txn = env.beginTxn();
  try {
    const result = body(txn);
    txn.commit();
    txn = undefined;
    return result;
  } finally {
    txn?.abort();
  }
}

function withReadTransaction(env, body) {
  const txn = env.beginTxn({ readOnly: true });
  try {
    return body(txn);
  } finally {
    txn.abort();
  }
}

function parseNumber(value) {
  switch (value) {
    case '-0':
      return -0;
    case 'NaN':
      return Number.NaN;
    case 'Infinity':
      return Number.POSITIVE_INFINITY;
    case '-Infinity':
      return Number.NEGATIVE_INFINITY;
    default:
      return Number(value);
  }
}

function normalizeNumber(value) {
  if (Object.is(value, -0)) return '-0';
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

function encodeStringHex(value) {
  const hex = [];
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    hex.push(
      (codeUnit & 0xFF).toString(16).padStart(2, '0'),
      (codeUnit >>> 8).toString(16).padStart(2, '0'),
    );
  }
  return `${hex.join('')}0000`;
}

function toHex(value) {
  invariant(value !== null && value !== undefined, 'binary value missing');
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function requirePresent(value, key) {
  invariant(value !== null && value !== undefined, `value ${key} missing`);
  return value;
}

function requireType(value, expected) {
  if (expected === 'string') {
    invariant(typeof value === 'string', 'expected string cursor key');
  } else {
    invariant(expected === 'number', 'unsupported cursor key expectation');
    invariant(typeof value === 'number', 'expected number cursor key');
  }
  return value;
}

function validateScenarios(scenarios) {
  invariant(scenarios?.schemaVersion === 2, 'unsupported scenario schema');
  invariant(Array.isArray(scenarios?.errors), 'error scenarios missing');
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
