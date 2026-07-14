export type Key = string | number | Uint8Array;

export type Value = string | number | boolean | Uint8Array;

export type KeyType =
  | {
    keyIsUint32?: boolean;
    keyIsBuffer?: never;
    keyIsString?: never;
  }
  | {
    keyIsUint32?: never;
    keyIsBuffer?: boolean;
    keyIsString?: never;
  }
  | {
    keyIsUint32?: never;
    keyIsBuffer?: never;
    keyIsString?: boolean;
  };

export interface Version {
  readonly versionString: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface EnvOptions {
  path: string;
  mapSize?: number;
  maxDbs?: number;
  maxReaders?: number;
  noSubdir?: boolean;
  readOnly?: boolean;
  useWritemap?: boolean;
  usePreviousSnapshot?: boolean;
  noMemInit?: boolean;
  noReadAhead?: boolean;
  noMetaSync?: boolean;
  noSync?: boolean;
  mapAsync?: boolean;
  unsafeNoLock?: boolean;
  useWorker?: boolean;
}

export interface TxnOptions {
  readOnly?: boolean;
}

type OptionalKeyType =
  | {
    keyIsUint32?: boolean;
    keyIsBuffer?: never;
    keyIsString?: never;
  }
  | {
    keyIsUint32?: never;
    keyIsBuffer?: boolean;
    keyIsString?: never;
  }
  | {
    keyIsUint32?: never;
    keyIsBuffer?: never;
    keyIsString?: boolean;
  };

export type DbiOptions = {
  name: string | null;
  create?: boolean;
  reverseKey?: boolean;
  dupSort?: boolean;
  dupFixed?: boolean;
  integerDup?: boolean;
  reverseDup?: boolean;
  txn?: TxnContract;
} & OptionalKeyType;

export interface DropOptions {
  txn?: TxnContract;
  justFreePages?: boolean;
}

export type PutOptions = {
  noDupData?: boolean;
  noOverwrite?: boolean;
  append?: boolean;
  appendDup?: boolean;
} & OptionalKeyType;

export interface DelOptions {
  noDupData: boolean;
}

export interface Stat {
  pageSize: number;
  treeDepth: number;
  treeBranchPageCount: number;
  treeLeafPageCount: number;
  entryCount: number;
  overflowPages: number;
}

export interface Info {
  mapAddress: number;
  mapSize: number;
  lastPageNumber: number;
  lastTxnId: number;
  maxReaders: number;
  numReaders: number;
}

export enum BatchResult {
  SUCCESS = 0,
  CONDITION_NOT_MET = 1,
  NOT_FOUND = 2,
  BAD_VALSIZE = 3,
}

export interface BatchOperation {
  db: DbiContract;
  key: Key;
  value?: Value | null;
  ifValue?: Value | null;
  ifExactMatch?: boolean;
  ifKey?: Key;
  ifDB?: DbiContract;
}

export type BatchOperationArray =
  | [db: DbiContract, key: Key]
  | [db: DbiContract, key: Key, value: Value | null]
  | [
    db: DbiContract,
    key: Key,
    value: Value | null,
    ifValue: Value | null,
  ];

export type BatchOperationInput = BatchOperation | BatchOperationArray;

export type BatchProgress = (results: BatchResult[]) => void;

export type BatchOptions = PutOptions & {
  progress?: BatchProgress;
};

export type BatchCallback = (
  error: Error | null,
  results?: BatchResult[],
) => void;

export type SyncCallback = (error: Error | null) => void;

export type CopyCallback = (error: Error | null) => void;

export type CursorCallback<T extends Value> = (key: Key, value: T) => void;

export interface EnvContract {
  open(options: EnvOptions): void;
  openDbi(options: DbiOptions): DbiContract;
  beginTxn(options?: TxnOptions): TxnContract;
  detachBuffer(buffer: ArrayBuffer): void;
  stat(): Stat;
  info(): Info;
  resize(size: number): void;
  sync(callback: SyncCallback): void;
  sync(): Promise<void>;
  copy(path: string, callback: CopyCallback): void;
  copy(path: string, compact: boolean, callback: CopyCallback): void;
  copy(
    path: string,
    compact: boolean | undefined,
    callback: CopyCallback,
  ): void;
  copy(path: string, compact?: boolean): Promise<void>;
  batchWrite(
    operations: BatchOperationInput[],
    callback: BatchCallback,
  ): void;
  batchWrite(
    operations: BatchOperationInput[],
    options: BatchOptions,
    callback: BatchCallback,
  ): void;
  close(): void;
}

export interface DbiContract {
  close(): void;
  drop(options?: DropOptions): void;
  stat(txn: TxnContract): Stat;
}

export interface TxnContract {
  getString(dbi: DbiContract, key: Key, options?: KeyType): string | null;
  getStringUnsafe(
    dbi: DbiContract,
    key: Key,
    options?: KeyType,
  ): string | null;
  getBinary(
    dbi: DbiContract,
    key: Key,
    options?: KeyType,
  ): Uint8Array | null;
  getBinaryUnsafe(
    dbi: DbiContract,
    key: Key,
    options?: KeyType,
  ): Uint8Array | null;
  getNumber(dbi: DbiContract, key: Key, options?: KeyType): number | null;
  getBoolean(dbi: DbiContract, key: Key, options?: KeyType): boolean | null;
  putString(
    dbi: DbiContract,
    key: Key,
    value: string,
    options?: PutOptions,
  ): void;
  putBinary(
    dbi: DbiContract,
    key: Key,
    value: Uint8Array,
    options?: PutOptions,
  ): void;
  putNumber(
    dbi: DbiContract,
    key: Key,
    value: number,
    options?: PutOptions,
  ): void;
  putBoolean(
    dbi: DbiContract,
    key: Key,
    value: boolean,
    options?: PutOptions,
  ): void;
  del(dbi: DbiContract, key: Key): void;
  del(dbi: DbiContract, key: Key, options: KeyType): void;
  del(dbi: DbiContract, key: Key, value: Value): void;
  del(dbi: DbiContract, key: Key, value: Value, options: KeyType): void;
  commit(): void;
  abort(): void;
  reset(): void;
  renew(): void;
}

export interface CursorContract<T extends Key = string> {
  goToFirst(options?: KeyType): T | null;
  goToLast(options?: KeyType): T | null;
  goToNext(options?: KeyType): T | null;
  goToPrev(options?: KeyType): T | null;
  goToKey(key: T, options?: KeyType): T | null;
  goToRange(key: T, options?: KeyType): T | null;
  goToFirstDup(options?: KeyType): T | null;
  goToLastDup(options?: KeyType): T | null;
  goToNextDup(options?: KeyType): T | null;
  goToPrevDup(options?: KeyType): T | null;
  goToDup(key: T, data: Value, options?: KeyType): T | null;
  goToDupRange(key: T, data: Value, options?: KeyType): T | null;
  getCurrentNumber(callback?: CursorCallback<number>): number | null;
  getCurrentBoolean(callback?: CursorCallback<boolean>): boolean | null;
  getCurrentString(callback?: CursorCallback<string>): string | null;
  getCurrentBinary(
    callback?: CursorCallback<Uint8Array>,
  ): Uint8Array | null;
  getCurrentStringUnsafe(callback?: CursorCallback<string>): string | null;
  getCurrentBinaryUnsafe(
    callback?: CursorCallback<Uint8Array>,
  ): Uint8Array | null;
  del(options?: DelOptions): void;
  close(): void;
}

export interface LmdbModule {
  readonly version: Version;
  readonly Env: new () => EnvContract;
  readonly Cursor: new <T extends Key = string>(
    txn: TxnContract,
    dbi: DbiContract,
    keyType?: KeyType,
  ) => CursorContract<T>;
}
