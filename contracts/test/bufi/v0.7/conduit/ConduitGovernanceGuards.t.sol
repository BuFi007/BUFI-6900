// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduit} from "../../../../src/bufi/conduit/TreasuryConduit.sol";
import {TreasuryRedeemConduit} from "../../../../src/bufi/conduit/TreasuryRedeemConduit.sol";
import {TreasurySwapAndDeposit} from "../../../../src/bufi/conduit/TreasurySwapAndDeposit.sol";
import {MockFiatToken3009} from "../../../mocks/MockFiatToken3009.sol";

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Test} from "forge-std/src/Test.sol";

/// @notice Plan 398 freeze: governance-surface guards on the three conduit
/// contracts — zero-address refusals, the rescue event, and the two-step
/// handover the deploy scripts rely on (bootstrap deployer -> chain Safe).
contract ConduitGovernanceGuardsTest is Test {
    address internal constant BOOTSTRAP = address(0xB00);
    address internal constant SAFE = address(0x5AFE);
    address internal constant STRANGER = address(0xBAD);

    TreasuryConduit internal conduit;
    TreasuryRedeemConduit internal redeem;
    TreasurySwapAndDeposit internal adapter;
    MockFiatToken3009 internal usdc;

    event Rescued(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        usdc = new MockFiatToken3009("USDC", "USDC");
        conduit = new TreasuryConduit(BOOTSTRAP);
        redeem = new TreasuryRedeemConduit(BOOTSTRAP);
        adapter = new TreasurySwapAndDeposit(BOOTSTRAP, address(usdc));
    }

    // ── zero-address guards
    // ─────────────────────────────────────────────────

    function test_conduit_setTarget_refuses_zero() public {
        vm.prank(BOOTSTRAP);
        vm.expectRevert(TreasuryConduit.ZeroAddress.selector);
        conduit.setTarget(address(0), true);
    }

    function test_conduit_rescue_refuses_zero_token_and_zero_recipient() public {
        usdc.mint(address(conduit), 1e6);
        vm.startPrank(BOOTSTRAP);
        vm.expectRevert(TreasuryConduit.ZeroAddress.selector);
        conduit.rescue(address(0), SAFE);
        vm.expectRevert(TreasuryConduit.ZeroAddress.selector);
        conduit.rescue(address(usdc), address(0));
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(conduit)), 1e6, "nothing moved");
    }

    function test_conduit_rescue_emits_Rescued() public {
        usdc.mint(address(conduit), 3e6);
        vm.expectEmit(true, true, false, true, address(conduit));
        emit Rescued(address(usdc), SAFE, 3e6);
        vm.prank(BOOTSTRAP);
        conduit.rescue(address(usdc), SAFE);
        assertEq(usdc.balanceOf(SAFE), 3e6);
    }

    function test_redeem_setVault_refuses_zero() public {
        vm.prank(BOOTSTRAP);
        vm.expectRevert(TreasuryRedeemConduit.ZeroAddress.selector);
        redeem.setVault(address(0), true);
    }

    function test_constructors_refuse_zero_owner() public {
        bytes memory err = abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0));
        vm.expectRevert(err);
        new TreasuryConduit(address(0));
        vm.expectRevert(err);
        new TreasuryRedeemConduit(address(0));
        vm.expectRevert(err);
        new TreasurySwapAndDeposit(address(0), address(usdc));
    }

    // ── two-step handover, exactly as the deploy scripts perform it ──────────

    function test_handover_bootstrap_to_safe_is_two_step_on_every_contract() public {
        _assertTwoStep(Ownable2Step(address(conduit)));
        _assertTwoStep(Ownable2Step(address(redeem)));
        _assertTwoStep(Ownable2Step(address(adapter)));
    }

    function test_after_handover_the_bootstrap_key_has_no_power() public {
        vm.prank(BOOTSTRAP);
        conduit.transferOwnership(SAFE);
        vm.prank(SAFE);
        conduit.acceptOwnership();

        vm.prank(BOOTSTRAP);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BOOTSTRAP));
        conduit.setTarget(address(0x1234), true);

        vm.prank(SAFE);
        conduit.setTarget(address(0x1234), true);
        assertTrue(conduit.targets(address(0x1234)));
    }

    function _assertTwoStep(Ownable2Step c) internal {
        vm.prank(BOOTSTRAP);
        c.transferOwnership(SAFE);
        assertEq(c.owner(), BOOTSTRAP, "owner unchanged until accepted");
        assertEq(c.pendingOwner(), SAFE, "safe pending");

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", STRANGER));
        c.acceptOwnership();

        vm.prank(SAFE);
        c.acceptOwnership();
        assertEq(c.owner(), SAFE);
        assertEq(c.pendingOwner(), address(0));
    }
}
