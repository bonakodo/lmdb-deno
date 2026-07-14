import type * as lmdb from '../../mod.ts';
import type {
  BatchCallback,
  BatchOperation,
  BatchOperationArray,
  BatchOperationInput,
  BatchOptions,
  BatchProgress,
  BatchResult,
  CopyCallback,
  CursorCallback,
  Dbi,
  DbiOptions,
  DelOptions,
  DropOptions,
  EnvOptions,
  Info,
  Key,
  KeyType,
  LmdbError,
  PutOptions,
  Stat,
  SyncCallback,
  Txn,
  TxnOptions,
  Value,
  Version,
} from '../../mod.ts';

// Independent node-lmdb declarations. These intentionally do not derive from
// the package aliases: they catch callback-parameter variance regressions in
// the public method overloads.
type NodeSyncCallback = (error: Error) => void;
type NodeCopyCallback = (error: Error) => void;
type NodeBatchCallback = (error: Error, results: BatchResult[]) => void;
type NullCorrectSyncCallback = (error: Error | null) => void;
type NullCorrectCopyCallback = (error: Error | null) => void;
type NullCorrectBatchCallback = (
  error: Error | null,
  results?: BatchResult[],
) => void;

// This function is a compile-time oracle. It is intentionally never called:
// `deno check test/types/compat.test.ts` validates the complete public surface
// without opening an environment or mutating a database.
function assertPublicCompatibility(module: typeof lmdb): void {
  const version: Version = module.version;
  const versionString: string = version.versionString;
  const versionMajor: number = version.major;
  const versionMinor: number = version.minor;
  const versionPatch: number = version.patch;
  const EnvClass: typeof lmdb.Env = module.Env;
  const DbiClass: typeof lmdb.Dbi = module.Dbi;
  const TxnClass: typeof lmdb.Txn = module.Txn;
  const CursorClass: typeof lmdb.Cursor = module.Cursor;

  const binary = new Uint8Array([1, 2, 3]);
  const keys: Key[] = ['string-key', 42, binary];
  const values: Value[] = ['string-value', 42, true, binary];
  const stringKeys: KeyType = { keyIsString: true };
  const numberKeys: KeyType = { keyIsUint32: true };
  const binaryKeys: KeyType = { keyIsBuffer: true };
  const defaultKeys: KeyType = {};
  // @ts-expect-error Key encodings remain mutually exclusive.
  const invalidKeys: KeyType = { keyIsBuffer: true, keyIsString: true };
  const putOptions: PutOptions = {
    noDupData: true,
    noOverwrite: true,
    append: true,
    appendDup: true,
    keyIsBuffer: true,
  };
  const envOptions: EnvOptions = {
    path: '/tmp/type-only-lmdb',
    mapSize: 1024 * 1024,
    maxDbs: 8,
    maxReaders: 64,
    noSubdir: false,
    readOnly: false,
    useWritemap: false,
    usePreviousSnapshot: false,
    noMemInit: false,
    noReadAhead: false,
    noMetaSync: false,
    noSync: false,
    mapAsync: false,
    unsafeNoLock: false,
    useWorker: true,
  };
  const previousSnapshotOptions = {
    path: '/tmp/type-only-previous-snapshot',
    usePreviousSnapshot: true,
  } satisfies EnvOptions;
  const txnOptions: TxnOptions = { readOnly: true };

  const env = new module.Env();
  env.open(envOptions);
  const dbiOptions: DbiOptions = {
    name: null,
    create: true,
    reverseKey: true,
    dupSort: true,
    dupFixed: true,
    integerDup: true,
    reverseDup: true,
    keyIsBuffer: true,
  };
  const dbi: Dbi = env.openDbi(dbiOptions);
  const txn: Txn = env.beginTxn(txnOptions);
  const dbiWithTxn: DbiOptions = {
    name: 'caller-owned',
    create: true,
    txn,
    keyIsString: true,
  };
  const callerOwnedDbi: Dbi = env.openDbi(dbiWithTxn);

  const stringValue: string | null = txn.getString(dbi, binary, binaryKeys);
  const unsafeString: string | null = txn.getStringUnsafe(
    dbi,
    'key',
    stringKeys,
  );
  const binaryValue: Uint8Array | null = txn.getBinary(dbi, 1, numberKeys);
  const unsafeBinary: Uint8Array | null = txn.getBinaryUnsafe(
    dbi,
    binary,
    binaryKeys,
  );
  const numberValue: number | null = txn.getNumber(dbi, 'number', stringKeys);
  const booleanValue: boolean | null = txn.getBoolean(
    dbi,
    'boolean',
    stringKeys,
  );
  txn.putString(dbi, 'string', 'value', putOptions);
  txn.putBinary(dbi, binary, binary, putOptions);
  txn.putNumber(dbi, 1, 3.14, { keyIsUint32: true });
  txn.putBoolean(dbi, 'boolean', true, { keyIsString: true });
  txn.del(dbi, 'key');
  txn.del(dbi, 'key', undefined);
  txn.del(dbi, binary, binaryKeys);
  txn.del(dbi, 'key', 'exact-value');
  txn.del(dbi, 'key', 'exact-value', undefined);
  txn.del(dbi, binary, binary, binaryKeys);
  const keyOnlyDeleteArgs: Parameters<Txn['del']> = [dbi, 'key'];
  const optionsDeleteArgs: Parameters<Txn['del']> = [dbi, binary, binaryKeys];
  const exactDeleteArgs: Parameters<Txn['del']> = [
    dbi,
    binary,
    binary,
    binaryKeys,
  ];
  const undefinedOptionsDeleteArgs: Parameters<Txn['del']> = [
    dbi,
    'key',
    undefined,
  ];
  const undefinedExactOptionsDeleteArgs: Parameters<Txn['del']> = [
    dbi,
    'key',
    'exact-value',
    undefined,
  ];
  // @ts-expect-error An undefined options placeholder cannot add a fifth arg.
  txn.del(dbi, 'key', 'exact-value', undefined, undefined);
  // @ts-expect-error Key options cannot also occupy the value position.
  txn.del(dbi, 'key', binaryKeys, undefined);
  txn.reset();
  txn.renew();
  txn.commit();
  txn.abort();

  const stringCursor = new module.Cursor(txn, dbi, stringKeys);
  const binaryCursor = new module.Cursor<Uint8Array>(txn, dbi, binaryKeys);
  const numberCursor = new module.Cursor<number>(txn, dbi, numberKeys);
  const stringKey: string | null = stringCursor.goToFirst();
  stringCursor.goToLast(stringKeys);
  stringCursor.goToNext();
  stringCursor.goToPrev();
  stringCursor.goToKey('key');
  stringCursor.goToRange('key', stringKeys);
  stringCursor.goToFirstDup();
  stringCursor.goToLastDup();
  stringCursor.goToNextDup();
  stringCursor.goToPrevDup();
  stringCursor.goToDup('key', binary, stringKeys);
  stringCursor.goToDupRange('key', 'value', stringKeys);
  binaryCursor.goToKey(binary, binaryKeys);
  numberCursor.goToKey(1, numberKeys);

  const numberCursorCallback: CursorCallback<number> = (
    key: Key,
    value: number,
  ): void => {
    const typedKey: Key = key;
    const typedValue: number = value;
    void [typedKey, typedValue];
  };
  const canonicalNumberCursorCallback: (
    key: Key,
    value: number,
  ) => void = numberCursorCallback;
  const numberCursorAlias: CursorCallback<number> =
    canonicalNumberCursorCallback;
  const booleanCursorCallback: CursorCallback<boolean> = (
    _key: Key,
    value: boolean,
  ): void => {
    const typedValue: boolean = value;
    void typedValue;
  };
  const canonicalBooleanCursorCallback: (
    key: Key,
    value: boolean,
  ) => void = booleanCursorCallback;
  const booleanCursorAlias: CursorCallback<boolean> =
    canonicalBooleanCursorCallback;
  const stringCursorCallback: CursorCallback<string> = (
    _key: Key,
    value: string,
  ): void => {
    const typedValue: string = value;
    void typedValue;
  };
  const canonicalStringCursorCallback: (
    key: Key,
    value: string,
  ) => void = stringCursorCallback;
  const stringCursorAlias: CursorCallback<string> =
    canonicalStringCursorCallback;
  const binaryCursorCallback: CursorCallback<Uint8Array> = (
    _key: Key,
    value: Uint8Array,
  ): void => {
    const typedValue: Uint8Array = value;
    void typedValue;
  };
  const canonicalBinaryCursorCallback: (
    key: Key,
    value: Uint8Array,
  ) => void = binaryCursorCallback;
  const binaryCursorAlias: CursorCallback<Uint8Array> =
    canonicalBinaryCursorCallback;
  stringCursor.getCurrentNumber(numberCursorCallback);
  stringCursor.getCurrentBoolean(booleanCursorCallback);
  stringCursor.getCurrentString(stringCursorCallback);
  stringCursor.getCurrentBinary(binaryCursorCallback);
  stringCursor.getCurrentStringUnsafe(stringCursorCallback);
  stringCursor.getCurrentBinaryUnsafe(binaryCursorCallback);
  const currentNumber: number | null = stringCursor.getCurrentNumber();
  const currentBoolean: boolean | null = stringCursor.getCurrentBoolean();
  const currentString: string | null = stringCursor.getCurrentString();
  const currentBinary: Uint8Array | null = stringCursor.getCurrentBinary();
  const currentUnsafeString: string | null = stringCursor
    .getCurrentStringUnsafe();
  const currentUnsafeBinary: Uint8Array | null = stringCursor
    .getCurrentBinaryUnsafe();
  const delOptions: DelOptions = { noDupData: true };
  stringCursor.del();
  stringCursor.del(delOptions);
  stringCursor.close();

  const stat: Stat = env.stat();
  const dbStat: Stat = dbi.stat(env.beginTxn({ readOnly: true }));
  const info: Info = env.info();
  const statPageSize: number = stat.pageSize;
  const statTreeDepth: number = stat.treeDepth;
  const statBranchPages: number = stat.treeBranchPageCount;
  const statLeafPages: number = stat.treeLeafPageCount;
  const statEntries: number = stat.entryCount;
  const statOverflowPages: number = stat.overflowPages;
  const infoMapAddress: number = info.mapAddress;
  const infoMapSize: number = info.mapSize;
  const infoLastPageNumber: number = info.lastPageNumber;
  const infoLastTxnId: number = info.lastTxnId;
  const infoMaxReaders: number = info.maxReaders;
  const infoNumReaders: number = info.numReaders;
  env.resize(32 * 1024 * 1024);
  env.detachBuffer(new ArrayBuffer(0));

  const nodeSyncCallback: NodeSyncCallback = (error: Error): void => {
    const typedError: Error = error;
    void typedError;
  };
  const syncCallback: NullCorrectSyncCallback = (
    error: Error | null,
  ): void => {
    const typedError: Error | null = error;
    void typedError;
  };
  const exportedSyncCallback: SyncCallback = syncCallback;
  const canonicalSyncCallback: (error: Error | null) => void = syncCallback;
  const syncAlias: SyncCallback = canonicalSyncCallback;
  env.sync(nodeSyncCallback);
  env.sync(syncCallback);
  env.sync((error) => {
    const successError: typeof error = null;
    void successError;
  });
  const syncPromise: Promise<void> = env.sync();

  const nodeCopyCallback: NodeCopyCallback = (error: Error): void => {
    const typedError: Error = error;
    void typedError;
  };
  const copyCallback: NullCorrectCopyCallback = (
    error: Error | null,
  ): void => {
    const typedError: Error | null = error;
    void typedError;
  };
  const exportedCopyCallback: CopyCallback = copyCallback;
  const canonicalCopyCallback: (error: Error | null) => void = copyCallback;
  const copyAlias: CopyCallback = canonicalCopyCallback;
  env.copy('/tmp/type-only-node-copy', nodeCopyCallback);
  env.copy('/tmp/type-only-node-copy', true, nodeCopyCallback);
  env.copy('/tmp/type-only-node-copy', undefined, nodeCopyCallback);
  env.copy('/tmp/type-only-copy', copyCallback);
  env.copy('/tmp/type-only-copy', true, copyCallback);
  env.copy('/tmp/type-only-copy', undefined, copyCallback);
  env.copy('/tmp/type-only-inline-copy', (error) => {
    const successError: typeof error = null;
    void successError;
  });
  env.copy('/tmp/type-only-inline-compact-copy', true, (error) => {
    const successError: typeof error = null;
    void successError;
  });
  // @ts-expect-error A callback cannot occupy both copy argument positions.
  env.copy('/tmp/type-only-copy', copyCallback, copyCallback);
  const copyPromise: Promise<void> = env.copy('/tmp/type-only-copy');
  const compactCopyPromise: Promise<void> = env.copy(
    '/tmp/type-only-copy',
    true,
  );

  const tupleDelete: BatchOperationArray = [dbi, 'delete-key'];
  const tuplePut: BatchOperationArray = [dbi, binary, binary];
  const tupleConditional: BatchOperationArray = [dbi, 1, binary, binary];
  const objectOperation: BatchOperation = {
    db: dbi,
    key: binary,
    value: binary,
    ifValue: binary,
    ifExactMatch: true,
    ifKey: 'condition-key',
    ifDB: callerOwnedDbi,
  };
  const objectDelete: BatchOperation = {
    db: dbi,
    key: 'null-delete',
    value: null,
    ifValue: null,
  };
  const operations: BatchOperationInput[] = [
    tupleDelete,
    tuplePut,
    tupleConditional,
    objectOperation,
    objectDelete,
  ];
  let parentOwnedResults: BatchResult[] | undefined;
  const progress: BatchProgress = (results: BatchResult[]): void => {
    parentOwnedResults ??= results;
    const sameObject: boolean = parentOwnedResults === results;
    void sameObject;
  };
  const canonicalProgress: (results: BatchResult[]) => void = progress;
  const progressAlias: BatchProgress = canonicalProgress;
  const batchOptions: BatchOptions = { ...putOptions, progress };
  const nodeBatchCallback: NodeBatchCallback = (
    error: Error,
    results: BatchResult[],
  ): void => {
    const typedError: Error = error;
    const typedResults: BatchResult[] = results;
    void [typedError, typedResults];
  };
  const batchCallback: NullCorrectBatchCallback = (
    error: Error | null,
    results?: BatchResult[],
  ): void => {
    const typedError: Error | null = error;
    const typedResults: BatchResult[] | undefined = results;
    void [typedError, typedResults];
  };
  const exportedBatchCallback: BatchCallback = batchCallback;
  const canonicalBatchCallback: (
    error: Error | null,
    results?: BatchResult[],
  ) => void = batchCallback;
  const batchCallbackAlias: BatchCallback = canonicalBatchCallback;
  env.batchWrite(operations, nodeBatchCallback);
  env.batchWrite(operations, batchOptions, nodeBatchCallback);
  env.batchWrite(operations, batchCallback);
  env.batchWrite(operations, batchOptions, batchCallback);
  env.batchWrite(operations, (error, results) => {
    const successError: typeof error = null;
    const failedResults: typeof results = undefined;
    void [successError, failedResults];
  });
  env.batchWrite(operations, batchOptions, (error, results) => {
    const successError: typeof error = null;
    const failedResults: typeof results = undefined;
    void [successError, failedResults];
  });
  const callbackBatchArgs = [
    operations,
    batchCallback,
  ] satisfies [BatchOperationInput[], BatchCallback];
  const optionsBatchArgs = [
    operations,
    batchOptions,
    batchCallback,
  ] satisfies [BatchOperationInput[], BatchOptions, BatchCallback];
  // @ts-expect-error A completion callback is mandatory.
  env.batchWrite(operations);
  // @ts-expect-error Batch options do not replace the completion callback.
  env.batchWrite(operations, batchOptions);
  const success: BatchResult = module.BatchResult.SUCCESS;
  const conditionNotMet: BatchResult = module.BatchResult.CONDITION_NOT_MET;
  const notFound: BatchResult = module.BatchResult.NOT_FOUND;
  const badValueSize: BatchResult = module.BatchResult.BAD_VALSIZE;
  const nativeError: LmdbError = new module.LmdbError(-30798, 'not found');
  const nativeErrorCode: number = nativeError.code;

  const dropOptions: DropOptions = { txn: env.beginTxn(), justFreePages: true };
  dbi.drop();
  dbi.drop(dropOptions);
  dbi.close();
  env.close();

  void [
    version,
    versionString,
    versionMajor,
    versionMinor,
    versionPatch,
    EnvClass,
    DbiClass,
    TxnClass,
    CursorClass,
    previousSnapshotOptions,
    keys,
    defaultKeys,
    invalidKeys,
    values,
    keyOnlyDeleteArgs,
    optionsDeleteArgs,
    exactDeleteArgs,
    undefinedOptionsDeleteArgs,
    undefinedExactOptionsDeleteArgs,
    stringValue,
    unsafeString,
    binaryValue,
    unsafeBinary,
    numberValue,
    booleanValue,
    stringKey,
    currentNumber,
    currentBoolean,
    currentString,
    currentBinary,
    currentUnsafeString,
    currentUnsafeBinary,
    numberCursorAlias,
    booleanCursorAlias,
    stringCursorAlias,
    binaryCursorAlias,
    stat,
    dbStat,
    info,
    statPageSize,
    statTreeDepth,
    statBranchPages,
    statLeafPages,
    statEntries,
    statOverflowPages,
    infoMapAddress,
    infoMapSize,
    infoLastPageNumber,
    infoLastTxnId,
    infoMaxReaders,
    infoNumReaders,
    syncAlias,
    exportedSyncCallback,
    copyAlias,
    exportedCopyCallback,
    progressAlias,
    batchCallbackAlias,
    exportedBatchCallback,
    callbackBatchArgs,
    optionsBatchArgs,
    syncPromise,
    copyPromise,
    compactCopyPromise,
    success,
    conditionNotMet,
    notFound,
    badValueSize,
    nativeError,
    nativeErrorCode,
  ];
}

void assertPublicCompatibility;
