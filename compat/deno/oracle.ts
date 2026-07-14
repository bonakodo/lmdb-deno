import { observeSemantics } from './common.ts';

const [databasePath, scenariosPath, ...extra] = Deno.args;
if (
  databasePath === undefined || scenariosPath === undefined || extra.length > 0
) {
  throw new Error('usage: oracle.ts <database-path> <scenarios-path>');
}

const scenarios = JSON.parse(await Deno.readTextFile(scenariosPath));
const observation = await observeSemantics(databasePath, scenarios);
console.log(JSON.stringify(observation));
