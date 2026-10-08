// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {TreasuryConduit} from "../../src/bufi/conduit/TreasuryConduit.sol";
import {TreasuryEarnVault} from "../../src/bufi/conduit/TreasuryEarnVault.sol";
import {TreasuryRedeemConduit} from "../../src/bufi/conduit/TreasuryRedeemConduit.sol";
import {TreasurySwapAndDeposit} from "../../src/bufi/conduit/TreasurySwapAndDeposit.sol";
import {BufiEarnModule} from "../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {BufiDeployConfig} from "./BufiDeployConfig.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice CREATE2 init code (creation code ++ constructor args) for every plan-398 contract, and the address
/// each lands at. Every owner arg is `BOOTSTRAP_OWNER`, which is what keeps the addresses chain-independent.
library BufiInitCodes {
    function conduit() internal pure returns (bytes memory) {
        return abi.encodePacked(type(TreasuryConduit).creationCode, abi.encode(BufiDeployConfig.BOOTSTRAP_OWNER));
    }

    function redeemConduit() internal pure returns (bytes memory) {
        return abi.encodePacked(type(TreasuryRedeemConduit).creationCode, abi.encode(BufiDeployConfig.BOOTSTRAP_OWNER));
    }

    function canaryVault(address usdc) internal pure returns (bytes memory) {
        return abi.encodePacked(type(TreasuryEarnVault).creationCode, abi.encode(IERC20(usdc)));
    }

    function swapAndDeposit(address usdc) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                type(TreasurySwapAndDeposit).creationCode, abi.encode(BufiDeployConfig.BOOTSTRAP_OWNER, usdc)
            );
    }

    function earnModule(address relayer) internal pure returns (bytes memory) {
        return
            abi.encodePacked(type(BufiEarnModule).creationCode, abi.encode(relayer, BufiDeployConfig.BOOTSTRAP_OWNER));
    }

    function create2Address(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), BufiDeployConfig.CREATE2_DEPLOYER, salt, keccak256(initCode))
                    )
                )
            )
        );
    }

    function conduitAddress() internal pure returns (address) {
        return create2Address(BufiDeployConfig.CONDUIT_SALT, conduit());
    }

    function redeemConduitAddress() internal pure returns (address) {
        return create2Address(BufiDeployConfig.REDEEM_CONDUIT_SALT, redeemConduit());
    }

    function canaryVaultAddress(address usdc) internal pure returns (address) {
        return create2Address(BufiDeployConfig.EARN_CANARY_VAULT_SALT, canaryVault(usdc));
    }

    function swapAndDepositAddress(address usdc) internal pure returns (address) {
        return create2Address(BufiDeployConfig.SWAP_DEPOSIT_SALT, swapAndDeposit(usdc));
    }
}
