export type Cleanup = () => void | Promise<void>;

export async function withCleanup<T>(
  body: () => T | Promise<T>,
  cleanups: readonly Cleanup[],
): Promise<T> {
  let bodyFailed = false;
  let bodyError: unknown;
  let result!: T;

  try {
    result = await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let hasCleanupError = false;
  let firstCleanupError: unknown;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      if (!hasCleanupError) {
        hasCleanupError = true;
        firstCleanupError = error;
      }
    }
  }

  if (bodyFailed) throw bodyError;
  if (hasCleanupError) throw firstCleanupError;
  return result;
}

export class DeadlineError extends Error {
  override name = 'DeadlineError';
}

export async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DeadlineError(
          `${operation} did not settle within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
