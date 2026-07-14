/** Values accepted as LMDB keys by the compatibility API. */
export type Key = string | number | Uint8Array;

/** Per-operation key encoding override. */
export type KeyEncoding =
  | { keyIsString?: boolean }
  | { keyIsUint32?: boolean }
  | { keyIsBuffer?: boolean };

/** Encodes a node-lmdb string as zero-terminated UTF-16LE. */
export function encodeString(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return bytes;
}

/** Decodes a zero-terminated UTF-16LE value into a durable JS string. */
export function decodeString(value: Uint8Array): string {
  if (
    value.byteLength < 2 || value.byteLength % 2 !== 0 ||
    value[value.byteLength - 2] !== 0 || value[value.byteLength - 1] !== 0
  ) {
    throw new Error('Invalid zero-terminated UTF-16 string');
  }

  const view = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength - 2,
  );
  const codeUnitCount = view.byteLength / 2;
  const chunkSize = 0x8000;
  let result = '';
  for (let start = 0; start < codeUnitCount; start += chunkSize) {
    const end = Math.min(start + chunkSize, codeUnitCount);
    const codeUnits = new Array<number>(end - start);
    for (let index = start; index < end; index++) {
      codeUnits[index - start] = view.getUint16(index * 2, true);
    }
    result += String.fromCharCode(...codeUnits);
  }
  return result;
}

/** Encodes a JavaScript number as native-endian IEEE-754 Float64. */
export function encodeNumber(value: number): Uint8Array {
  const bytes = new Uint8Array(Float64Array.BYTES_PER_ELEMENT);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
}

/** Decodes a native-endian IEEE-754 Float64. */
export function decodeNumber(value: Uint8Array): number {
  if (value.byteLength !== Float64Array.BYTES_PER_ELEMENT) {
    throw new Error(`Invalid Float64 byte length: ${value.byteLength}`);
  }
  return new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getFloat64(0, true);
}

/** Encodes a boolean using node-lmdb's one-byte representation. */
export function encodeBoolean(value: boolean): Uint8Array {
  return new Uint8Array([value ? 1 : 0]);
}

/** Encodes a key according to its value or an explicit key override. */
export function encodeKey(key: Key, options?: KeyEncoding): Uint8Array {
  if (options && 'keyIsBuffer' in options && options.keyIsBuffer) {
    if (!(key instanceof Uint8Array)) {
      throw new TypeError('Binary keys must be Uint8Array values');
    }
    return key;
  }
  if (options && 'keyIsUint32' in options && options.keyIsUint32) {
    if (typeof key !== 'number') {
      throw new TypeError('Uint32 keys must be numbers');
    }
    return encodeUint32Key(key);
  }
  if (options && 'keyIsString' in options && options.keyIsString) {
    if (typeof key !== 'string') {
      throw new TypeError('String keys must be strings');
    }
    return encodeString(key);
  }

  if (typeof key === 'string') return encodeString(key);
  if (typeof key === 'number') return encodeUint32Key(key);
  return key;
}

/** Encodes a 32-bit unsigned integer in the supported native byte order. */
export function encodeUint32Key(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(
      'Numeric keys must be positive and less than maximum unsigned 32-bit value of 0xFFFFFFFF',
    );
  }
  const bytes = new Uint8Array(Uint32Array.BYTES_PER_ELEMENT);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

/** Decodes a native-endian 32-bit unsigned integer key. */
export function decodeUint32Key(value: Uint8Array): number {
  if (value.byteLength !== Uint32Array.BYTES_PER_ELEMENT) {
    throw new Error(`Invalid Uint32 key byte length: ${value.byteLength}`);
  }
  return new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getUint32(0, true);
}
