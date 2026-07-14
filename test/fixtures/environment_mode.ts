import { strictEqual as assertEquals } from 'node:assert/strict';
import { Env } from '../../mod.ts';

const path = Deno.args[0];
if (!path) throw new Error('Expected a noSubdir environment path');

const previousUmask = Deno.umask(0);
try {
  const env = new Env();
  env.open({ path, noSubdir: true });
  env.close();
  const mode = (await Deno.stat(path)).mode;
  assertEquals(mode === null ? null : mode & 0o777, 0o664);
  console.log('mode-ok');
} finally {
  Deno.umask(previousUmask);
}
