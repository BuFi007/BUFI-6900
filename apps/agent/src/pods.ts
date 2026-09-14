/**
 * Pods' bytecode API shape (`{ action, to, bytecode, destinationAddress }`)
 * adapted to a conduit request, with the one check the kit also enforces:
 * the destination must be the treasury.
 */
import type { Address } from 'viem'

/** Pods' own caveat, echoed to the model when a request is refused. */
export const PODS_ON_BEHALF_OF_CAVEAT =
  "Pods maps destinationAddress to the protocol's onBehalfOf / to once their fix ships; a destination other than the treasury would hand the position (aToken / vault share) to that address, not to the treasury. Refused."

/** Whether Pods' `destinationAddress` is the treasury that signs. Case-insensitive. */
export function isPodsDestinationTreasury(destinationAddress: string, treasury: Address): boolean {
  return destinationAddress.trim().toLowerCase() === treasury.toLowerCase()
}

/** The refusal text for a mismatched destination, or `null` when it matches. */
export function podsRefusal(destinationAddress: string, treasury: Address): string | null {
  if (isPodsDestinationTreasury(destinationAddress, treasury)) return null
  return `destinationAddress ${destinationAddress} is not the treasury ${treasury}. ${PODS_ON_BEHALF_OF_CAVEAT}`
}
