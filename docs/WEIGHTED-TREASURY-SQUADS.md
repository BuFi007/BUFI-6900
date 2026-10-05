# One weighted multisig, two chains: Circle MSCA on EVM, Squads on Solana

**Status:** v1 built and proven on Solana devnet (2026-10-04). Code: `packages/weighted-treasury` (Apache-2.0).
Audience: Squads, Altitude, Circle, and any team running a treasury on both EVM and Solana.

## The problem

A team that holds money on EVM and Solana runs two different treasuries with two different rule sets.
On EVM, Circle's modular smart accounts give it a **weighted** multisig (the CFO's key counts double)
and an **address book** (money only goes to approved recipients). On Solana, Squads gives it a multisig
and spending limits, but with **no weights**, and its recipient list is only enforced on the
spending-limit path. Squads can display a Safe today, but view-only.

Nothing lets a team write its rules once and have both chains enforce the same thing.

## What we built

One spec, written once:

```ts
{
  owners: [{ id: 'cfo', weight: 2, evm: '0x…', solana: '…' }, { id: 'ops1', weight: 1, … }, { id: 'ops2', weight: 1, … }],
  thresholdWeight: 3,
  allowlist: [{ label: 'payroll', evm: '0x…', solana: '…' }],
  assets: [{ symbol: 'USDC', solanaMint: 'EPjF…', solanaDecimals: 6 }],
  adminTimelockSeconds: 86400,
}
```

Two compilers, same meaning:

| | EVM (`compileEvm`) | Solana (`compileSquads`) |
| --- | --- | --- |
| Account | Circle MSCA (ERC-6900) | Squads Smart Account Program |
| Who can spend | WeightedWebauthnMultisigPlugin: weights + threshold | One SpendingLimit **policy per minimal winning group** of owners; any one group can approve |
| Where money can go | ColdStorageAddressBookPlugin | Each policy's `destinations` = the allowlist |
| Who can change the rules | the weighted quorum | **all owners**, after the timelock (stricter; see v2) |
| Signers | EOAs, passkeys, contract owners | any ed25519 key, including Circle user-controlled Solana wallets |

**Why groups give exact weights.** "The approvers' weights reach the threshold" is a monotone rule, so
it is the same as "the approvers include at least one minimal winning group". Each Squads policy is an
all-of-k group, and a team can use whichever policy its approvers form. With CFO=2, ops1=1, ops2=1 and
a threshold of 3, the groups are {CFO, ops1} and {CFO, ops2}; {ops1, ops2} has weight 2 and gets no
policy. No rounding, no approximation. A test checks every owner subset of 200 random configurations
plus fixed edge cases (3,240 assertions): the EVM rule and the Squads policies accept exactly the same
sets.

**Reject, never weaken.** Each compiler refuses a spec it cannot express exactly rather than emitting
something looser:
- An empty allowlist means "nobody" in the spec. On Squads, empty `destinations` means "anybody", so it
  is refused before it can reach the chain.
- A per-period budget has no enforcement point on Circle's weighted multisig, so `compileEvm` refuses it.
- If skewed weights would need more policies than the cap (default 64), compilation fails instead of
  dropping groups.

## Proof on Solana devnet

`bun run squads:sdk && bun run devnet:proof` against the live program
`SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`. Owners A=2, B=1, C=1, threshold 3, one allowlisted
wallet R, one stranger S. Run of 2026-10-04, settings account `C5QBLUm2XzJx9pzhmttoiJtqnz1VFQxJgQZJBx6m4oeS`:

| Step | Result |
| --- | --- |
| Rule change approved by A+B (weight 3, enough on EVM) | rejected, `InvalidProposalStatus`: Squads admin needs all owners |
| All 3 approve, execute immediately | rejected, `TimeLockNotReleased` |
| All 3 approve, after the timelock | policies {A,B} and {A,C} created |
| {A,B} pays R 100 | ✓ one co-signed transaction |
| {A,C} pays R 50 | ✓ |
| {A,B} pays S | rejected, `InvalidDestination` |
| {B,C} tries (weight 2) | rejected, `NotASigner` |
| A alone (weight 2) | rejected, `InvalidSignerCount` |
| Final balances | R = 150, S = 0 |

Owners were fresh ed25519 keypairs. On-chain they are indistinguishable from Circle user-controlled
Solana wallets, which is the signer we use in production.

## Where it deliberately differs, and v2

1. **Rule changes need all owners on Squads; on EVM the weighted quorum is enough.** Squads'
   `SettingsChange` policy can add or remove signers and change the threshold or timelock, but it
   cannot create or edit policies. So changing the allowlist goes through the main signer set, which
   has no weights. v1 sets that to all owners plus a timelock: stricter than EVM, never looser.
   **v2:** a small weighted-approver program set as the account's `settings_authority`, verifying
   weighted approvals before Squads applies the change. That is the Solana equivalent of an ERC-6900
   plugin, and it is the piece we would build with Squads.
2. **The admin quorum can run any vault transaction on Squads.** The EVM quorum can do the same by
   uninstalling the AddressBook, so the trust model matches. Day-to-day spending only goes through the
   policies, which only move tokens to allowlisted wallets.
3. **Policy count.** Uniform weights need C(n, k) groups; skewed weights can need more. Up to about 7
   owners stays small. Policies are per asset, so the count is groups × assets.

## Facts a reviewer should check (all verified 2026-10-04)

- The Smart Account Program is **upgradeable** on mainnet by a 3-of-5 Squads multisig with no upgrade
  timelock. Squads V4 (`SQDS4…`) is immutable but has no policies, and its recipient list does not bind
  ordinary quorum transactions. That is why v1 targets the Smart Account Program.
- Account creation is open and free on both clusters (`ProgramConfig` fee 0). Mainnet has ~666k
  accounts.
- `@sqds/smart-account` is not on npm. The proof builds it from source at commit `80bf1f7`. Its
  `package.json` says MIT, but the repo's only LICENSE file is AGPL-3.0, so nothing from it is vendored
  here. The core package depends on nothing: it emits Squads' own payload shapes as plain data, and
  `toSdkPolicyCreateActions` converts them for whichever SDK build the caller uses.
- Cross-chain: the bridge is never in the approval path. Each chain enforces the same spec with its own
  local quorum, and only value moves between chains (CCTP or Gateway). A budget set on both chains
  authorises up to 2× globally unless it is split. See `docs/SOLANA-MULTISIG-PLAN.md` §6.

## What we are asking for

- **Squads:** review the policy layout; a stable published `@sqds/smart-account`; an upgrade timelock
  on the Smart Account Program; co-design of the v2 weighted-approver program (or native weights).
- **Altitude:** use the spec as the shared source of truth for treasuries that span both chains.
- **Circle:** allowlist the plugins this repo proposes, so the EVM side can carry the same policies
  (session keys for agent spend, automated Earn) that Squads policies already express on Solana.
