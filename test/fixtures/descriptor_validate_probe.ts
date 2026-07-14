import {
  validateEnvironmentDescriptor,
  type WorkerEnvironmentDescriptor,
} from '../../src/batch/protocol.ts';

const [libraryPath, envAddress, generation, capability] = Deno.args;
if (
  !libraryPath || !envAddress || !generation ||
  (capability !== 'read' && capability !== 'batch')
) {
  throw new Error(
    'Usage: descriptor_validate_probe.ts <library> <address> <generation> <capability>',
  );
}

const descriptor: WorkerEnvironmentDescriptor = {
  libraryPath,
  envAddress: BigInt(envAddress),
  generation: Number(generation),
  capability,
};

try {
  validateEnvironmentDescriptor(descriptor, capability);
} catch {
  console.log('foreign-descriptor-rejected');
  Deno.exit(0);
}
throw new Error('A foreign descriptor was accepted');
