import { readFile } from 'node:fs/promises';

if (process.version !== 'v22.23.1') {
  throw new Error(
    `Node.js 22.23.1 LTS is required; found ${process.version}`,
  );
}

const { observeSemantics } = await import('./common.mjs');

const [databasePath, scenariosPath, ...extra] = process.argv.slice(2);
if (
  databasePath === undefined || scenariosPath === undefined || extra.length > 0
) {
  throw new Error('usage: oracle.mjs <database-path> <scenarios-path>');
}

const scenarios = JSON.parse(await readFile(scenariosPath, 'utf8'));
const observation = await observeSemantics(databasePath, scenarios);
process.stdout.write(`${JSON.stringify(observation)}\n`);
