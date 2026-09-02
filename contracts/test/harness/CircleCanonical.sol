// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/// @title CircleCanonical
/// @notice The production addresses, CREATE2 salts and constructor arguments Circle uses to deploy its
///         ERC-6900 v0.7 Modular Smart Contract Account stack on every supported chain. Sourced verbatim from
///         `lib/buidl-wallet-contracts/script/bytecode-deploy/{100_Constants.sol,101..105_*.s.sol}` and the
///         `standard-json-input/*_constructor_args` files. With the deterministic deployer at
///         `0x4e59b44847b379578588920cA78FbF26c0B4956C` and the creation bytecode Circle ships under
///         `script/bytecode-deploy/build-output/`, the sandbox recreates the stack at the SAME addresses on a
///         local chain, so every SDK constant (factory, plugin addresses, manifest hashes, replay-safe domain)
///         is valid without modification.
library CircleCanonical {
    /// ERC-4337 EntryPoint v0.7 (eth-infinitism `releases/v0.7`).
    address internal constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    /// Arachnid deterministic deployment proxy (pre-installed by anvil).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Runtime bytecode of the deterministic deployment proxy, for VMs that do not pre-install it.
    bytes internal constant CREATE2_DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    address internal constant PLUGIN_MANAGER = 0x00000005e69188224e4dEeF607801916DC0936d5;
    address internal constant UPGRADABLE_MSCA_FACTORY = 0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD;
    /// Deployed by the factory constructor (`new UpgradableMSCA(entryPoint, pluginManager)`), so it is a
    /// deterministic consequence of the factory address. The SDK pins it as `UPGRADABLE_MSCA.address`.
    address internal constant UPGRADABLE_MSCA_IMPL = 0xA70F1296869DA9D7CB69578123F21888E6dB2B62;
    address internal constant COLD_STORAGE_ADDRESS_BOOK_PLUGIN = 0x0000000d81083B16EA76dfab46B0315B0eDBF3d0;
    address internal constant WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN = 0x0000000C984AFf541D6cE86Bb697e68ec57873C8;

    /// `MSCA_FACTORY_OWNER_ADDRESS` — the factory owner baked into the production constructor args. It is
    /// part of the CREATE2 pre-image, so the sandbox must pass the same owner to land on the same address,
    /// then impersonate it (vm.prank / anvil_impersonateAccount) to allowlist plugins.
    address internal constant FACTORY_OWNER = 0x0166EA90E565476f13c6a0D25ED2C35599E58785;

    bytes32 internal constant PLUGIN_MANAGER_SALT = 0x20828f442f63e502375f253988ec6578620f09b1c00bbcc237edb6838323dba1;
    bytes32 internal constant UPGRADABLE_MSCA_FACTORY_SALT =
        0xda9f7ba8ec86b458ea272ecf44962d37f768e4d6f254dd2a82d5724b934b72d5;
    bytes32 internal constant COLD_STORAGE_ADDRESS_BOOK_PLUGIN_SALT =
        0x36fdaa1ba01cead4cf7fd9405035fc259bb463d9411d619a7deb31d13a2bd89f;
    bytes32 internal constant WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN_SALT =
        0x2cc3c603d96a0edab755ab092bf8e79f8d8934cc586d021ddd53be945606e535;

    /// Manifest hashes the SDK / desk-v1 pin. Re-asserted by `CanonicalStack.t.sol` against the redeploy.
    bytes32 internal constant WEIGHTED_WEBAUTHN_MULTISIG_MANIFEST_HASH =
        0xa043327d77a74c1c55cfa799284b831fe09535a88b9f5fa4173d334e5ba0fd91;
    bytes32 internal constant COLD_STORAGE_ADDRESS_BOOK_MANIFEST_HASH =
        0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8;

    /// Function ids on WeightedWebauthnMultisigPlugin used as dependency slots.
    uint8 internal constant WEIGHTED_USER_OP_VALIDATION_OWNER = 0;
    /// Deliberately unimplemented id: AddressBook's runtime-validation dependency points here so that
    /// `addAllowedRecipients` / `removeAllowedRecipients` can only be reached through a userOp (fail-closed).
    uint8 internal constant WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED = 1;

    string internal constant BUILD_OUTPUT_DIR = "/lib/buidl-wallet-contracts/script/bytecode-deploy/build-output/";
}
