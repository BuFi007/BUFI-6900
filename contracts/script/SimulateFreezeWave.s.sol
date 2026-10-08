// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {DeployBufiPlugins} from "./DeployBufiPlugins.s.sol";
import {DeployTreasuryConduit} from "./DeployTreasuryConduit.s.sol";
import {DeployTreasuryEarn} from "./DeployTreasuryEarn.s.sol";
import {DeployTreasurySwapAndDeposit} from "./DeployTreasurySwapAndDeposit.s.sol";
import {IOwnable2Step} from "./config/BufiDeployBase.sol";
import {BufiDeployConfig} from "./config/BufiDeployConfig.sol";

import {Script, VmSafe, console2} from "forge-std/src/Script.sol";

/// @dev Placeholder relayer for the dry run only (the real one is a founder decision; see AUDIT-SCOPE.md).
contract SimulatedPlugins is DeployBufiPlugins {
    function _relayer() internal pure override returns (address) {
        return address(0x00000000000000000000000000000000005EED01);
    }
}

/// @notice DRY RUN ONLY. Rehearses the whole plan-398 wave on a fork in one process (so later scripts see the
/// contracts earlier ones created), then plays the Safe's `acceptOwnership` with a prank and checks that the
/// Safe ends up the owner of every privileged contract. Refuses to run under `--broadcast`.
///
///   forge script script/SimulateFreezeWave.s.sol --fork-url $RPC --sender 0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474
contract SimulateFreezeWave is Script {
    function run() external {
        require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "simulation only: never --broadcast this");
        require(!vm.isContext(VmSafe.ForgeContext.ScriptResume), "simulation only");
        address safe = BufiDeployConfig.get(block.chainid).safe;

        address conduit = new DeployTreasuryConduit().run();
        (address redeem,) = new DeployTreasuryEarn().run();
        address adapter = new DeployTreasurySwapAndDeposit().run();
        (, address earn,) = new SimulatedPlugins().run();

        address[4] memory all = [conduit, redeem, adapter, earn];
        string[4] memory names =
            ["TreasuryConduit", "TreasuryRedeemConduit", "TreasurySwapAndDeposit", "BufiEarnModule"];
        console2.log("==== after the scripts (before the Safe signs) ====");
        for (uint256 i = 0; i < 4; i++) {
            IOwnable2Step c = IOwnable2Step(all[i]);
            require(c.pendingOwner() == safe || c.owner() == safe, "Safe not proposed");
            console2.log(names[i], all[i]);
            console2.log("  owner       ", c.owner());
            console2.log("  pendingOwner", c.pendingOwner());
        }
        console2.log("==== the Safe accepts (pranked here; a real Safe tx on chain) ====");
        for (uint256 i = 0; i < 4; i++) {
            IOwnable2Step c = IOwnable2Step(all[i]);
            if (c.owner() != safe) {
                vm.prank(safe);
                c.acceptOwnership();
            }
            require(c.owner() == safe && c.pendingOwner() == address(0), "Safe is not the owner");
            console2.log(names[i], "owner == Safe", c.owner());
        }
    }
}
