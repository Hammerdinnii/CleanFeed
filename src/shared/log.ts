import { DEV } from './env';

/**
 * Minimal namespaced logger. Debug output is compiled out of production builds
 * by esbuild's dead-code elimination (DEV is a constant).
 */
export function createLogger(ns: string) {
  const prefix = `[CleanFeed:${ns}]`;
  return {
    debug: (...args: unknown[]) => {
      if (DEV) console.debug(prefix, ...args);
    },
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
