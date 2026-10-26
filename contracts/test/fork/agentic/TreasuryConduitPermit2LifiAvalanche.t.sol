// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduitPermit2} from "../../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {IPermit2SignatureTransfer} from "../../../src/bufi/conduit/interfaces/IPermit2SignatureTransfer.sol";
import {Permit2ConduitHarness, Permit2TestToken} from "../../bufi/v0.7/conduit/TreasuryConduitPermit2.t.sol";
import {IPermit2ProbeNonce} from "../../harness/Permit2RpcProbe.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Real LI.FI calldata and token/Permit2 runtimes on a pinned local Avalanche fork. No broadcast.
contract TreasuryConduitPermit2LifiAvalancheTest is Permit2ConduitHarness {
    address internal constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
    address internal constant EURC = 0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD;
    string internal captured;

    function _fixturePath() internal pure virtual returns (string memory) {
        return "test/fixtures/permit2-lifi-avalanche-swap.json";
    }

    function _documentCommitment() internal pure virtual returns (bytes32) {
        return bytes32(0);
    }

    function setUp() public override {
        captured = vm.readFile(_fixturePath());
        vm.createSelectFork(vm.envString("AVAX_PERMIT2_FORK_RPC"), vm.parseJsonUint(captured, ".blockNumber"));
        require(block.chainid == 43114, "wrong Avalanche fork");
        uint256 forkTimestamp = vm.getBlockTimestamp();
        super.setUp();
        vm.warp(forkTimestamp);
        address release = deployCode(
            "out-permit2-release/TreasuryConduitPermit2.sol/TreasuryConduitPermit2.json",
            abi.encode(SAFE, PERMIT2, address(addressBookPlugin))
        );
        vm.etch(address(conduit), release.code);
        assertEq(address(conduit).codehash, 0x55eb4131767006c7386b08a936071d951c1474c0016680959f8feba0a2b45b79);
        input = Permit2TestToken(USDC);
        output = Permit2TestToken(EURC);
        assertEq(block.chainid, 43114);
        assertEq(address(conduit), vm.parseJsonAddress(captured, ".executor"));
        assertEq(
            _documentCommitment() == bytes32(0) ? address(treasury) : RECIPIENT,
            vm.parseJsonAddress(captured, ".recipient")
        );
        assertEq(vm.getBlockTimestamp(), vm.parseJsonUint(captured, ".timestamp"));
    }

    function _installPermit2Runtime() internal override {
        // The shared fixture starts on Arc; keep Avalanche's real cached Permit2 domain and runtime.
        vm.chainId(43114);
        assertEq(PERMIT2.codehash, 0x081beff14e75c5a5c1e60740445f58d54ba0fef228148a11d3e4287dc3551cbb);
    }

    function _route() internal returns (TreasuryConduitPermit2.Permit2Intent memory intent) {
        intent = _intent();
        intent.target = vm.parseJsonAddress(captured, ".addresses.router");
        intent.allowanceTarget = vm.parseJsonAddress(captured, ".addresses.spender");
        intent.data = vm.parseJsonBytes(captured, ".prepared.tx.data");
        intent.tokenIn = USDC;
        intent.tokenOut = EURC;
        intent.recipient = vm.parseJsonAddress(captured, ".recipient");
        intent.documentCommitment = _documentCommitment();
        intent.amountIn = vm.parseJsonUint(captured, ".prepared.executionRequirements.input.amount");
        intent.minOut = vm.parseJsonUint(captured, ".quote._raw.step.estimate.toAmountMin");
        intent.deadline = vm.parseJsonUint(captured, ".quote.expiresAt") / 1000;
        assertEq(vm.parseJsonUint(captured, ".prepared.tx.value"), 0);
        assertEq(vm.parseJsonUint(captured, ".prepared.tx.chainId"), 43114);
        assertEq(USDC, vm.parseJsonAddress(captured, ".addresses.tokenIn"));
        assertEq(EURC, vm.parseJsonAddress(captured, ".addresses.tokenOut"));
        assertEq(intent.target.codehash, vm.parseJsonBytes32(captured, ".codeHashes.router"));
        assertEq(intent.allowanceTarget.codehash, vm.parseJsonBytes32(captured, ".codeHashes.spender"));
        assertEq(USDC.codehash, vm.parseJsonBytes32(captured, ".codeHashes.tokenIn"));
        assertEq(EURC.codehash, vm.parseJsonBytes32(captured, ".codeHashes.tokenOut"));
        vm.prank(SAFE);
        conduit.setPermit2Route(intent.target, intent.allowanceTarget, true);
        deal(USDC, address(treasury), intent.amountIn * 2);
        _approve(intent.amountIn);
    }

    function _approve(uint256 amount) internal {
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(IStandardExecutor.execute, (USDC, 0, abi.encodeCall(IERC20.approve, (PERMIT2, amount)))),
                quorum
            )
        );
    }

    function test_real_lifi_delivers_minimum_clears_allowance_and_refuses_replay() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 101);
        bytes memory signature = _sign(intent, permit, 2);
        uint256 inputBefore = IERC20(USDC).balanceOf(address(treasury));
        uint256 recipientBefore = IERC20(EURC).balanceOf(intent.recipient);
        uint256 conduitInputBefore = IERC20(USDC).balanceOf(address(conduit));
        uint256 conduitOutputBefore = IERC20(EURC).balanceOf(address(conduit));
        conduit.executePermit2(permit, address(treasury), signature, intent);
        uint256 received = IERC20(EURC).balanceOf(intent.recipient) - recipientBefore;
        assertGe(received, intent.minOut);
        assertGt(received, 0);
        assertEq(IERC20(USDC).balanceOf(address(treasury)), inputBefore - intent.amountIn);
        assertEq(IERC20(USDC).balanceOf(address(conduit)), conduitInputBefore);
        assertEq(IERC20(EURC).balanceOf(address(conduit)), conduitOutputBefore);
        assertEq(IERC20(USDC).allowance(address(conduit), intent.allowanceTarget), 0);
        assertTrue(conduit.executed(address(treasury), intent.operationId));
        uint256 nonceWord = IPermit2ProbeNonce(PERMIT2).nonceBitmap(address(treasury), 0);
        assertEq(nonceWord & (1 << permit.nonce), 1 << permit.nonce);
        vm.expectRevert(TreasuryConduitPermit2.OperationAlreadyExecuted.selector);
        conduit.executePermit2(permit, address(treasury), signature, intent);
        assertEq(IERC20(EURC).balanceOf(intent.recipient), recipientBefore + received);
        assertEq(IPermit2ProbeNonce(PERMIT2).nonceBitmap(address(treasury), 0), nonceWord);
        emit log_named_uint("actual EURC received (atomic)", received);
    }

    function test_real_lifi_refuses_incomplete_quorum_without_consuming_nonce() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 102);
        bytes memory signature = _sign(intent, permit, 1);
        uint256 nonceBefore = IPermit2ProbeNonce(PERMIT2).nonceBitmap(address(treasury), 0);
        uint256 recipientBefore = IERC20(EURC).balanceOf(intent.recipient);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), signature, intent);
        assertEq(IERC20(USDC).balanceOf(address(treasury)), intent.amountIn * 2);
        assertEq(IERC20(EURC).balanceOf(intent.recipient), recipientBefore);
        assertEq(IPermit2ProbeNonce(PERMIT2).nonceBitmap(address(treasury), 0), nonceBefore);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_real_lifi_below_floor_rolls_back_funds_nonce_allowance_and_operation() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        intent.minOut = type(uint256).max;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 103);
        bytes memory signature = _sign(intent, permit, 2);
        uint256 nonceBefore = IPermit2ProbeNonce(PERMIT2).nonceBitmap(address(treasury), 0);
        uint256 recipientBefore = IERC20(EURC).balanceOf(intent.recipient);
        uint256 routerInputBefore = IERC20(USDC).balanceOf(intent.allowanceTarget);
        vm.expectPartialRevert(bytes4(keccak256("BelowFloor(uint256,uint256)")));
        conduit.executePermit2(permit, address(treasury), signature, intent);
        assertEq(IERC20(USDC).balanceOf(address(treasury)), intent.amountIn * 2);
        assertEq(IERC20(EURC).balanceOf(intent.recipient), recipientBefore);
        assertEq(IERC20(USDC).balanceOf(intent.allowanceTarget), routerInputBefore);
        assertEq(IERC20(USDC).balanceOf(address(conduit)), 0);
        assertEq(IERC20(EURC).balanceOf(address(conduit)), 0);
        assertEq(IERC20(USDC).allowance(address(treasury), PERMIT2), intent.amountIn);
        assertEq(IERC20(USDC).allowance(address(conduit), intent.allowanceTarget), 0);
        assertEq(IPermit2ProbeNonce(PERMIT2).nonceBitmap(address(treasury), 0), nonceBefore);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }
}

contract TreasuryConduitPermit2LifiInvoiceAvalancheTest is TreasuryConduitPermit2LifiAvalancheTest {
    function _fixturePath() internal pure override returns (string memory) {
        return "test/fixtures/permit2-lifi-avalanche-document.json";
    }

    function _documentCommitment() internal pure virtual override returns (bytes32) {
        return keccak256("local-invoice-frozen-terms");
    }
}

contract TreasuryConduitPermit2LifiReimbursementAvalancheTest is TreasuryConduitPermit2LifiInvoiceAvalancheTest {
    function _documentCommitment() internal pure override returns (bytes32) {
        return keccak256("local-reimbursement-approved-item-versions");
    }
}
