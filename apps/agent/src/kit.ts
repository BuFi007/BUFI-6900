/**
 * Binds the app to a `TreasuryKit`: the real `@bufi6900/treasury-kit` by default,
 * or the in-memory `kit-stub.ts` when `AGENT_KIT=stub` (tests, and the demo before
 * the kit lands).
 */
import type { TreasuryKit } from './kit-contract.js'

/** Package specifier of the real kit. A variable so the import is resolved at runtime only. */
const REAL_KIT = '@bufi6900/treasury-kit'

/** Which kit `loadKit` will bind: `'stub'` under `AGENT_KIT=stub`, `'real'` otherwise. */
export function kitMode(env: NodeJS.ProcessEnv = process.env): 'stub' | 'real' {
  return env.AGENT_KIT?.trim().toLowerCase() === 'stub' ? 'stub' : 'real'
}

/**
 * Load the kit the app runs against.
 *
 * The real kit is imported through a runtime specifier so this app typechecks
 * before the kit's source exists; once it lands, a static
 * `import * as kit from '@bufi6900/treasury-kit'` here is the one-line integration.
 */
export async function loadKit(env: NodeJS.ProcessEnv = process.env): Promise<TreasuryKit> {
  if (kitMode(env) === 'stub') {
    const { stubKit } = await import('./kit-stub.js')
    return stubKit
  }
  const mod: unknown = await import(REAL_KIT)
  return mod as TreasuryKit
}
