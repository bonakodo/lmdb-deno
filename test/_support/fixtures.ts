import { withCleanup } from './lifecycle.ts';

export async function withTempDir<T>(
  callback: (path: string) => T | Promise<T>,
): Promise<T> {
  const path = await Deno.makeTempDir({ prefix: 'deno-lmdb-' });
  return await withCleanup(
    () => callback(path),
    [() => removeTempDir(path)],
  );
}

async function removeTempDir(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
