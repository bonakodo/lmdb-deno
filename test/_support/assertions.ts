import { ok } from 'node:assert/strict';

export {
  deepStrictEqual as assertEquals,
  notDeepStrictEqual as assertNotEquals,
  throws as assertThrows,
} from 'node:assert/strict';

export function assertExists<T>(
  value: T,
  message?: string | Error,
): asserts value is NonNullable<T> {
  ok(value !== null && value !== undefined, message);
}
