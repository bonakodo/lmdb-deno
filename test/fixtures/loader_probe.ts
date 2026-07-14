interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly cause?: SerializedError;
}

interface LoaderProbeModule {
  readonly resolveLibraryCandidates: (value: string | undefined) => string[];
  readonly loadLibrary: () => {
    readonly path: string;
    readonly version: {
      readonly versionString: string;
      readonly major: number;
      readonly minor: number;
      readonly patch: number;
    };
    readonly handle: { close(): void };
  };
}

function serializeError(value: unknown): SerializedError {
  if (!(value instanceof Error)) {
    return { name: typeof value, message: String(value) };
  }

  return {
    name: value.name,
    message: value.message,
    ...(value.cause === undefined
      ? {}
      : { cause: serializeError(value.cause) }),
  };
}

try {
  const action = Deno.args[0];
  const libraryUrl = new URL(
    ['..', '..', 'src', 'native', 'library.ts'].join('/'),
    import.meta.url,
  ).href;
  const library = await import(libraryUrl) as LoaderProbeModule;

  if (action === 'resolve') {
    const value = Deno.args[1] === '<unset>' ? undefined : Deno.args[1];
    console.log(JSON.stringify({
      ok: true,
      candidates: library.resolveLibraryCandidates(value),
    }));
  } else if (action === 'load-env') {
    const loaded = library.loadLibrary();
    const result = {
      ok: true,
      path: loaded.path,
      version: loaded.version,
    };
    loaded.handle.close();
    console.log(JSON.stringify(result));
  } else if (action === 'construct-env') {
    const moduleUrl = new URL(
      ['..', '..', 'mod.ts'].join('/'),
      import.meta.url,
    ).href;
    const { Env } = await import(moduleUrl) as {
      readonly Env: new () => { close(): void };
    };
    const env = new Env();
    env.close();
    console.log(JSON.stringify({ ok: true }));
  } else {
    throw new Error(`Unknown loader probe action: ${action ?? '<missing>'}`);
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: serializeError(error) }));
}
