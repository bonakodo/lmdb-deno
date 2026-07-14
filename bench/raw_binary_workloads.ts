import { Cursor, type Dbi, Env, type Txn } from '../mod.ts';
// deno-lint-ignore no-import-prefix -- keep the comparison dependency benchmark-local and version-pinned
import { open, type RootDatabase, type Transaction } from 'npm:lmdb@3.5.6';

export interface BinaryRecord {
  key: Uint8Array;
  value: Uint8Array;
}

export interface ScanObservation {
  count: number;
  checksum: number;
}

export interface RawBinaryStore {
  writeBatch(records: readonly BinaryRecord[]): void;
  readSafe(key: Uint8Array): Uint8Array | null;
  readUnsafe(key: Uint8Array): Uint8Array | null;
  scan(): ScanObservation;
  close(): void | Promise<void>;
}

export function createDataset(
  count: number,
  valueSize: number,
  generation: number,
): BinaryRecord[] {
  const records: BinaryRecord[] = [];
  for (let index = 0; index < count; index++) {
    const key = new Uint8Array(4);
    new DataView(key.buffer).setUint32(0, index, false);

    const value = new Uint8Array(valueSize);
    for (let offset = 0; offset < value.length; offset++) {
      value[offset] = (index * 31 + generation * 17 + offset) & 0xff;
    }
    records.push({ key, value });
  }
  return records;
}

export function expectedScan(
  records: readonly BinaryRecord[],
): ScanObservation {
  let checksum = 0;
  for (const { value } of records) {
    checksum = (checksum + checksumBytes(value)) >>> 0;
  }
  return { count: records.length, checksum };
}

export function openDenoLmdbStore(
  path: string,
  mapSize: number,
): RawBinaryStore {
  return new DenoLmdbStore(path, mapSize);
}

export function openLmdbJsStore(
  path: string,
  mapSize: number,
): RawBinaryStore {
  return new LmdbJsStore(path, mapSize);
}

class DenoLmdbStore implements RawBinaryStore {
  readonly #env = new Env();
  readonly #dbi: Dbi;
  #readTxn: Txn | undefined;

  constructor(path: string, mapSize: number) {
    Deno.mkdirSync(path, { recursive: true });
    this.#env.open({ path, mapSize });
    this.#dbi = this.#env.openDbi({
      name: null,
      create: true,
      keyIsBuffer: true,
    });
  }

  writeBatch(records: readonly BinaryRecord[]): void {
    this.#finishRead();
    const txn = this.#env.beginTxn();
    let commitAttempted = false;
    try {
      for (const { key, value } of records) {
        txn.putBinary(this.#dbi, key, value);
      }
      commitAttempted = true;
      txn.commit();
    } catch (error) {
      if (!commitAttempted) txn.abort();
      throw error;
    }
  }

  readSafe(key: Uint8Array): Uint8Array | null {
    return this.#read().getBinary(this.#dbi, key);
  }

  readUnsafe(key: Uint8Array): Uint8Array | null {
    return this.#read().getBinaryUnsafe(this.#dbi, key);
  }

  scan(): ScanObservation {
    const cursor = new Cursor<Uint8Array>(this.#read(), this.#dbi);
    let count = 0;
    let checksum = 0;
    try {
      for (
        let key = cursor.goToFirst();
        key !== null;
        key = cursor.goToNext()
      ) {
        const value = cursor.getCurrentBinary();
        if (value === null) throw new Error('cursor lost its current value');
        count++;
        checksum = (checksum + checksumBytes(value)) >>> 0;
      }
    } finally {
      cursor.close();
    }
    return { count, checksum };
  }

  close(): void {
    this.#finishRead();
    this.#dbi.close();
    this.#env.close();
  }

  #read(): Txn {
    return this.#readTxn ??= this.#env.beginTxn({ readOnly: true });
  }

  #finishRead(): void {
    this.#readTxn?.abort();
    this.#readTxn = undefined;
  }
}

class LmdbJsStore implements RawBinaryStore {
  readonly #db: RootDatabase<Uint8Array, Uint8Array>;
  #readTxn: Transaction | undefined;

  constructor(path: string, mapSize: number) {
    Deno.mkdirSync(path, { recursive: true });
    this.#db = open<Uint8Array, Uint8Array>({
      path,
      mapSize,
      encoding: 'binary',
      keyEncoding: 'binary',
    });
  }

  writeBatch(records: readonly BinaryRecord[]): void {
    this.#finishRead();
    this.#db.transactionSync(() => {
      for (const { key, value } of records) this.#db.putSync(key, value);
    });
  }

  readSafe(key: Uint8Array): Uint8Array | null {
    return this.#db.get(key, { transaction: this.#read() }) ?? null;
  }

  readUnsafe(key: Uint8Array): Uint8Array | null {
    this.#finishRead();
    return this.#db.getBinaryFast(key) ?? null;
  }

  scan(): ScanObservation {
    let count = 0;
    let checksum = 0;
    for (
      const { value } of this.#db.getRange({ transaction: this.#read() })
    ) {
      count++;
      checksum = (checksum + checksumBytes(value)) >>> 0;
    }
    return { count, checksum };
  }

  async close(): Promise<void> {
    this.#finishRead();
    await this.#db.close();
  }

  #read(): Transaction {
    return this.#readTxn ??= this.#db.useReadTransaction();
  }

  #finishRead(): void {
    this.#readTxn?.done();
    this.#readTxn = undefined;
  }
}

function checksumBytes(value: Uint8Array): number {
  if (value.length === 0) return 0;
  const middle = value[value.length >>> 1];
  return (Math.imul(
    Math.imul(value.length ^ value[0], 16777619) ^ middle,
    16777619,
  ) ^ value[value.length - 1]) >>> 0;
}
