// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduitPermit2} from "../../../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {IPermit2SignatureTransfer} from "../../../../src/bufi/conduit/interfaces/IPermit2SignatureTransfer.sol";
import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {
    ColdStorageAddressBookPlugin
} from "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/ColdStorageAddressBookPlugin.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract Permit2TestToken is ERC20 {
    bool public shortTransfer;
    bool public ignoreApproval;
    bool public ignoreReset;

    constructor(string memory name_) ERC20(name_, name_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setShortTransfer(bool value) external {
        shortTransfer = value;
    }

    function setApprovalBehavior(bool ignoreApproval_, bool ignoreReset_) external {
        ignoreApproval = ignoreApproval_;
        ignoreReset = ignoreReset_;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if ((value == 0 && ignoreReset) || (value != 0 && ignoreApproval)) return true;
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (shortTransfer && from != address(0) && to != address(0)) {
            super._update(from, address(0), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

contract Permit2TestRouter {
    function reenter(address conduit, bytes calldata data) external {
        (bool ok, bytes memory reason) = conduit.call(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(reason, 0x20), mload(reason)) }
        }
    }

    function swap(address tokenIn, address tokenOut, uint256 spent, uint256 delivered, address recipient) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), spent);
        Permit2TestToken(tokenOut).mint(recipient, delivered);
    }

    function swapWithTaxedRefund(address tokenIn, address tokenOut, uint256 spent, uint256 delivered, address recipient)
        external
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), spent);
        Permit2TestToken(tokenOut).mint(recipient, delivered);
        Permit2TestToken(tokenIn).setShortTransfer(true);
    }

    function swapWithTaxedOutput(address tokenIn, address tokenOut, uint256 spent, uint256 delivered, address recipient)
        external
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), spent);
        Permit2TestToken(tokenOut).mint(recipient, delivered);
        Permit2TestToken(tokenOut).setShortTransfer(true);
    }
}

/// @notice Canonical Permit2 bytecode + Circle's real weighted account and AddressBook.
abstract contract Permit2ConduitHarness is CircleStackHarness {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SAFE = address(0x0B5);
    address internal constant RECIPIENT = address(0xFEE);
    uint256 internal constant AMOUNT = 17e18;
    bytes32 internal constant PERMIT_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,ConduitWitness witness)ConduitWitness(bytes32 operationId,bytes32 intentHash)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 internal constant TOKEN_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    TreasuryConduitPermit2 internal conduit;
    UpgradableMSCA internal treasury;
    Signer[] internal quorum;
    Permit2TestToken internal input;
    Permit2TestToken internal output;
    Permit2TestRouter internal router;

    function setUp() public virtual {
        vm.chainId(5042);
        vm.warp(1_800_000_000);
        _installPermit2Runtime();
        _deployCircleCanonicalStack();
        _setUpTreasury();
    }

    function _installPermit2Runtime() internal virtual {
        vm.etch(PERMIT2, vm.parseBytes(vm.trim(vm.readFile("test/fixtures/permit2.arc-testnet.runtime.hex"))));
        assertEq(PERMIT2.codehash, 0x53681d3cf8f702f849c1504b491049c3d0a282e4595d9b297c410dcf36f0908e);
    }

    function _setUpTreasury() private {
        quorum = _makeSigners("permit2-treasury", 2);
        uint256[] memory weights = new uint256[](2);
        weights[0] = 60;
        weights[1] = 40;
        treasury = _createWeightedMsca(quorum, weights, 100, bytes32(uint256(2)));
        address[] memory recipients = new address[](2);
        recipients[0] = PERMIT2;
        recipients[1] = RECIPIENT;
        assertTrue(_installAddressBook(treasury, recipients, quorum));
        input = new Permit2TestToken("WARS");
        output = new Permit2TestToken("WBRL");
        router = new Permit2TestRouter();
        conduit = new TreasuryConduitPermit2(SAFE, PERMIT2, address(addressBookPlugin));
        vm.prank(SAFE);
        conduit.setPermit2Route(address(router), address(router), true);
        input.mint(address(treasury), 100e18);
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(
                    IStandardExecutor.execute, (address(input), 0, abi.encodeCall(IERC20.approve, (PERMIT2, AMOUNT)))
                ),
                quorum
            )
        );
    }

    function _intent() internal view returns (TreasuryConduitPermit2.Permit2Intent memory intent) {
        intent.operationId = keccak256("operation-1");
        intent.target = address(router);
        intent.allowanceTarget = address(router);
        intent.data =
            abi.encodeCall(Permit2TestRouter.swap, (address(input), address(output), AMOUNT, 13e18, address(treasury)));
        intent.tokenIn = address(input);
        intent.amountIn = AMOUNT;
        intent.tokenOut = address(output);
        intent.minOut = 13e18;
        intent.recipient = address(treasury);
        intent.deadline = block.timestamp + 1 hours;
        intent.memoId = keccak256("memo-1");
        intent.memo = "invoice=1";
    }

    function _permit(TreasuryConduitPermit2.Permit2Intent memory intent, uint256 nonce)
        internal
        pure
        returns (IPermit2SignatureTransfer.PermitTransferFrom memory)
    {
        return IPermit2SignatureTransfer.PermitTransferFrom({
            permitted: IPermit2SignatureTransfer.TokenPermissions(intent.tokenIn, intent.amountIn),
            nonce: nonce,
            deadline: intent.deadline
        });
    }

    function _sign(
        TreasuryConduitPermit2.Permit2Intent memory intent,
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        uint256 count
    ) internal view returns (bytes memory sig) {
        bytes32 witness = keccak256(
            abi.encode(
                keccak256("ConduitWitness(bytes32 operationId,bytes32 intentHash)"),
                intent.operationId,
                conduit.permit2IntentHash(address(treasury), intent)
            )
        );
        bytes32 hash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                keccak256(abi.encode(TOKEN_TYPEHASH, permit.permitted.token, permit.permitted.amount)),
                address(conduit),
                permit.nonce,
                permit.deadline,
                witness
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(IPermit2SignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), hash);
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(treasury), digest);
        for (uint256 i; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(quorum[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }
}

contract TreasuryConduitPermit2Test is Permit2ConduitHarness {
    function test_shared_typescript_golden_intent_hash() public {
        address vectorConduit = 0x2222222222222222222222222222222222222222;
        address vectorTreasury = 0x1111111111111111111111111111111111111111;
        vm.etch(vectorConduit, address(conduit).code);
        TreasuryConduitPermit2.Permit2Intent memory intent = TreasuryConduitPermit2.Permit2Intent({
            operationId: 0x0101010101010101010101010101010101010101010101010101010101010101,
            documentCommitment: bytes32(0),
            target: 0x3333333333333333333333333333333333333333,
            allowanceTarget: 0x4444444444444444444444444444444444444444,
            data: hex"12345678",
            tokenIn: 0x5555555555555555555555555555555555555555,
            amountIn: 1000,
            tokenOut: 0x6666666666666666666666666666666666666666,
            minOut: 900,
            recipient: vectorTreasury,
            deadline: 2_000_000_000,
            memoId: 0x0202020202020202020202020202020202020202020202020202020202020202,
            memo: hex"0102"
        });
        assertEq(
            TreasuryConduitPermit2(vectorConduit).permit2IntentHash(vectorTreasury, intent),
            0x9e9b4518f42685bb81f7ad5897648146d87e50585a331ea692ac18e7acbae26b
        );
    }

    function test_weighted_quorum_funds_route_and_returns_output() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        assertEq(input.balanceOf(address(treasury)), 83e18);
        assertEq(output.balanceOf(address(treasury)), 13e18);
        assertEq(input.allowance(address(conduit), address(router)), 0);
        assertTrue(conduit.executed(address(treasury), intent.operationId));
    }

    function test_ignored_approval_cannot_call_the_route() public {
        input.setApprovalBehavior(true, false);
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.data =
            abi.encodeCall(Permit2TestRouter.swap, (address(input), address(output), 0, 13e18, address(treasury)));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("AllowanceMismatch(address,address,uint256,uint256)")),
                address(input),
                address(router),
                AMOUNT,
                0
            )
        );
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertEq(output.balanceOf(address(treasury)), 0);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_ignored_reset_reverts_and_retains_no_spender_authority() public {
        input.setApprovalBehavior(false, true);
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.data =
            abi.encodeCall(Permit2TestRouter.swap, (address(input), address(output), 10e18, 13e18, address(treasury)));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("AllowanceMismatch(address,address,uint256,uint256)")),
                address(input),
                address(router),
                0,
                7e18
            )
        );
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.allowance(address(conduit), address(router)), 0);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_taxed_refund_reverts_without_spending_nonce_or_operation() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.data = abi.encodeCall(
            Permit2TestRouter.swapWithTaxedRefund, (address(input), address(output), 10e18, 13e18, address(treasury))
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(TreasuryConduitPermit2.InexactInput.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_taxed_forwarded_output_is_not_an_exact_transfer() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.data = abi.encodeCall(
            Permit2TestRouter.swapWithTaxedOutput, (address(input), address(output), AMOUNT, 13e18, address(conduit))
        );
        // A low floor must not admit a token that taxes the conduit's outgoing transfer.
        intent.minOut = 1;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(TreasuryConduitPermit2.InexactOutput.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
    }

    function test_underweight_signature_cannot_authorize() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 1);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_same_operation_cannot_reexecute_even_with_new_nonce_and_signature() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        permit.nonce = 2;
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(TreasuryConduitPermit2.OperationAlreadyExecuted.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(output.balanceOf(address(treasury)), 13e18);
    }

    function test_permit2_nonce_cannot_reexecute_different_operation() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        intent.operationId = keccak256("another-operation");
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_partial_fill_refunds_only_operation_delta_and_keeps_donations() public {
        input.mint(address(conduit), 123);
        output.mint(address(conduit), 456);
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.data =
            abi.encodeCall(Permit2TestRouter.swap, (address(input), address(output), 10e18, 13e18, address(conduit)));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        assertEq(input.balanceOf(address(treasury)), 90e18);
        assertEq(output.balanceOf(address(treasury)), 13e18);
        assertEq(input.balanceOf(address(conduit)), 123);
        assertEq(output.balanceOf(address(conduit)), 456);
        assertEq(input.allowance(address(conduit), address(router)), 0);
    }

    function test_document_delivers_only_to_address_book_recipient() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.documentCommitment = keccak256("invoice:version:1");
        intent.recipient = RECIPIENT;
        intent.data =
            abi.encodeCall(Permit2TestRouter.swap, (address(input), address(output), AMOUNT, 13e18, address(conduit)));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        assertEq(output.balanceOf(RECIPIENT), 13e18);
        assertEq(output.balanceOf(address(treasury)), 0);
    }

    function test_revoked_address_book_recipient_cannot_execute_old_signature() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.documentCommitment = keccak256("invoice:version:1");
        intent.recipient = RECIPIENT;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        address[] memory removed = new address[](1);
        removed[0] = RECIPIENT;
        assertTrue(
            _executeUserOp(
                treasury, abi.encodeCall(ColdStorageAddressBookPlugin.removeAllowedRecipients, (removed)), quorum
            )
        );
        vm.expectRevert(TreasuryConduitPermit2.RecipientNotInAddressBook.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
    }

    function test_swap_cannot_deliver_to_third_party_even_when_address_book_allows_it() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.recipient = RECIPIENT;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
    }

    function test_floor_failure_rolls_back_pull_allowance_nonce_and_execution() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.minOut = 14e18;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertEq(input.allowance(address(conduit), address(router)), 0);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
        intent.minOut = 13e18;
        conduit.executePermit2(permit, address(treasury), _sign(intent, permit, 2), intent);
        assertEq(output.balanceOf(address(treasury)), 13e18);
    }

    function testFuzz_changed_committed_terms_invalidate_signature(uint8 field) public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        uint8 selected = field % 8;
        if (selected == 0) {
            intent.operationId = keccak256("other-operation");
        } else if (selected == 1) {
            intent.minOut--;
        } else if (selected == 2) {
            intent.memoId = keccak256("other-memo");
        } else if (selected == 3) {
            intent.memo = "modified memo";
        } else if (selected == 4) {
            intent.data = abi.encodeCall(
                Permit2TestRouter.swap, (address(input), address(output), AMOUNT, 14e18, address(treasury))
            );
        } else if (selected == 5) {
            intent.deadline--;
            permit.deadline--;
        } else if (selected == 6) {
            permit.nonce++;
        } else {
            vm.chainId(5043);
        }
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
    }

    function test_insufficient_allowance_cannot_pull_treasury_funds() public {
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(
                    IStandardExecutor.execute,
                    (address(input), 0, abi.encodeCall(IERC20.approve, (PERMIT2, AMOUNT - 1)))
                ),
                quorum
            )
        );
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_short_received_input_reverts() public {
        input.setShortTransfer(true);
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(TreasuryConduitPermit2.InexactInput.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
    }

    function test_only_safe_can_register_and_the_spender_pair_must_match() public {
        vm.expectRevert();
        conduit.setPermit2Route(address(router), address(input), true);
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.allowanceTarget = address(input);
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(TreasuryConduitPermit2.Permit2RouteNotRegistered.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
    }

    function test_router_cannot_reenter_permit2_execution() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory inner =
            abi.encodeCall(TreasuryConduitPermit2.executePermit2, (permit, address(treasury), bytes(""), intent));
        intent.data = abi.encodeCall(Permit2TestRouter.reenter, (address(conduit), inner));
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("TargetCallFailed(bytes)")),
                abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()")))
            )
        );
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_signature_is_bound_to_this_conduit() public {
        TreasuryConduitPermit2 other = new TreasuryConduitPermit2(SAFE, PERMIT2, address(addressBookPlugin));
        vm.prank(SAFE);
        other.setPermit2Route(address(router), address(router), true);
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        other.executePermit2(permit, address(treasury), sig, intent);
    }

    function test_changed_document_commitment_invalidates_approved_signature() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        intent.documentCommitment = keccak256("invoice-version-1");
        intent.recipient = RECIPIENT;
        intent.data =
            abi.encodeCall(Permit2TestRouter.swap, (address(input), address(output), AMOUNT, 13e18, RECIPIENT));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        intent.documentCommitment = keccak256("invoice-version-2");
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertEq(output.balanceOf(RECIPIENT), 0);
    }

    function test_permit_cannot_grant_more_amount_or_time_than_the_operation() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        permit.permitted.amount++;
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        permit.permitted.amount = intent.amountIn;
        permit.deadline++;
        sig = _sign(intent, permit, 2);
        vm.expectRevert(TreasuryConduitPermit2.Permit2DeadlineMismatch.selector);
        conduit.executePermit2(permit, address(treasury), sig, intent);
    }

    function test_expired_authorization_cannot_execute() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.warp(intent.deadline);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_nonzero_native_value_is_rejected_before_any_pull() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _intent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 1);
        bytes memory sig = _sign(intent, permit, 2);
        vm.deal(address(this), 1);
        (bool ok,) = address(conduit).call{value: 1}(
            abi.encodeCall(TreasuryConduitPermit2.executePermit2, (permit, address(treasury), sig, intent))
        );
        assertFalse(ok);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }
}
