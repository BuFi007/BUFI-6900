/**
 * Environment variable reader — the two helpers this package needs, lifted
 * from BUFI desk's `@bu/env` so `@bufi6900/the-graph` stands alone.
 *
 * Resolution order: override → process.env → globalThis.__BU_ENV__, which is
 * what lets the same code read config in Node, Cloudflare Workers and edge
 * runtimes without a per-runtime shim.
 */

declare global {
  var __BU_ENV__: Record<string, string> | undefined;
}

/** Resolve an env var with override-first semantics; undefined when unset. */
export function resolve(key: string, override?: string): string | undefined {
  if (override !== undefined && override !== '') return override;
  if (typeof process !== 'undefined' && process.env?.[key] !== undefined) {
    return process.env[key];
  }
  return globalThis.__BU_ENV__?.[key];
}

/** Resolve an env var, throwing a named error if it is missing. */
export function required(key: string, override?: string): string {
  const value = resolve(key, override);
  if (value === undefined || value === '') {
    throw new Error(`[env] Missing required environment variable: ${key}`);
  }
  return value;
}
