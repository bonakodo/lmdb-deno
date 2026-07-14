import type { LmdbModule } from './contract.ts';

let cachedSubject: Promise<LmdbModule> | undefined;

export async function loadSubject(): Promise<LmdbModule> {
  if (!cachedSubject) {
    const subjectUrl = new URL('../../mod.ts', import.meta.url).href;
    cachedSubject = import(subjectUrl).then((module) => module as LmdbModule);
  }
  return await cachedSubject;
}
