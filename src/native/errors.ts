const KNOWN_MESSAGES = new Map<number, string>([
  [-30798, 'MDB_NOTFOUND: No matching key/data pair found'],
  [-30799, 'MDB_KEYEXIST: Key/data pair already exists'],
  [-30781, 'MDB_BAD_VALSIZE: Unsupported size of key/DB name/data'],
  [-30778, 'MDB_BAD_CHECKSUM: Page checksum incorrect'],
  [
    -30774,
    "MDB_CANT_ROLLBACK: Environment can't rollback the last transaction",
  ],
  [-30773, "MDB_DBIS_BUSY: Can't drop main DBI while other DBIs are open"],
  [-30771, "MDB_ENV_BUSY: Env is busy, can't use previous snapshot"],
  [-30770, "MDB_IS_READONLY: Env or txn is read-only, can't write"],
  [-30769, 'MDB_ADDR_BUSY: Requested map address is unavailable'],
  [13, 'Permission denied'],
]);

/**
 * Error returned by LMDB or its operating-system integration.
 *
 * The numeric {@link LmdbError.code} is stable for programmatic checks even
 * when a platform supplies different message text. Instances retain the
 * public `Error` name exposed by node-lmdb while the exported subclass keeps
 * numeric-code checks type-safe.
 */
export class LmdbError extends Error {
  /** Numeric LMDB result or operating-system error code. */
  readonly code: number;

  /**
   * Creates an LMDB error with its native numeric code.
   *
   * Applications normally receive instances from package operations rather
   * than constructing them directly.
   *
   * @param code Native LMDB or operating-system result code.
   * @param message Human-readable message including the code.
   */
  constructor(code: number, message: string) {
    super(message);
    this.name = 'Error';
    this.code = code;
  }
}

/** Throws an `LmdbError` when a native LMDB return code is non-zero. */
export function checkLmdbResult(
  code: number,
  strerror?: (code: number) => Deno.PointerValue,
): void {
  if (code === 0) return;
  const nativeMessage = KNOWN_MESSAGES.get(code) ?? readNativeMessage(
    code,
    strerror,
  );
  throw new LmdbError(code, `lmdb[#${code}]: ${nativeMessage}`);
}

/**
 * Preserves the error exposed by node-lmdb for write attempts on read-only
 * state. LMDB 1.0 renamed the native result from `EACCES` to
 * `MDB_IS_READONLY`; callers use this only at matching public API boundaries.
 */
export function checkNodeWriteResult(
  code: number,
  strerror?: (code: number) => Deno.PointerValue,
): void {
  checkLmdbResult(code === -30770 ? 13 : code, strerror);
}

function readNativeMessage(
  code: number,
  strerror?: (code: number) => Deno.PointerValue,
): string {
  if (!strerror) return `LMDB error ${code}`;
  try {
    const pointer = strerror(code);
    if (pointer === null) return `LMDB error ${code}`;
    return new Deno.UnsafePointerView(pointer).getCString();
  } catch {
    // Path-scoped FFI permission may prohibit reading arbitrary pointers.
    return `LMDB error ${code}`;
  }
}
