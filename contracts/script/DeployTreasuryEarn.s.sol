// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/src/Script.sol";

import {TreasuryConduit} from "../src/bufi/conduit/TreasuryConduit.sol";
import {TreasuryEarnVault} from "../src/bufi/conduit/TreasuryEarnVault.sol";
import {TreasuryRedeemConduit} from "../src/bufi/conduit/TreasuryRedeemConduit.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Deploys the Arc-testnet Earn canary: 1:1 USDC vault + redeem conduit, then
/// registers the vault on both contracts.
///
///   DEPLOYER_PRIVATE_KEY
///   USDC                  defaults to Arc Testnet native-gas USDC
///   CONDUIT               defaults to TreasuryConduit v2
///   CONDUIT_OWNER         defaults to the deployer
///
///   forge script script/DeployTreasuryEarn.s.sol --rpc-url $RPC --broadcast
contract DeployTreasuryEarn is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant TREASURY_CONDUIT_V2 = 0xA9817049F0a48d4653719465A7829E85b3A415e7;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address owner = vm.envOr("CONDUIT_OWNER", deployer);
        address usdc = vm.envOr("USDC", ARC_TESTNET_USDC);
        address conduitAddr = vm.envOr("CONDUIT", TREASURY_CONDUIT_V2);

        bytes32 vaultSalt = keccak256("bufi.treasury-earn-vault.v1");
        bytes memory vaultInit = abi.encodePacked(type(TreasuryEarnVault).creationCode, abi.encode(usdc));
        address vaultPredicted = vm.computeCreate2Address(vaultSalt, keccak256(vaultInit), CREATE2_DEPLOYER);

        bytes32 redeemSalt = keccak256("bufi.treasury-redeem-conduit.v1");
        bytes memory redeemInit = abi.encodePacked(type(TreasuryRedeemConduit).creationCode, abi.encode(owner));
        address redeemPredicted = vm.computeCreate2Address(redeemSalt, keccak256(redeemInit), CREATE2_DEPLOYER);

        vm.startBroadcast(key);
        if (vaultPredicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(vaultSalt, vaultInit));
            require(ok && vaultPredicted.code.length > 0, "vault create2");
            console2.log("TreasuryEarnVault deployed", vaultPredicted);
        } else {
            console2.log("TreasuryEarnVault already at", vaultPredicted);
        }
        if (redeemPredicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(redeemSalt, redeemInit));
            require(ok && redeemPredicted.code.length > 0, "redeem create2");
            console2.log("TreasuryRedeemConduit deployed", redeemPredicted);
        } else {
            console2.log("TreasuryRedeemConduit already at", redeemPredicted);
        }

        TreasuryConduit conduit = TreasuryConduit(conduitAddr);
        if (!conduit.targets(vaultPredicted)) {
            conduit.setTarget(vaultPredicted, true);
            console2.log("conduit setTarget vault");
        }
        TreasuryRedeemConduit redeem = TreasuryRedeemConduit(redeemPredicted);
        if (!redeem.vaults(vaultPredicted)) {
            redeem.setVault(vaultPredicted, true);
            console2.log("redeem setVault");
        }
        vm.stopBroadcast();

        console2.log("owner", owner);
        console2.log("usdc ", usdc);
        console2.log("vault", vaultPredicted);
        console2.log("redeem", redeemPredicted);
        console2.log("asset", TreasuryEarnVault(vaultPredicted).asset());
        console2.log("previewDeposit(1e6)", TreasuryEarnVault(vaultPredicted).previewDeposit(1e6));
    }
}
