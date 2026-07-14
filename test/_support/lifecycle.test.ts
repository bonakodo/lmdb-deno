import { assertEquals } from './assertions.ts';
import { withCleanup, withDeadline } from './lifecycle.ts';

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected promise to reject');
}

Deno.test('withCleanup preserves a primary body error', async () => {
  const primaryError = new Error('primary');
  const cleanupError = new Error('cleanup');

  const error = await captureRejection(
    withCleanup(
      () => {
        throw primaryError;
      },
      [() => {
        throw cleanupError;
      }],
    ),
  );

  assertEquals(error, primaryError);
});

Deno.test('withCleanup propagates cleanup errors after a successful body', async () => {
  const cleanupError = new Error('cleanup');
  const calls: string[] = [];

  const error = await captureRejection(
    withCleanup(
      () => calls.push('body'),
      [
        () => {
          calls.push('first cleanup');
          throw cleanupError;
        },
        () => {
          calls.push('second cleanup');
        },
      ],
    ),
  );

  assertEquals(error, cleanupError);
  assertEquals(calls, ['body', 'first cleanup', 'second cleanup']);
});

Deno.test('withDeadline rejects an operation that never settles', async () => {
  const error = await captureRejection(
    withDeadline(new Promise<never>(() => {}), 0, 'copy callback'),
  );

  assertEquals(error.name, 'DeadlineError');
  assertEquals(error.message, 'copy callback did not settle within 0ms');
});
