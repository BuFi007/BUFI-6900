// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

/// @title BufiDeployConfig
/// @notice The ONE place a deploy script learns who owns what on which chain (plan 398 §2).
///
/// Ownership standard every script in this repo follows:
///   1. CREATE2 init code carries `BOOTSTRAP_OWNER` (the same deployer EOA on every chain), so a contract with
///      the same bytecode lands at the same address everywhere.
///   2. The script registers the chain's targets while the bootstrap key still owns the contract, then calls
///      `transferOwnership(safe)` and asserts `pendingOwner() == safe`.
///   3. The chain's Safe sends `acceptOwnership()`; the script prints that calldata. Until it does, the
///      deployment is NOT done.
///
/// A chain id that is not in `get` is refused. There is no environment-variable owner and no default to the
/// deployer: adding a chain is an edit to this file, reviewed like code.
library BufiDeployConfig {
    /// Arachnid deterministic-deployment proxy (same address on every EVM chain that has it).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// The shared deployer EOA. Only ever a TRANSIENT owner: it signs the CREATE2 call, registers targets and
    /// proposes the Safe. It must hold no role once the Safe accepts.
    address internal constant BOOTSTRAP_OWNER = 0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474;

    // ── CREATE2 salts. Explicit, never env-overridable. They match the labels of the live deployments, so a
    //    contract whose bytecode did NOT change resolves to its live address and the script is a no-op for it;
    //    a contract whose bytecode changed (every plan-398 freeze contract) lands at a NEW address that is still
    //    identical across chains. Bumping a label is a founder call, recorded in AUDIT-SCOPE.md.
    //
    //    v3 (founder, 2026-10-08): the whole conduit family moves to a fresh `.v3` label together, so no frozen
    //    contract can collide with — or be mistaken for — a pre-freeze deployment under an older label.
    bytes32 internal constant CONDUIT_SALT = keccak256("bufi.treasury-conduit.v3");
    bytes32 internal constant REDEEM_CONDUIT_SALT = keccak256("bufi.treasury-redeem-conduit.v3");
    bytes32 internal constant SWAP_DEPOSIT_SALT = keccak256("bufi.treasury-swap-deposit.v3");
    /// Testnet canary (out of audit scope, bytecode unchanged): keeps its live label.
    bytes32 internal constant EARN_CANARY_VAULT_SALT = keccak256("bufi.treasury-earn-vault.v1");
    /// The two stateless ERC-6900 plugins (BufiSessionKeyPlugin, BufiSessionRecipientHookPlugin; out of scope,
    /// bytecode unchanged) keep their live label.
    bytes32 internal constant PLUGIN_SALT = keccak256("bufi-6900-plugins-v0.2.0");
    /// BufiEarnModule gets its OWN explicit label (founder, 2026-10-08) instead of sharing PLUGIN_SALT, so the
    /// frozen module moves to v3 without dragging the two unchanged plugins to new addresses.
    bytes32 internal constant EARN_MODULE_SALT = keccak256("bufi.earn-module.v3");

    struct Chain {
        string name;
        /// Final owner of every privileged BUFI contract on this chain.
        address safe;
        /// Circle USDC (FiatToken v2.2, ERC-3009). Immutable in TreasurySwapAndDeposit.
        address usdc;
        /// Circle App Kit adapter — a swap venue for TreasurySwapAndDeposit and a conduit target. 0 = none.
        address appKit;
        /// LI.FI diamond — a swap venue / conduit target. 0 = not registered on this chain.
        address lifi;
        /// Production ERC-4626 Earn vaults (conduit targets, redeem-conduit vaults, swap-and-deposit dests).
        address[] earnVaults;
        /// Testnet only: also deploy the 1:1 `TreasuryEarnVault` canary and register it everywhere.
        bool canaryVault;
    }

    error UnsupportedChain(uint256 chainId);

    function get(uint256 chainId) internal pure returns (Chain memory c) {
        if (chainId == 5042) {
            // Arc mainnet. Vaults: Morpho Vault V2 (Bitwise PAPY, Steakhouse Prime) — desk
            // packages/env/src/conduit.ts.
            c.name = "Arc";
            c.safe = 0x47Dc7D18A6E3a79F696714E7D47456a49B430D09;
            c.usdc = 0x3600000000000000000000000000000000000000;
            // Swap venues, verified 2026-10-08 (AUDIT-SCOPE.md "Arc mainnet venues"):
            //  - App Kit: none. Same-chain Arc mainnet swaps route Uniswap Trading API first, LI.FI second
            //    (desk @bu/swap); `0x7FB8…a845` is Circle's Earn+Borrow adapter, NOT a swap venue.
            //  - LI.FI: the LiFiDiamond. A live li.quest USDC -> EURC quote on 5042 targets it as both `to` and
            //    `approvalAddress`; eth_getCode = 254 B (EIP-2535 diamond proxy).
            //  - Uniswap: UNSET. The docs list Universal Router `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`
            //    (24546 B) and Universal Router 2.1.2 `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` (24380 B),
            //    but no keyed Trading API quote has confirmed which one it targets. Register it via a Safe
            //    `setTarget` / `setVenue` once a real quote names it; never by guess.
            c.appKit = address(0);
            c.lifi = 0xA4072583658Fae592A3506A42431cb6316a8d40b;
            c.earnVaults = new address[](2);
            c.earnVaults[0] = 0x7610094B846657dCF166D59e42973db52c7015F9;
            c.earnVaults[1] = 0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298;
            c.canaryVault = false;
        } else if (chainId == 43114) {
            // Avalanche C-Chain. No production venue or vault is registered yet (Aave is catalog-only).
            c.name = "Avalanche";
            c.safe = 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B;
            c.usdc = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
            c.appKit = address(0);
            c.lifi = address(0);
            c.earnVaults = new address[](0);
            c.canaryVault = false;
        } else if (chainId == 5042002) {
            // Arc testnet. The Avalanche Safe address also exists here (verified eth_getCode 2026-10-08).
            c.name = "Arc Testnet";
            c.safe = 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B;
            c.usdc = 0x3600000000000000000000000000000000000000;
            c.appKit = 0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b;
            c.lifi = 0xFf70F4A1d11995621854F3692acF286d8aCd04b2;
            c.earnVaults = new address[](0);
            c.canaryVault = true;
        } else {
            revert UnsupportedChain(chainId);
        }
    }
}
