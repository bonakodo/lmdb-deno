import {
  deepStrictEqual as assertEquals,
  ok as assert,
} from 'node:assert/strict';
import type { BatchResult, DbiContract } from '../_support/contract.ts';
import { withDeadline } from '../_support/lifecycle.ts';
import { loadSubject } from '../_support/subject.ts';

const path = Deno.args[0];
const fault = Deno.args[1];
if (
  !path ||
  (fault !== 'duplicate' && fault !== 'out-of-range' && fault !== 'missing')
) {
  throw new Error(
    'worker_delta_fault.ts requires a path and duplicate|out-of-range|missing',
  );
}

const NativeWorker = Worker;
let injected = false;
const InjectedWorker = function (
  this: Worker,
  specifier: string | URL,
  options?: WorkerOptions,
): Worker {
  const worker = new NativeWorker(specifier, options);
  return new Proxy(worker, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property !== 'onmessage' || typeof value !== 'function') {
        return Reflect.set(target, property, value, target);
      }
      const handler = value as (event: MessageEvent) => void;
      target.onmessage = (event) => {
        const message = event.data as {
          readonly type?: string;
          readonly id?: number;
          readonly deltas?: readonly (readonly [number, number])[];
        };
        if (injected || message.type !== 'progress') {
          handler(event);
          return;
        }
        injected = true;
        if (fault === 'missing') return;
        if (fault === 'duplicate') {
          handler(event);
          handler(event);
          return;
        }
        handler(
          new MessageEvent('message', {
            data: { ...message, deltas: [[999, 0]] },
          }),
        );
      };
      return true;
    },
  });
} as unknown as typeof Worker;
Object.defineProperty(globalThis, 'Worker', {
  ...Object.getOwnPropertyDescriptor(globalThis, 'Worker'),
  value: InjectedWorker,
});

const { Env } = await loadSubject();
const env = new Env();
let dbi: DbiContract | undefined;
let callbackCalls = 0;

try {
  env.open({ path });
  dbi = env.openDbi({ name: null, create: true });
  const completion = await withDeadline(
    new Promise<{ error: Error | null; results?: BatchResult[] }>((resolve) => {
      env.batchWrite(
        [[dbi!, 'key', new Uint8Array([1])]],
        (error, results) => {
          callbackCalls++;
          resolve({ error, results });
        },
      );
    }),
    10_000,
    `${fault} delta fault callback`,
  );
  assert(completion.error instanceof Error);
  assertEquals(completion.results, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(callbackCalls, 1);

  let poisonError: unknown;
  try {
    env.stat();
  } catch (error) {
    poisonError = error;
  }
  assert(poisonError instanceof Error);
  assert(poisonError.message.toLowerCase().includes('poison'));
  env.close();
  console.log(`${fault}-delta-fault-ok`);
} finally {
  try {
    dbi?.close();
  } catch {
    // Poisoned close has already invalidated the DBI wrapper.
  }
  try {
    env.close();
  } catch {
    // Preserve the primary assertion in the isolated process.
  }
}
