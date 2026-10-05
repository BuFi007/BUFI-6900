// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * Live setup on Arc testnet for the two Gateway proofs that so far ran in forge only:
 *
 *   (1) NESTED OWNER: a real Circle v0.7 MSCA (M1, 2-of-3 EOA owners) is an owner of a GatewayTreasury (v3):
 *       owners [A weight 2, M1 weight 1], threshold 3.
 *   (2) GUARD: a real Circle v0.7 MSCA (M2, owners A=2, B=1, C=1, threshold 3) with GatewayIntentGuardPlugin
 *       installed by a multisig-signed user operation that this script submits to the EntryPoint itself.
 *
 * Both MSCAs come from Circle's production factory on Arc testnet (createAccount is permissionless; the weighted
 * multisig plugin is on its allowlist). The guard is not on the factory allowlist, so it is installed after
 * creation, exactly as a wallet would. Writes deployments/arc-testnet.gateway-live.json.
 *
 *   DEPLOYER_PK, OWNER_A_PK, OWNER_B_PK, OWNER_C_PK, N1_PK, N2_PK, N3_PK, R_ADDR
 *   forge script script/gateway-guard/LiveGatewaySetup.s.sol --rpc-url https://rpc.testnet.arc.network --broadcast
 */
import {Script, console} from "forge-std/src/Script.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {PublicKey} from "@circle/common/CommonStructs.sol";
import {EMPTY_HASH, ZERO_BYTES32} from "@circle/common/Constants.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {UpgradableMSCAFactory} from "@circle/msca/6900/v0.7/factories/UpgradableMSCAFactory.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {GatewayIntentGuardPlugin} from "../../src/bufi/gateway-guard/GatewayIntentGuardPlugin.sol";
import {GatewayGuardInit} from "../../src/bufi/gateway-guard/IGatewayIntentGuard.sol";
import {
    GatewayTreasury, PolicyParams, SignerParams
} from "../../src/bufi/gateway-treasury/GatewayTreasury.sol";

contract LiveGatewaySetup is Script {
    using MessageHashUtils for bytes32;

    IEntryPoint constant ENTRY_POINT = IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032);
    UpgradableMSCAFactory constant FACTORY = UpgradableMSCAFactory(0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD);
    address constant WEIGHTED = 0x0000000C984AFf541D6cE86Bb697e68ec57873C8;
    bytes32 constant WEIGHTED_MANIFEST = 0xa043327d77a74c1c55cfa799284b831fe09535a88b9f5fa4173d334e5ba0fd91;
    address constant GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 constant BASE_USDC = bytes32(uint256(uint160(0x036CbD53842c5426634e7929541eC2318f3dCF7e)));
    bytes32 constant MINTER = bytes32(uint256(uint160(0x0022222ABE238Cc2C7Bb1f21003F0a260052475B)));
    uint8 constant WEIGHTED_USER_OP_VALIDATION_OWNER = 0;
    uint8 constant WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED = 1;

    struct Key {
        address addr;
        uint256 pk;
    }

    function _key(string memory env) internal view returns (Key memory k) {
        k.pk = vm.envUint(env);
        k.addr = vm.addr(k.pk);
    }

    function _sort(Key[] memory ks) internal pure {
        for (uint256 i = 1; i < ks.length; i++) {
            Key memory x = ks[i];
            uint256 j = i;
            while (j > 0 && uint160(ks[j - 1].addr) > uint160(x.addr)) {
                ks[j] = ks[j - 1];
                j--;
            }
            ks[j] = x;
        }
    }

    function _createMsca(Key[] memory ks, uint256[] memory weights, uint256 threshold, bytes32 salt)
        internal
        returns (address)
    {
        address[] memory owners = new address[](ks.length);
        for (uint256 i = 0; i < ks.length; i++) owners[i] = ks[i].addr;
        address[] memory plugins = new address[](1);
        bytes32[] memory manifests = new bytes32[](1);
        bytes[] memory data = new bytes[](1);
        plugins[0] = WEIGHTED;
        manifests[0] = WEIGHTED_MANIFEST;
        data[0] = abi.encode(owners, weights, new PublicKey[](0), new uint256[](0), threshold);
        return address(
            FACTORY.createAccount(
                bytes32(uint256(uint160(owners[0]))), salt, abi.encode(plugins, manifests, data)
            )
        );
    }

    /// @dev Circle weighted-multisig userOp signature: signers ascending; the first signs the actual digest (v+32),
    ///      the rest the minimal digest (BaseMultisigPlugin semantics).
    function _signOp(PackedUserOperation memory op, Key[] memory signers) internal view returns (bytes memory sig) {
        bytes32 actual = ENTRY_POINT.getUserOpHash(op).toEthSignedMessageHash();
        bytes32 minimal = keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        op.sender,
                        op.nonce,
                        keccak256(op.initCode),
                        keccak256(op.callData),
                        ZERO_BYTES32,
                        uint256(0),
                        ZERO_BYTES32,
                        EMPTY_HASH
                    )
                ),
                address(ENTRY_POINT),
                block.chainid
            )
        ).toEthSignedMessageHash();
        for (uint256 i = 0; i < signers.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i].pk, i == 0 ? actual : minimal);
            if (i == 0) v += 32;
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        bytes32 r = bytes32(uint256(uint160(vm.envAddress("R_ADDR"))));
        Key memory a = _key("OWNER_A_PK");
        Key memory b = _key("OWNER_B_PK");
        Key memory c = _key("OWNER_C_PK");

        vm.startBroadcast(deployerPk);

        // ── (1) nested owner: M1 = 2-of-3 Circle MSCA, owner of GatewayTreasury v3 ─────────────────────────
        Key[] memory n = new Key[](3);
        n[0] = _key("N1_PK");
        n[1] = _key("N2_PK");
        n[2] = _key("N3_PK");
        _sort(n);
        uint256[] memory w1 = new uint256[](3);
        w1[0] = 1;
        w1[1] = 1;
        w1[2] = 1;
        address m1 = _createMsca(n, w1, 2, keccak256("bufi-gateway-nested-owner-v1"));

        GatewayTreasury t3;
        {
            address[] memory owners = new address[](2);
            uint16[] memory weights = new uint16[](2);
            owners[0] = a.addr;
            owners[1] = m1;
            weights[0] = 2;
            weights[1] = 1;
            PolicyParams memory p;
            p.allowedRecipients = new bytes32[](1);
            p.allowedRecipients[0] = r;
            p.allowedDestinationDomains = new uint32[](1);
            p.allowedDestinationDomains[0] = 6;
            p.tokenAddresses = new address[](1);
            p.tokenAddresses[0] = ARC_USDC;
            p.tokenNames = new string[](1);
            p.tokenNames[0] = "USDC";
            p.tokenVersions = new string[](1);
            p.tokenVersions[0] = "2";
            p.allowedDestinationTokens = new bytes32[](1);
            p.allowedDestinationTokens[0] = BASE_USDC;
            p.perIntentCap = 2_000_000;
            p.maxFeeCap = 2_010_000;
            p.adminTimelock = 600;
            p.maxExpiryBlocks = 1_250_000;
            p.localDomain = 26;
            p.destinationMinters = new bytes32[](1);
            p.destinationMinters[0] = MINTER;
            t3 = new GatewayTreasury(
                SignerParams({owners: owners, weights: weights, thresholdWeight: 3, gatewayWallet: GATEWAY_WALLET}), p
            );
        }

        // ── (2) guard: M2 = Circle MSCA A=2,B=1,C=1 thr 3, then installPlugin(guard) via a self-bundled userOp ──
        Key[] memory abc = new Key[](3);
        abc[0] = a;
        abc[1] = b;
        abc[2] = c;
        _sort(abc);
        uint256[] memory w2 = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) w2[i] = abc[i].addr == a.addr ? 2 : 1;
        address m2 = _createMsca(abc, w2, 3, keccak256("bufi-gateway-guard-v1"));
        GatewayIntentGuardPlugin guard = new GatewayIntentGuardPlugin();

        // Prefund: on Arc the gas token is USDC; the account pays for its own userOp.
        (bool funded,) = m2.call{value: 0.5 ether}("");
        require(funded, "prefund failed");

        _installGuard(m2, guard, abc, r, deployer);

        vm.stopBroadcast();

        console.log("M1 (nested owner MSCA)", m1);
        console.log("GatewayTreasury v3", address(t3));
        console.log("M2 (guarded MSCA)", m2);
        console.log("GatewayIntentGuardPlugin", address(guard));

        string memory j = "live";
        vm.serializeAddress(j, "nestedOwnerMsca", m1);
        vm.serializeAddress(j, "treasuryV3", address(t3));
        vm.serializeAddress(j, "guardedMsca", m2);
        string memory out = vm.serializeAddress(j, "guardPlugin", address(guard));
        vm.writeJson(out, "./deployments/arc-testnet.gateway-live.json");
    }

    function _installGuard(address m2, GatewayIntentGuardPlugin guard, Key[] memory abc, bytes32 r, address deployer)
        internal
    {
        GatewayGuardInit memory init;
        init.gatewayWallet = GATEWAY_WALLET;
        init.perIntentCap = 2_000_000;
        init.maxFeeCap = 2_010_000;
        init.maxExpiryBlocks = 1_250_000;
        init.recipients = new bytes32[](1);
        init.recipients[0] = r;
        init.destinationDomains = new uint32[](1);
        init.destinationDomains[0] = 6;
        init.tokens = new address[](1);
        init.tokens[0] = ARC_USDC;
        init.tokenNames = new string[](1);
        init.tokenNames[0] = "USDC";
        init.tokenVersions = new string[](1);
        init.tokenVersions[0] = "2";
        init.destinationTokens = new bytes32[](1);
        init.destinationTokens[0] = BASE_USDC;
        init.sourceDomain = 26;
        init.destinationMinters = new bytes32[](1);
        init.destinationMinters[0] = MINTER;

        FunctionReference[] memory deps = new FunctionReference[](2);
        deps[0] = FunctionReference(WEIGHTED, WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED);
        deps[1] = FunctionReference(WEIGHTED, WEIGHTED_USER_OP_VALIDATION_OWNER);
        bytes memory callData = abi.encodeCall(
            IPluginManager.installPlugin,
            (address(guard), keccak256(abi.encode(guard.pluginManifest())), abi.encode(init), deps)
        );

        PackedUserOperation memory op;
        op.sender = m2;
        op.nonce = ENTRY_POINT.getNonce(m2, 0);
        op.callData = callData;
        op.accountGasLimits = bytes32(abi.encodePacked(uint128(3_000_000), uint128(3_000_000)));
        op.preVerificationGas = 100_000;
        uint128 fee = uint128(tx.gasprice > 0 ? tx.gasprice * 2 : 50 gwei);
        op.gasFees = bytes32(abi.encodePacked(fee, fee));
        op.signature = _signOp(op, abc); // all three owners: weight 4 >= 3
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ENTRY_POINT.handleOps{gas: 8_000_000}(ops, payable(deployer));

    }

    /// Re-run only the guard install (M2 and the guard already deployed).
    function installOnly() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        Key[] memory abc = new Key[](3);
        abc[0] = _key("OWNER_A_PK");
        abc[1] = _key("OWNER_B_PK");
        abc[2] = _key("OWNER_C_PK");
        _sort(abc);
        vm.startBroadcast(deployerPk);
        _installGuard(
            vm.envAddress("M2"),
            GatewayIntentGuardPlugin(vm.envAddress("GUARD")),
            abc,
            bytes32(uint256(uint160(vm.envAddress("R_ADDR")))),
            vm.addr(deployerPk)
        );
        vm.stopBroadcast();
    }
}
