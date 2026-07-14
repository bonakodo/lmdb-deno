const endianProbe = new Uint16Array([0x00ff]);
const isLittleEndian = new Uint8Array(endianProbe.buffer)[0] === 0xff;

export function bytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new TypeError('Expected an even-length hexadecimal string');
  }

  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index++) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function readDoubleNative(value: Uint8Array): number {
  return new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getFloat64(0, isLittleEndian);
}
