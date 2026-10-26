// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Permit2ConduitHarness, Permit2TestToken} from "../../bufi/v0.7/conduit/TreasuryConduitPermit2.t.sol";
import {TreasuryConduitPermit2} from "../../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {IPermit2SignatureTransfer} from "../../../src/bufi/conduit/interfaces/IPermit2SignatureTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";

contract Permit2ArcTokenRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient) external {
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn));
        require(IERC20(tokenOut).transfer(recipient, amountOut));
    }
}

/// @notice Actual Arc token implementations on a pinned local fork. The exchange is a test router;
/// token funding is local deal() storage, and nothing is broadcast to the upstream RPC.
contract TreasuryConduitPermit2ArcTest is Permit2ConduitHarness {
    address internal constant WARS = 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D;
    address internal constant WBRL = 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0;
    uint256 internal constant PINNED_BLOCK = 27_977_495;
    Permit2ArcTokenRouter internal tokenRouter;

    function setUp() public override {
        vm.createSelectFork(vm.envString("ARC_PERMIT2_FORK_RPC"), PINNED_BLOCK);
        require(block.chainid == 5042, "wrong fork");
        require(WARS.code.length > 0 && WBRL.code.length > 0, "missing tokens");
        bytes32 proxyHash = 0xf8d9ff5ea93bc29b43da9f8727fdeb3c9adac7ec55da259371f7af7182faf6a2;
        assertEq(WARS.codehash, proxyHash);
        assertEq(WBRL.codehash, proxyHash);
        assertEq(
            address(0xBa0030Bba7112171A8A5bCc417ee1994051321b9).codehash,
            0xa921467240d95219a560bae76922283f1cf9d28f2bc0867caec8fa78e8290532
        );
        assertEq(
            address(0xfbaB5DcB1647787Ec8402A6509add256Fa6c7f9D).codehash,
            0x1cc2956795483c706cb46a343f67de09854000c74ce61af25267ca59f317a70b
        );
        super.setUp();
        input = Permit2TestToken(WARS);
        output = Permit2TestToken(WBRL);
        tokenRouter = new Permit2ArcTokenRouter();
        vm.prank(SAFE);
        conduit.setPermit2Route(address(tokenRouter), address(tokenRouter), true);
        deal(WARS, address(treasury), 100e18);
        deal(WBRL, address(tokenRouter), 20e18);
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(IStandardExecutor.execute, (WARS, 0, abi.encodeCall(IERC20.approve, (PERMIT2, AMOUNT)))),
                quorum
            )
        );
    }

    function _installPermit2Runtime() internal view override {
        // The mainnet runtime differs from the fixture only in the two immutable
        // cached chain/domain words. Keep the actual deployed code in this fork.
        assertEq(PERMIT2.codehash, 0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f);
    }

    function test_real_wars_to_wbrl_permit2_quorum_transfers_exact_units() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.target = address(tokenRouter);
        intent.allowanceTarget = address(tokenRouter);
        intent.data = abi.encodeCall(Permit2ArcTokenRouter.swap, (WARS, WBRL, AMOUNT, 13e18, address(treasury)));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 24);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        assertEq(IERC20(WARS).balanceOf(address(treasury)), 83e18);
        assertEq(IERC20(WBRL).balanceOf(address(treasury)), 13e18);
        assertEq(IERC20(WARS).allowance(address(conduit), address(tokenRouter)), 0);
        assertTrue(conduit.executed(address(treasury), intent.operationId));
    }

    function test_real_wbrl_to_wars_permit2_uses_frozen_document_recipient() public {
        input = Permit2TestToken(WBRL);
        output = Permit2TestToken(WARS);
        deal(WBRL, address(treasury), 100e18);
        deal(WARS, address(tokenRouter), 20e18);
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(IStandardExecutor.execute, (WBRL, 0, abi.encodeCall(IERC20.approve, (PERMIT2, AMOUNT)))),
                quorum
            )
        );
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.target = address(tokenRouter);
        intent.allowanceTarget = address(tokenRouter);
        intent.documentCommitment = keccak256("approved-reimbursement-item-versions");
        intent.recipient = RECIPIENT;
        intent.data = abi.encodeCall(Permit2ArcTokenRouter.swap, (WBRL, WARS, AMOUNT, 13e18, RECIPIENT));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 25);
        uint256 receivedBefore = IERC20(WARS).balanceOf(RECIPIENT);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        assertEq(IERC20(WBRL).balanceOf(address(treasury)), 83e18);
        assertEq(IERC20(WARS).balanceOf(RECIPIENT) - receivedBefore, 13e18);
        assertEq(IERC20(WBRL).allowance(address(conduit), address(tokenRouter)), 0);
    }
}
