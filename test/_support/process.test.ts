import { assertEquals } from './assertions.ts';
import { withCleanup } from './lifecycle.ts';
import type { ChildRecord } from './process.ts';
import { terminateChildren } from './process.ts';

function deferredOutput(): {
  promise: Promise<Deno.CommandOutput>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<Deno.CommandOutput>((accept) => {
    resolve = () =>
      accept({
        code: 0,
        signal: null,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
  });
  return { promise, resolve };
}

function record(
  kill: () => void,
  output: Promise<Deno.CommandOutput>,
): ChildRecord {
  return {
    child: { kill },
    output,
    finished: false,
  };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

function handledRejection(error: Error): Promise<Deno.CommandOutput> {
  const promise = Promise.reject<Deno.CommandOutput>(error);
  promise.catch(() => {});
  return promise;
}

Deno.test('terminateChildren kills every child before awaiting settlement', async () => {
  const firstOutput = deferredOutput();
  const secondOutput = deferredOutput();
  const firstKillError = new Error('first kill failed');
  const kills: string[] = [];
  const children = [
    record(() => {
      kills.push('first');
      throw firstKillError;
    }, firstOutput.promise),
    record(() => {
      kills.push('second');
    }, secondOutput.promise),
  ];

  const cleanup = terminateChildren(children, 1_000, 'test children');
  let settled = false;
  cleanup.then(
    () => settled = true,
    () => settled = true,
  );

  assertEquals(kills, ['first', 'second']);
  await Promise.resolve();
  assertEquals(settled, false);

  firstOutput.resolve();
  secondOutput.resolve();
  assertEquals(await captureRejection(cleanup), firstKillError);
  assertEquals(settled, true);
});

Deno.test('terminateChildren reports the first rejected output after all settle', async () => {
  const firstOutputError = new Error('first output failed');
  const secondOutputError = new Error('second output failed');
  const kills: string[] = [];
  const children = [
    record(() => kills.push('first'), handledRejection(firstOutputError)),
    record(() => kills.push('second'), handledRejection(secondOutputError)),
  ];

  const error = await captureRejection(
    terminateChildren(children, 1_000, 'test children'),
  );

  assertEquals(kills, ['first', 'second']);
  assertEquals(error, firstOutputError);
});

Deno.test('withCleanup preserves body errors from child cleanup failures', async () => {
  const primaryError = new Error('primary');
  const kills: string[] = [];
  const children = [
    record(
      () => {
        kills.push('first');
        throw new Error('cleanup');
      },
      Promise.resolve({
        code: 0,
        signal: null,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }),
    ),
    record(
      () => kills.push('second'),
      Promise.resolve({
        code: 0,
        signal: null,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }),
    ),
  ];

  const error = await captureRejection(
    withCleanup(
      () => {
        throw primaryError;
      },
      [() => terminateChildren(children, 1_000, 'test children')],
    ),
  );

  assertEquals(kills, ['first', 'second']);
  assertEquals(error, primaryError);
});
