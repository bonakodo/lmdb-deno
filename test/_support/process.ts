import { withDeadline } from './lifecycle.ts';

export interface ChildRecord {
  child: { kill(signal?: Deno.Signal): void };
  output: Promise<Deno.CommandOutput>;
  finished: boolean;
}

export function trackChild(child: Deno.ChildProcess): ChildRecord {
  const record: ChildRecord = {
    child,
    output: Promise.resolve(undefined as never),
    finished: false,
  };
  record.output = child.output().finally(() => {
    record.finished = true;
  });
  return record;
}

export async function terminateChildren(
  children: readonly ChildRecord[],
  timeoutMs: number,
  operation: string,
): Promise<void> {
  const cleanupErrors: unknown[] = [];

  for (const record of children) {
    if (record.finished) continue;
    try {
      record.child.kill('SIGKILL');
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) cleanupErrors.push(error);
    }
  }

  let settlements: PromiseSettledResult<Deno.CommandOutput>[] | undefined;
  try {
    settlements = await withDeadline(
      Promise.allSettled(children.map((record) => record.output)),
      timeoutMs,
      operation,
    );
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (settlements) {
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') {
        cleanupErrors.push(settlement.reason);
      }
    }
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
}
