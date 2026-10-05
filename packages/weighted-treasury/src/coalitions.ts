// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal winning coalitions of a weighted threshold.
 *
 * A set of owners can approve iff its weight reaches the threshold. That rule is monotone, so it is
 * exactly "the set contains at least one MINIMAL winning coalition" (a winning set that stops
 * winning when any one member leaves). Squads has no weights, but each policy is an all-of-k group,
 * and an OR over policies is an OR over groups. One policy per minimal coalition therefore
 * reproduces the weighted rule exactly, with no rounding.
 *
 * The number of minimal coalitions grows combinatorially for skewed weights and is linear (one
 * group) only when weights are uniform. Callers cap it; the compiler refuses past the cap rather
 * than emitting a partial (weaker) set.
 */

export interface WeightedMember {
  id: string
  weight: number
}

/** Hard ceiling on owners for enumeration: 2^n subsets are walked. */
export const MAX_ENUMERABLE_OWNERS = 20

/** True iff the owners in `ids` reach the threshold. The reference rule both backends must match. */
export function isWinning(members: readonly WeightedMember[], thresholdWeight: number, ids: ReadonlySet<string>): boolean {
  let sum = 0
  for (const member of members) if (ids.has(member.id)) sum += member.weight
  return sum >= thresholdWeight
}

/**
 * Every minimal winning coalition, each as member ids in input order, sorted by size then lexically
 * on input position. Deterministic for a given input order.
 */
export function minimalWinningCoalitions(
  members: readonly WeightedMember[],
  thresholdWeight: number,
): string[][] {
  const n = members.length
  if (n > MAX_ENUMERABLE_OWNERS) {
    throw new RangeError(`cannot enumerate coalitions for ${n} owners (max ${MAX_ENUMERABLE_OWNERS})`)
  }

  const weightOf = (mask: number): number => {
    let sum = 0
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += members[i]!.weight
    return sum
  }

  const result: number[] = []
  const total = 1 << n
  for (let mask = 1; mask < total; mask++) {
    const sum = weightOf(mask)
    if (sum < thresholdWeight) continue
    let minimal = true
    for (let i = 0; i < n && minimal; i++) {
      if (mask & (1 << i) && sum - members[i]!.weight >= thresholdWeight) minimal = false
    }
    if (minimal) result.push(mask)
  }

  const popcount = (mask: number): number => {
    let c = 0
    for (let m = mask; m; m &= m - 1) c++
    return c
  }
  result.sort((a, b) => popcount(a) - popcount(b) || lowBitOrder(a, b, n))

  return result.map((mask) => members.filter((_, i) => mask & (1 << i)).map((m) => m.id))
}

/** Lexical order on member positions (lowest index first), so output is stable. */
function lowBitOrder(a: number, b: number, n: number): number {
  for (let i = 0; i < n; i++) {
    const inA = (a >> i) & 1
    const inB = (b >> i) & 1
    if (inA !== inB) return inB - inA
  }
  return 0
}
