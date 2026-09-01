# @bufi/playground

The end-to-end proof that the pieces compose: `bun run sandbox:e2e` (from the repo root) boots the sandbox if it
is not running (`@bufi/mock-circle dev` = anvil + Circle stack at canonical addresses + BUFI plugins + Modular
Wallets API mock on `:8788`), then drives it exclusively through `@bufi/modular-wallets-core`:

1. owner EOA → `toCircleSmartAccount` (address resolved through `circle_getAddress` on the mock) → first userOp
   deploys the weighted-multisig MSCA and transfers USDC;
2. owner installs `ColdStorageAddressBookPlugin` (production dependency slots) — a transfer to a stranger is
   now rejected at validation;
3. owner installs `BufiSessionKeyPlugin` seeded with an agent grant `{scope: USDC.transfer, budget: 500 USDC /
   24h + gas, expiry: 7 days}` via `buildAgentFaceCalls`;
4. the agent (`toBufiSessionKeyAccount`) spends within budget, is rejected over budget, is rejected on an
   unlisted target / selector — and the script prints the composition finding that the address book does NOT
   gate `executeWithSessionKey`;
5. owner revokes the key; the agent is rejected;
6. if the earn module is deployed: module owner registers a vault config, the multisig adopts it at install,
   the relayer sweeps USDC into the vault, shares land on the account.

Every step asserts on-chain state through the SDK's read actions (`getInstalledPlugins`, `getAllowedRecipients`,
`getSessionKeys`, …). Exit code 0 = all green. Env: `MOCK_CIRCLE_URL`, `ANVIL_RPC_URL`, `DEPLOYMENTS_PATH`.
