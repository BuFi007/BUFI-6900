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
    bytes32 internal constant CONDUIT_SALT = keccak256("bufi.treasury-conduit.v2");
    bytes32 internal constant REDEEM_CONDUIT_SALT = keccak256("bufi.treasury-redeem-conduit.v1");
    bytes32 internal constant SWAP_DEPOSIT_SALT = keccak256("bufi.treasury-swap-deposit.v1");
    bytes32 internal constant EARN_CANARY_VAULT_SALT = keccak256("bufi.treasury-earn-vault.v1");
    bytes32 internal constant PLUGIN_SALT = keccak256("bufi-6900-plugins-v0.2.0");

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
            c.appKit = 0x7FB8c7260b63934d8da38aF902f87ae6e284a845;
            c.lifi = address(0);
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
