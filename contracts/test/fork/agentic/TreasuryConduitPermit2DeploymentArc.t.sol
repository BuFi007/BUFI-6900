// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {DeployTreasuryConduitPermit2} from "../../../script/DeployTreasuryConduitPermit2.s.sol";
import {TreasuryConduitPermit2} from "../../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {Test} from "forge-std/src/Test.sol";

contract TreasuryConduitPermit2DeploymentArcTest is Test {
    DeployTreasuryConduitPermit2 internal deployment;

    function setUp() public {
        string memory captured = vm.readFile("test/fixtures/permit2-lifi-arc-swap.json");
        vm.createSelectFork(vm.envString("ARC_PERMIT2_FORK_RPC"), vm.parseJsonUint(captured, ".blockNumber"));
        deployment = new DeployTreasuryConduitPermit2();
    }

    function test_deployment_is_inert_owned_by_safe_and_reused() public {
        TreasuryConduitPermit2 conduit = deployment.run(deployment.ARC_SAFE());
        assertEq(conduit.owner(), deployment.ARC_SAFE());
        assertEq(address(conduit.permit2()), deployment.PERMIT2());
        assertEq(address(conduit.addressBook()), deployment.ADDRESS_BOOK());
        address router = 0xA4072583658Fae592A3506A42431cb6316a8d40b;
        assertFalse(conduit.permit2Routes(router, router));
        assertFalse(conduit.targets(router));
        assertEq(address(deployment.run(deployment.ARC_SAFE())), address(conduit));
    }

    function test_deployment_refuses_wrong_chain() public {
        address owner = deployment.ARC_SAFE();
        vm.chainId(5042002);
        vm.expectRevert("Arc mainnet only");
        deployment.run(owner);
    }

    function test_deployment_refuses_wrong_owner() public {
        vm.expectRevert("owner must be the Arc Safe");
        deployment.run(address(0xBAD));
    }

    function test_deployment_refuses_changed_permit2_code() public {
        address owner = deployment.ARC_SAFE();
        vm.etch(deployment.PERMIT2(), hex"00");
        vm.expectRevert("Permit2 code changed");
        deployment.run(owner);
    }
}
